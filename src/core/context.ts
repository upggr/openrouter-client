import { GatewayError, isProviderRejection } from './gateway';
import { ChatMessage, ToolCall } from './types';

const CHARS_PER_TOKEN = 4;
/** Recent tool results are always sent in full. */
const KEEP_RECENT_TOOL_RESULTS = 8;
const TRIM_SHARE = 0.6;
const TRIM_CEILING = 400_000;
const TRIM_TARGET_SHARE = 0.75;
const COMPACT_SHARE = 0.85;
const MIN_TRIMMABLE_CHARS = 400;
const SUMMARY_TOOL_CHARS = 2_000;
const SUMMARY_MAX_CHARS = 400_000;

export const SUMMARY_PREFIX = 'Summary of the conversation so far:';
export const KEEP_TOKENS_AFTER_COMPACT = 40_000;

function contentLength(content: ChatMessage['content']): number {
	if (content === null) { return 0; }
	if (typeof content === 'string') { return content.length; }
	return content.reduce((sum, part) => sum + (part.type === 'text' ? part.text.length : 4_000), 0);
}

export function estimateTokens(messages: ChatMessage[]): number {
	const chars = messages.reduce((sum, message) => {
		const calls = message.tool_calls?.reduce((total, call) => total + call.function.name.length + call.function.arguments.length, 0) ?? 0;
		return sum + contentLength(message.content) + calls;
	}, 0);
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

export const DEFAULT_OUTPUT_TOKENS = 32_000;

/**
 * Output limit for a request. Without one the gateway applies 4,096 tokens,
 * which a thinking model can use up completely before writing any answer.
 * Automatic routing is left alone because the chosen model is not known yet.
 */
export function outputTokenLimit(modelId: string, modelMax: number | undefined, setting: number | undefined): number | undefined {
	if (setting && setting > 0) { return modelMax ? Math.min(setting, modelMax) : setting; }
	if (modelId === 'auto' || !modelMax) { return undefined; }
	return Math.min(modelMax, DEFAULT_OUTPUT_TOKENS);
}

export function trimLimit(contextWindow: number): number {
	return Math.min(contextWindow * TRIM_SHARE, TRIM_CEILING);
}

export function compactLimit(contextWindow: number): number {
	return contextWindow * COMPACT_SHARE;
}

/** How much recent work survives a summary. Larger models keep more. */
export function keepTokensFor(contextWindow?: number): number {
	if (!contextWindow) { return KEEP_TOKENS_AFTER_COMPACT; }
	return Math.min(Math.max(KEEP_TOKENS_AFTER_COMPACT, contextWindow * 0.15), contextWindow * 0.4);
}

function callsById(messages: ChatMessage[]): Map<string, ToolCall> {
	const calls = new Map<string, ToolCall>();
	for (const message of messages) {
		for (const call of message.tool_calls ?? []) { calls.set(call.id, call); }
	}
	return calls;
}

function readKey(call: ToolCall | undefined): string | undefined {
	if (call?.function.name !== 'read_file') { return undefined; }
	try {
		const args = JSON.parse(call.function.arguments) as { path?: string; offset?: number; limit?: number };
		return `${args.path}|${args.offset ?? ''}|${args.limit ?? ''}`;
	} catch {
		return undefined;
	}
}

/**
 * Builds the messages to send, leaving the stored conversation untouched.
 * Earlier reads of a file that was read again are dropped, and the oldest tool
 * output is shortened once the request grows past the trim limit.
 */
export function trimForRequest(messages: ChatMessage[], contextWindow?: number, calibration = 1): ChatMessage[] {
	const calls = callsById(messages);
	const out = [...messages];
	const toolIndexes = out.flatMap((message, index) => message.role === 'tool' ? [index] : []);

	const seen = new Set<string>();
	for (const index of [...toolIndexes].reverse()) {
		const key = readKey(calls.get(out[index].tool_call_id ?? ''));
		if (!key) { continue; }
		if (seen.has(key)) {
			out[index] = { ...out[index], content: '[Superseded by a later read of the same file.]' };
		}
		seen.add(key);
	}

	if (contextWindow) {
		const limit = trimLimit(contextWindow);
		let tokens = estimateTokens(out) * calibration;
		if (tokens > limit) {
			const target = limit * TRIM_TARGET_SHARE;
			for (const index of toolIndexes.slice(0, -KEEP_RECENT_TOOL_RESULTS)) {
				if (tokens <= target) { break; }
				const text = out[index].content;
				if (typeof text !== 'string' || text.length < MIN_TRIMMABLE_CHARS) { continue; }
				const shortened = `${text.slice(0, 200)}\n[Older output removed to save context. Run the tool again if you need it.]`;
				tokens -= ((text.length - shortened.length) / CHARS_PER_TOKEN) * calibration;
				out[index] = { ...out[index], content: shortened };
			}
		}
	}
	return out;
}

/**
 * Finds where the kept part of the conversation starts. It never starts on a
 * tool result, because a tool result must follow the call that requested it.
 * Returns 0 when there is nothing older to summarize.
 */
export function compactionCut(messages: ChatMessage[], keepTokens: number): number {
	let cut = 0;
	for (let index = messages.length - 1; index > 0; index--) {
		if (messages[index].role === 'tool') { continue; }
		if (cut !== 0 && estimateTokens(messages.slice(index)) > keepTokens) { break; }
		cut = index;
	}
	return cut;
}

/** Writes messages as plain text, because tool messages are refused when a request declares no tools. */
export function flattenForSummary(messages: ChatMessage[]): string {
	const lines: string[] = [];
	for (const message of messages) {
		const text = typeof message.content === 'string' ? message.content : '';
		if (message.role === 'tool') {
			lines.push(`Tool result: ${text.length > SUMMARY_TOOL_CHARS ? `${text.slice(0, SUMMARY_TOOL_CHARS)} [cut]` : text}`);
		} else {
			if (text) { lines.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`); }
			for (const call of message.tool_calls ?? []) {
				lines.push(`Assistant called ${call.function.name}: ${call.function.arguments.slice(0, 300)}`);
			}
		}
	}
	const joined = lines.join('\n\n');
	if (joined.length <= SUMMARY_MAX_CHARS) { return joined; }
	const half = SUMMARY_MAX_CHARS / 2;
	return `${joined.slice(0, half)}\n\n[Middle of the conversation cut]\n\n${joined.slice(-half)}`;
}

const OVERFLOW_TEXT = /context[_ ]length|prompt is too long|too many tokens|maximum context|request too large/i;

/** The gateway often reports an oversized request with its generic rejection, so size is checked too. */
export function looksLikeOverflow(error: unknown, tokens: number, contextWindow?: number): boolean {
	if (!(error instanceof GatewayError)) { return false; }
	if (OVERFLOW_TEXT.test(error.message)) { return true; }
	return isProviderRejection(error) && contextWindow !== undefined && tokens > contextWindow * 0.4;
}
