import { compactLimit, compactionCut, DEFAULT_OUTPUT_TOKENS, estimateTokens, flattenForSummary, KEEP_TOKENS_AFTER_COMPACT, keepTokensFor, looksLikeOverflow, SUMMARY_PREFIX, trimForRequest } from './context';
import { EconomyRouting } from './economy';
import { decide, PermissionMode, rememberKey, ToolKind } from './permissions';
import { byteSize, COMPACT_REQUEST_BYTES } from './requestSize';
import { findTool, isReadOnlyTool, Tool, TOOLS, ToolContext } from './tools';
import { ChatMessage, ChatStreamer, ToolCall, Usage } from './types';

export type PermissionAnswer = 'allow' | 'always' | 'deny';

export interface PermissionRequest {
	callId: string;
	tool: string;
	kind: ToolKind;
	summary: string;
	args: Record<string, unknown>;
	preview?: { path: string; before: string; after: string };
}

export type AgentEvent =
	| { type: 'routedModel'; model: string }
	| { type: 'text'; text: string }
	| { type: 'reasoning'; text: string }
	| { type: 'toolStart'; callId: string; tool: string; summary: string; args: Record<string, unknown> }
	| { type: 'toolEnd'; callId: string; ok: boolean; output: string }
	| { type: 'usage'; usage: Usage }
	/** Usage from a request that ran on the economy model, so savings can be tallied separately. */
	| { type: 'economyUsage'; usage: Usage }
	| { type: 'notice'; message: string }
	| { type: 'compacted'; removed: ChatMessage[] };

export interface AgentOptions {
	client: ChatStreamer;
	model: string;
	systemPrompt: string;
	/** Conversation without the system prompt. Updated in place. */
	messages: ChatMessage[];
	root: string;
	commandTimeoutSeconds: number;
	maxTurns: number;
	contextWindow?: number;
	maxTokens?: number;
	/** The most output the model allows, used when a retry needs more room. */
	modelMaxOutput?: number;
	reasoningEffort?: string;
	supportsTools?: boolean;
	getMode(): PermissionMode;
	requestPermission(request: PermissionRequest): Promise<PermissionAnswer>;
	onEvent(event: AgentEvent): void;
	/** Called after approval, immediately before running a tool (for snapshots). */
	beforeToolRun?(tool: string, args: Record<string, unknown>): Promise<void>;
	/** Private per-project memory notes. */
	memoryFile?: string;
	/** Answers remembered with "always". Pass the same set across a conversation. */
	remembered?: Set<string>;
	/** Upper bound for how deep sub-agents may spawn their own sub-agents (0 disables spawning). */
	spawnDepth?: number;
	/** Set when a cheap model should handle summaries and read-only sub-agents. */
	economy?: EconomyRouting;
	/** Restricts this run to tools that cannot change anything. Used for economy sub-agents. */
	readOnlyTools?: boolean;
	signal?: AbortSignal;
}

/** Tool the model can call to hand a focused subtask to a fresh sub-agent. */
const SPAWN_TOOL = 'spawn_agent';
const SPAWN_SCHEMA = {
	type: 'function',
	function: {
		name: SPAWN_TOOL,
		description: 'Spawn a sub-agent to handle a focused, self-contained subtask with its own fresh context. Use it for parallelizable or exploratory work (research a question, find usages, draft an isolated change) so the main conversation stays focused. The sub-agent can use tools and returns a concise result. Give it complete instructions; it does not see this conversation.',
		parameters: {
			type: 'object',
			properties: {
				task: { type: 'string', description: 'Complete, self-contained instructions for the sub-agent.' },
				name: { type: 'string', description: 'A short label for the subtask, e.g. "find usages".' },
			},
			required: ['task'],
		},
	},
} as const;

const COMPACT_PROMPT = 'Summarize this conversation so work can continue from the summary alone. Include the user\'s goals and exact requests, decisions made, files changed, errors and how they were solved, the current state, and the next step. Output only the summary.';
const MIN_TURNS_BETWEEN_COMPACTIONS = 3;
/** Some models occasionally spend a whole turn on hidden thinking and return nothing. */
const MAX_EMPTY_RETRIES = 2;
const CONTINUE_PROMPT = 'Continue with the task. Use a tool or give your response now.';

/**
 * Models that need an explicit cache breakpoint on the latest message for the
 * conversation so far to be billed at the much lower cache-read rate. OpenAI and
 * DeepSeek cache automatically and ignore the marker, so they are left out.
 */
const CONVERSATION_CACHE_MODELS = /claude|gemini/i;

export function toolSchemas(spawnDepth = 0, readOnly = false) {
	const tools = readOnly ? TOOLS.filter(t => isReadOnlyTool(t.schema.function.name)) : TOOLS;
	// A read-only sub-agent cannot delegate further, or the restriction would be easy to escape.
	return spawnDepth > 0 && !readOnly ? [...tools.map(t => t.schema), SPAWN_SCHEMA] : tools.map(t => t.schema);
}

/**
 * Replaces older messages with a model-written summary and keeps recent work
 * intact. Returns the messages it removed, or an empty list if nothing was old enough.
 */
export async function compact(
	options: Pick<AgentOptions, 'client' | 'model' | 'messages' | 'signal' | 'maxTokens' | 'economy'> & Partial<Pick<AgentOptions, 'onEvent'>>,
	keepTokens = KEEP_TOKENS_AFTER_COMPACT,
): Promise<ChatMessage[]> {
	const { messages } = options;
	const cut = compactionCut(messages, keepTokens);
	if (cut === 0) { return []; }
	let summary = '';
	// Summarizing sends the whole conversation, which makes it the most expensive
	// request in a long chat, and it is plain summarizing work a cheap model can do.
	const economy = options.economy;
	const model = economy?.model ?? options.model;
	const maxTokens = economy ? economy.maxTokens : options.maxTokens;
	const request: ChatMessage[] = [{ role: 'user', content: `${COMPACT_PROMPT}\n\n<conversation>\n${flattenForSummary(messages.slice(0, cut))}\n</conversation>` }];
	for await (const event of options.client.streamChat({ model, messages: request, maxTokens }, options.signal)) {
		if (event.type === 'text') { summary += event.text; }
		else if (event.type === 'usage' && economy) { options.onEvent?.({ type: 'economyUsage', usage: event.usage }); }
	}
	if (!summary.trim()) { throw new Error('The model returned an empty summary.'); }
	return messages.splice(0, cut, { role: 'user', content: `${SUMMARY_PREFIX}\n\n${summary}` });
}

/** Marks stable text for the prompt cache, which greatly reduces the cost of repeated context. */
export function withCacheMarkers(system: string, messages: ChatMessage[], model: string): ChatMessage[] {
	const marker = { type: 'ephemeral' as const };
	const out: ChatMessage[] = [{ role: 'system', content: [{ type: 'text', text: system, cache_control: marker }] }, ...messages];
	const last = out.at(-1);
	if (CONVERSATION_CACHE_MODELS.test(model) && out.length > 1 && last && typeof last.content === 'string' && last.content) {
		out[out.length - 1] = { ...last, content: [{ type: 'text', text: last.content, cache_control: marker }] };
	}
	return out;
}

/** Runs model turns and tools until the model finishes, is stopped, or reaches the turn limit. */
export async function runAgent(options: AgentOptions): Promise<void> {
	const { client, messages, signal, onEvent } = options;
	const remembered = options.remembered ?? new Set<string>();
	/**
	 * Plan mode denies every edit and command, so sending those schemas pays for tools
	 * that can only be refused, and invites the model to try them. The mode can change
	 * between turns, so this is resolved per turn rather than once.
	 */
	const toolsFor = (mode: PermissionMode) => options.supportsTools === false
		? undefined
		: toolSchemas(options.spawnDepth ?? 0, options.readOnlyTools === true || mode === 'plan');
	let contextWindow = options.contextWindow;
	let calibration = 1;
	let lastCompaction = -MIN_TURNS_BETWEEN_COMPACTIONS;
	let recovered = false;
	let emptyReplies = 0;
	let maxTokens = options.maxTokens;

	const summarize = async (turn: number, message: string, keepTokens = keepTokensFor(contextWindow)): Promise<boolean> => {
		onEvent({ type: 'notice', message });
		const removed = await compact(options, keepTokens);
		if (removed.length === 0) { return false; }
		lastCompaction = turn;
		onEvent({ type: 'compacted', removed });
		return true;
	};

	for (let turn = 0; turn < options.maxTurns; turn++) {
		const tools = toolsFor(options.getMode());
		const overhead = Math.ceil((options.systemPrompt.length + JSON.stringify(tools ?? []).length) / 4);
		let outgoing = trimForRequest(messages, contextWindow, calibration);
		let estimate = estimateTokens(outgoing) + overhead;
		if (contextWindow && estimate * calibration > compactLimit(contextWindow)
			&& turn - lastCompaction >= MIN_TURNS_BETWEEN_COMPACTIONS && compactionCut(messages, keepTokensFor(contextWindow)) > 0) {
			await summarize(turn, 'Context is nearly full, summarizing older messages.');
			outgoing = trimForRequest(messages, contextWindow, calibration);
			estimate = estimateTokens(outgoing) + overhead;
		}
		// Models with huge context windows reach the gateway's size limit long before their token limit.
		if (byteSize(outgoing) > COMPACT_REQUEST_BYTES && turn - lastCompaction >= MIN_TURNS_BETWEEN_COMPACTIONS && compactionCut(messages, KEEP_TOKENS_AFTER_COMPACT) > 0) {
			lastCompaction = turn;
			try {
				await summarize(turn, 'This chat is nearing the gateway size limit, summarizing older messages.', KEEP_TOKENS_AFTER_COMPACT);
			} catch (error) {
				if (signal?.aborted) { return; }
				// The request can still go out, because the client leaves old content out to fit.
				onEvent({ type: 'notice', message: `Could not summarize older messages, so some are left out of this request. ${(error as Error).message}` });
			}
			outgoing = trimForRequest(messages, contextWindow, calibration);
			estimate = estimateTokens(outgoing) + overhead;
		}

		let text = '';
		const calls: ToolCall[] = [];
		let finish = '';

		try {
			const stream = client.streamChat({
				model: options.model,
				// A second empty reply gets an explicit nudge, which is not saved to the chat.
				messages: withCacheMarkers(options.systemPrompt, emptyReplies >= MAX_EMPTY_RETRIES ? [...outgoing, { role: 'user', content: CONTINUE_PROMPT }] : outgoing, options.model),
				tools,
				maxTokens,
				reasoningEffort: options.reasoningEffort,
			}, signal);
			for await (const event of stream) {
				if (signal?.aborted) { break; }
				if (event.type === 'text') { text += event.text; onEvent(event); }
				else if (event.type === 'reasoning' || event.type === 'routedModel') { onEvent(event); }
				else if (event.type === 'tool_call') { calls.push(event.call); }
				else if (event.type === 'usage') {
					if (event.usage.promptTokens > 0) { calibration = Math.min(Math.max(event.usage.promptTokens / estimate, 0.5), 4); }
					onEvent({ type: 'usage', usage: event.usage });
				}
				else if (event.type === 'failover') {
					contextWindow = event.contextWindow;
					onEvent({ type: 'routedModel', model: event.model });
					onEvent({ type: 'notice', message: `Automatic routing was rejected, so this request continues on ${event.name}.` });
				}
				else { finish = event.reason; }
			}
		} catch (error) {
			if (text) { messages.push({ role: 'assistant', content: text }); }
			if (signal?.aborted) { return; }
			if (!text && !recovered && looksLikeOverflow(error, estimate * calibration, contextWindow)) {
				recovered = true;
				if (await summarize(turn, 'The request was too large, summarizing older messages and retrying.')) {
					turn--;
					continue;
				}
			}
			throw error;
		}

		if (signal?.aborted) {
			if (text) { messages.push({ role: 'assistant', content: text }); }
			return;
		}
		if (!text && calls.length === 0) {
			if (emptyReplies < MAX_EMPTY_RETRIES) {
				emptyReplies++;
				if (finish === 'length') {
					// An empty-but-truncated reply often means the gateway's small default output
					// limit cut off a thinking model before it wrote any text, including on "auto".
					const grown = maxTokens ? maxTokens * 2 : DEFAULT_OUTPUT_TOKENS;
					maxTokens = options.modelMaxOutput ? Math.min(grown, options.modelMaxOutput) : grown;
				}
				if (emptyReplies === 1) { onEvent({ type: 'notice', message: 'The model returned nothing, trying again.' }); }
				turn--;
				continue;
			}
			onEvent({ type: 'notice', message: `The model returned an empty response ${emptyReplies + 1} times (finish reason: ${finish || 'none'}). Send "continue" or try another model.` });
			return;
		}
		emptyReplies = 0;
		messages.push(calls.length ? { role: 'assistant', content: text || null, tool_calls: calls } : { role: 'assistant', content: text });

		if (calls.length === 0) {
			if (finish === 'length') { onEvent({ type: 'notice', message: 'The response stopped at the output token limit.' }); }
			return;
		}

		for (const call of calls) {
			const output = signal?.aborted ? 'Stopped by the user.' : await executeCall(call, options, remembered);
			messages.push({ role: 'tool', tool_call_id: call.id, content: output });
		}
		if (signal?.aborted) { return; }
	}
	onEvent({ type: 'notice', message: `Stopped after ${options.maxTurns} turns. Send "continue" to keep going.` });
}

async function executeCall(call: ToolCall, options: AgentOptions, remembered: Set<string>): Promise<string> {
	const { onEvent } = options;
	const name = call.function.name;
	let args: Record<string, unknown>;
	try {
		args = call.function.arguments.trim() ? JSON.parse(call.function.arguments) as Record<string, unknown> : {};
	} catch {
		return report(onEvent, call.id, name, {}, name, false, `The arguments for ${name} were not valid JSON. The output may have been cut off. Try again with a smaller change.`);
	}
	if (name === SPAWN_TOOL) {
		return runSubagent(call.id, args, options);
	}
	const tool = findTool(name);
	if (!tool) {
		return report(onEvent, call.id, name, args, name, false, `Unknown tool: ${name}`);
	}
	// A read-only run declares only read tools, but a model can still ask for one that was not offered.
	if (options.readOnlyTools && !isReadOnlyTool(name)) {
		return report(onEvent, call.id, name, args, tool.summary(args), false, `${name} is not available here. Report what needs changing instead of changing it.`);
	}
	const summary = tool.summary(args);
	const mode = options.getMode();
	const context: ToolContext = {
		root: options.root,
		allowOutsideWorkspace: mode === 'bypassPermissions',
		commandTimeoutSeconds: options.commandTimeoutSeconds,
		signal: options.signal,
		memoryFile: options.memoryFile,
	};
	onEvent({ type: 'toolStart', callId: call.id, tool: name, summary, args });

	let kind: ToolKind;
	try {
		kind = await tool.kind(args, context);
	} catch (error) {
		return finish(onEvent, call.id, false, `Error: ${(error as Error).message}`);
	}
	const decision = decide(mode, kind);
	if (decision === 'deny') {
		return finish(onEvent, call.id, false, `${summary} is blocked in plan mode. Describe the change instead of making it.`);
	}
	const key = rememberKey(name, args, kind);
	// Sensitive actions always need fresh consent, even after an earlier "Always".
	const canRemember = kind !== 'sensitiveRead' && kind !== 'sensitiveEdit';
	if (decision === 'ask' && (!canRemember || !remembered.has(key))) {
		const answer = await options.requestPermission({ callId: call.id, tool: name, kind, summary, args, preview: await previewOf(tool, args, context) });
		if (answer === 'deny') {
			return finish(onEvent, call.id, false, 'The user denied this action. Do not retry it. Ask what they want instead.');
		}
		if (answer === 'always' && canRemember) { remembered.add(key); }
	}
	try {
		if (options.signal?.aborted) { return finish(onEvent, call.id, false, 'Stopped by the user.'); }
		await options.beforeToolRun?.(name, args);
		return finish(onEvent, call.id, true, await tool.run(args, context));
	} catch (error) {
		return finish(onEvent, call.id, false, `Error: ${(error as Error).message}`);
	}
}

const SUBAGENT_MAX_TURNS = 12;
const SUBAGENT_CHARS = 12_000;

/** Runs a focused sub-agent with its own fresh conversation and returns its final answer. */
async function runSubagent(callId: string, args: Record<string, unknown>, options: AgentOptions): Promise<string> {
	const { onEvent } = options;
	const task = typeof args.task === 'string' ? args.task.trim() : '';
	const label = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'subtask';
	if (!task) { return report(onEvent, callId, SPAWN_TOOL, args, 'spawn sub-agent', false, 'The sub-agent needs a task.'); }
	if ((options.spawnDepth ?? 0) <= 0) {
		return report(onEvent, callId, SPAWN_TOOL, args, `Sub-agent: ${label}`, false, 'Sub-agent spawning is disabled or the nesting limit was reached.');
	}
	onEvent({ type: 'toolStart', callId, tool: SPAWN_TOOL, summary: `Sub-agent: ${label}`, args });
	// Economy sub-agents run on the cheap model. They are kept read-only because a
	// weaker model's edits would have to be reviewed, which costs back what it saved.
	const economy = options.economy?.subagents ? options.economy : undefined;
	const systemPrompt = [
		'You are a focused sub-agent helping with one subtask inside a larger coding session.',
		economy
			? 'Complete the task below using the available read-only tools, then reply with a concise result: what you found, and the exact file paths and line numbers involved. You cannot edit files or run commands, so report what should change instead of changing it.'
			: 'Complete the task below using the available tools, then reply with a concise result: what you found or did, and any file paths involved.',
		'Do not ask questions; make reasonable assumptions and finish.',
		'',
		`Subtask: ${task}`,
	].join('\n');
	const messages: ChatMessage[] = [{ role: 'user', content: task }];
	let result = '';
	try {
		await runAgent({
			...options,
			systemPrompt,
			messages,
			maxTurns: SUBAGENT_MAX_TURNS,
			spawnDepth: (options.spawnDepth ?? 1) - 1,
			...(economy ? {
				model: economy.model,
				contextWindow: economy.contextWindow,
				maxTokens: economy.maxTokens,
				modelMaxOutput: economy.maxTokens,
				readOnlyTools: true,
				// A cheap model's own reasoning effort is not worth paying for here.
				reasoningEffort: undefined,
				supportsTools: true,
			} : {}),
			onEvent: event => {
				if (event.type === 'routedModel') { onEvent(event); }
				if (event.type === 'text') { result += event.text; }
				// Usage from the cheap model is tallied as a saving, not as main-model spend.
				if (event.type === 'usage') { onEvent(economy ? { type: 'economyUsage', usage: event.usage } : event); }
				if (event.type === 'economyUsage') { onEvent(event); }
				// Re-emit sub-agent progress so the UI can group it, tagged with the parent call.
				if (event.type === 'toolStart' || event.type === 'toolEnd') { onEvent({ ...event, callId: `${callId}:${event.callId}` }); }
			},
		});
	} catch (error) {
		if (options.signal?.aborted) { return finish(onEvent, callId, false, 'Stopped by the user.'); }
		return finish(onEvent, callId, false, `Sub-agent error: ${(error as Error).message}`);
	}
	const trimmed = result.trim();
	const output = trimmed.length > SUBAGENT_CHARS ? trimmed.slice(0, SUBAGENT_CHARS) + '\n[... truncated ...]' : trimmed;
	return finish(onEvent, callId, true, output || 'The sub-agent finished without a written result.');
}

async function previewOf(tool: Tool, args: Record<string, unknown>, context: ToolContext) {
	try {
		return await tool.preview?.(args, context);
	} catch {
		return undefined;
	}
}

function report(onEvent: AgentOptions['onEvent'], callId: string, tool: string, args: Record<string, unknown>, summary: string, ok: boolean, output: string): string {
	onEvent({ type: 'toolStart', callId, tool, summary, args });
	return finish(onEvent, callId, ok, output);
}

function finish(onEvent: AgentOptions['onEvent'], callId: string, ok: boolean, output: string): string {
	onEvent({ type: 'toolEnd', callId, ok, output });
	return output;
}
