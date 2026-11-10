import * as vscode from 'vscode';
import { AgentEvent, PermissionAnswer, PermissionRequest, runAgent } from '../core/agent';
import { BUY_URL } from '../core/credits';
import { GatewayError } from '../core/gateway';
import { readMemory } from '../core/memory';
import { outputTokenLimit } from '../core/context';
import { PermissionMode } from '../core/permissions';
import { buildSystemPrompt, loadProjectInstructions } from '../core/prompt';
import { ChatMessage } from '../core/types';
import { VENDOR } from './lmProvider';
import { Services } from './services';

const COMMAND_MODES: Record<string, PermissionMode> = { plan: 'plan', edit: 'acceptEdits', bypass: 'bypassPermissions' };

/** Registers @openrouter in the VS Code Chat window. */
export function registerParticipant(context: vscode.ExtensionContext, services: Services): vscode.Disposable {
	const remembered = new Set<string>();
	const participant = vscode.chat.createChatParticipant('openrouter.agent', (request, chatContext, stream, token) =>
		handle(services, remembered, request, chatContext, stream, token));
	participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
	return participant;
}

function buyButtons(stream: vscode.ChatResponseStream): void {
	stream.button({ command: 'openrouter.setApiKey', title: 'Enter Gateway and Key' });
	stream.button({ command: 'openrouter.getSubscription', title: 'Get a Subscription' });
}

async function handle(
	services: Services,
	remembered: Set<string>,
	request: vscode.ChatRequest,
	chatContext: vscode.ChatContext,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
	if (!await services.getApiKey()) {
		stream.markdown(`Add your OpenRouter API key below. You can create one at [openrouter.ai](${BUY_URL}).\n\n`);
		buyButtons(stream);
		return {};
	}
	const client = await services.client('chat-participant');
	if (!client) { return {}; }

	if (request.command === 'models') {
		const models = await services.models(true);
		stream.markdown(models.map(m => `- **${m.name}** \`${m.id}\``).join('\n'));
		return {};
	}

	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		stream.markdown('Open a folder first so OpenRouter Client has a workspace to work in.');
		return {};
	}

	const override = request.command ? COMMAND_MODES[request.command] : undefined;
	if (override && !await services.confirmBypass(override)) {
		stream.markdown('Bypass was not enabled, so nothing ran.');
		return {};
	}
	const mode = override ?? services.mode;
	const picked = request.model.vendor === VENDOR ? request.model.id : services.model;
	const planModel = mode === 'plan' ? services.config.get<string>('planModel') : undefined;
	const model = planModel || picked;
	if (planModel && planModel !== picked) { stream.markdown(`> Plan mode is using \`${planModel}\`.\n\n`); }
	const info = await services.modelInfo(model);
	const effort = services.config.get<string>('reasoningEffort', '');
	const messages: ChatMessage[] = [...historyMessages(chatContext), { role: 'user', content: await withReferences(request) }];

	const abort = new AbortController();
	const cancel = token.onCancellationRequested(() => abort.abort());
	try {
		stream.progress('Thinking...');
		await runAgent({
			client,
			model,
			messages,
			root,
			systemPrompt: buildSystemPrompt({ root, mode, projectInstructions: await loadProjectInstructions(root), memory: await readMemory(services.memoryFile), customInstructions: services.config.get<string>('customInstructions') }),
			memoryFile: services.memoryFile,
			commandTimeoutSeconds: services.config.get<number>('commandTimeoutSeconds', 120),
			maxTurns: services.config.get<number>('maxTurns', 50),
			maxTokens: outputTokenLimit(model, info?.maxOutputTokens, services.config.get<number>('maxOutputTokens')),
			modelMaxOutput: info?.maxOutputTokens,
			reasoningEffort: effort && info?.reasoningEfforts.includes(effort) ? effort : undefined,
			contextWindow: info?.contextWindow,
			supportsTools: info?.supportsTools,
			getMode: () => mode,
			requestPermission: askInModal,
			onEvent: event => render(event, stream, root),
			remembered,
			signal: abort.signal,
		});
	} catch (error) {
		stream.markdown(`\n\n**Error:** ${(error as Error).message}\n\n`);
		if (error instanceof GatewayError && (error.limitReached || error.status === 401)) { buyButtons(stream); }
		return { errorDetails: { message: (error as Error).message } };
	} finally {
		cancel.dispose();
	}
	return {};
}

function render(event: AgentEvent, stream: vscode.ChatResponseStream, root: string): void {
	switch (event.type) {
		case 'text':
			stream.markdown(event.text);
			break;
		case 'toolStart':
			stream.progress(event.summary);
			if (typeof event.args.path === 'string') { stream.reference(vscode.Uri.joinPath(vscode.Uri.file(root), event.args.path)); }
			break;
		case 'toolEnd':
			if (!event.ok) { stream.markdown(`\n\n> ${event.output.split('\n')[0]}\n\n`); }
			stream.progress('Thinking...');
			break;
		case 'notice':
			stream.markdown(`\n\n> ${event.message}\n\n`);
			break;
		default:
			break;
	}
}

async function askInModal(request: PermissionRequest): Promise<PermissionAnswer> {
	const allow = 'Allow';
	const always = 'Always Allow';
	const detail = request.tool === 'run_command' ? String(request.args.command) : request.preview?.path ?? String(request.args.path ?? '');
	const choice = await vscode.window.showWarningMessage(`OpenRouter Client wants to: ${request.summary}`, { modal: true, detail }, allow, always);
	return choice === allow ? 'allow' : choice === always ? 'always' : 'deny';
}

function historyMessages(chatContext: vscode.ChatContext): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (const turn of chatContext.history) {
		if (turn instanceof vscode.ChatRequestTurn) {
			out.push({ role: 'user', content: turn.prompt });
		} else if (turn instanceof vscode.ChatResponseTurn) {
			const text = turn.response.map(part => part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : '').join('');
			if (text) { out.push({ role: 'assistant', content: text }); }
		}
	}
	return out;
}

async function withReferences(request: vscode.ChatRequest): Promise<string> {
	const attached: string[] = [];
	for (const reference of request.references) {
		const value = reference.value;
		try {
			if (value instanceof vscode.Uri && value.scheme === 'file') {
				const document = await vscode.workspace.openTextDocument(value);
				attached.push(`Attached file ${vscode.workspace.asRelativePath(value)}:\n${document.getText()}`);
			} else if (value instanceof vscode.Location) {
				const document = await vscode.workspace.openTextDocument(value.uri);
				attached.push(`Attached ${vscode.workspace.asRelativePath(value.uri)}:${value.range.start.line + 1}:\n${document.getText(value.range)}`);
			} else if (typeof value === 'string') {
				attached.push(value);
			}
		} catch { /* a reference that cannot be opened is skipped */ }
	}
	return [request.prompt, ...attached].join('\n\n');
}
