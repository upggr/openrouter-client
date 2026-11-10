import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Attachment, ATTACHMENTS_OPEN, buildAttachedContent, canReadImages, MAX_ATTACHMENTS } from '../core/attachments';
import { Checkpoints } from '../core/checkpoints';
import { SUMMARY_PREFIX, estimateTokens, outputTokenLimit } from '../core/context';
import { AgentEvent, compact, PermissionAnswer, PermissionRequest, runAgent } from '../core/agent';
import { BUY_URL } from '../core/credits';
import { sessionToMarkdown } from '../core/exportChat';
import { GatewayClient, GatewayError } from '../core/gateway';
import { addMemory, readMemory, removeMemory } from '../core/memory';
import { isPermissionMode, PERMISSION_MODES } from '../core/permissions';
import { buildSystemPrompt, loadProjectInstructions } from '../core/prompt';
import { newSession, Session, SessionStore } from '../core/sessions';
import { findTool } from '../core/tools';
import { ChatMessage, ContentPart } from '../core/types';
import { Services } from './services';

const DIFF_SCHEME = 'openrouter-diff';
const ARCHIVED_TOOL_CHARS = 4_000;
const CONTEXT_OPEN = '\n\n<editor_context>';
const MENTIONS_OPEN = '\n\n<mentioned_files>';
const MAX_MENTION_FILES = 20;
const MAX_MENTION_BYTES = 100_000;
const MENTION_IGNORED = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'target', 'vendor', '__pycache__', '.venv', '.vscode-test']);
const HELP = [
	'**Commands**',
	'- `/new` start a new chat',
	'- `/compact` summarize this chat to free context',
	'- `/model <id>` switch model',
	'- `/mode <default|acceptEdits|plan|bypassPermissions>` switch permission mode',
	'- `/credits` show spend and credits',
	'- `/cost` break down what this chat has cost, per model',
	'- `/remember <note>` save a fact for future chats',
	'- `/forget <text>` remove saved notes containing the text',
	'- `/memory` open saved memory',
].join('\n');

interface WebviewMessage {
	type: string;
	text?: string;
	includeSelection?: boolean;
	id?: string;
	value?: string;
	answer?: PermissionAnswer;
	gateway?: string;
	key?: string;
	label?: string;
	attachments?: Attachment[];
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.TextDocumentContentProvider, vscode.Disposable {
	static readonly viewId = 'openrouter.chatView';

	private view: vscode.WebviewView | undefined;
	private session: Session = newSession();
	private readonly store: SessionStore;
	private abort: AbortController | undefined;
	/** Set when the user sent a message that should interrupt the current run instead of queuing. */
	private interruptQueued = false;
	private remembered = new Set<string>();
	/** Messages typed while a request is running, sent in order once it finishes. */
	private readonly queue: { text: string; includeSelection: boolean; attachments: Attachment[] }[] = [];
	/** What the user last sent, so a failed request can be retried with one click. */
	private lastSent: { text: string; includeSelection: boolean; attachments: Attachment[] } | undefined;
	private readonly pending = new Map<string, { resolve: (answer: PermissionAnswer) => void; request: PermissionRequest }>();
	private readonly diffContent = new Map<string, string>();
	private readonly subscriptions: vscode.Disposable[] = [];
	private lastPromptTokens = 0;
	/** Per-model usage accumulated for this chat, used by /cost. */
	private spend = new Map<string, { requests: number; cost: number; promptTokens: number; completionTokens: number; cachedTokens: number; reasoningTokens: number }>();
	private restored = false;
	/** Files snapshotted before the current turn's edits, for one-click rewind. */
	private checkpoints: Checkpoints | undefined;
	private checkpointRoot = '';
	private lastCheckpoint: { root: string; files: { path: string; before: string | undefined }[] } | undefined;

	constructor(private readonly context: vscode.ExtensionContext, private readonly services: Services) {
		const base = context.storageUri ?? context.globalStorageUri;
		this.store = new SessionStore(path.join(base.fsPath, 'sessions'));
		this.subscriptions.push(
			services.onDidChange(() => void this.postState()),
			services.onDidChangeModels(() => void this.postState()),
			vscode.window.onDidChangeTextEditorSelection(() => void this.postState()),
			vscode.window.onDidChangeActiveTextEditor(() => void this.postState()),
			vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, this),
		);
	}

	dispose(): void {
		this.abort?.abort();
		vscode.Disposable.from(...this.subscriptions).dispose();
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.diffContent.get(uri.toString()) ?? '';
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		view.webview.options = { enableScripts: true, localResourceRoots: [media] };
		view.webview.html = this.html(view.webview, media);
		this.subscriptions.push(view.webview.onDidReceiveMessage((message: WebviewMessage) => void this.onMessage(message)));
		view.onDidDispose(() => { this.view = undefined; });
	}

	async reveal(): Promise<void> {
		await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
	}

	async startNew(): Promise<void> {
		this.stop();
		this.queue.length = 0;
		this.session = newSession();
		this.remembered = new Set();
		this.spend = new Map();
		this.lastSent = undefined;
		this.lastPromptTokens = 0;
		await this.postTranscript();
		await this.postState();
	}

	async showSetup(): Promise<void> {
		await this.reveal();
		this.post({ type: 'showSetup' });
	}

	async askAboutSelection(): Promise<void> {
		await this.reveal();
		this.post({ type: 'focusInput', text: 'Explain the selected code.' });
	}

	/** Re-sends the last message after a failure. The failed turn left the user message at the tail. */
	private async retryLast(): Promise<void> {
		if (this.abort || !this.lastSent) { return; }
		const last = this.session.messages.at(-1);
		if (last?.role === 'user') { this.session.messages.pop(); }
		await this.send(this.lastSent.text, this.lastSent.includeSelection, this.lastSent.attachments);
	}

	async exportChat(): Promise<void> {
		const messages = [...(this.session.archive ?? []), ...this.session.messages];
		if (messages.length === 0) {
			void vscode.window.showInformationMessage('This chat is empty, there is nothing to export.');
			return;
		}
		const markdown = sessionToMarkdown(this.session.title, this.session.updatedAt, messages);
		const document = await vscode.workspace.openTextDocument({ content: markdown, language: 'markdown' });
		await vscode.window.showTextDocument(document, { preview: true });
	}

	private stop(): void {
		this.abort?.abort();
		for (const { resolve } of this.pending.values()) { resolve('deny'); }
		this.pending.clear();
	}

	private post(message: object): void {
		void this.view?.webview.postMessage(message);
	}

	private async onMessage(message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
				await this.restoreLastSession();
				await this.postState();
				await this.postTranscript();
				break;
			case 'send': {
				const text = message.text?.trim() ?? '';
				const attachments = (message.attachments ?? []).slice(0, MAX_ATTACHMENTS);
				if (!text && attachments.length === 0) { break; }
				if (this.abort && !text.startsWith('/')) {
					this.queue.push({ text, includeSelection: message.includeSelection === true, attachments });
					await this.postState();
					break;
				}
				await this.send(text, message.includeSelection === true, attachments);
				break;
			}
			case 'removeQueued':
				this.queue.splice(Number(message.id), 1);
				await this.postState();
				break;
			case 'interruptSend': {
				// Stop the current run, keep any later queued messages, and send this one first.
				const text = message.text?.trim() ?? '';
				const attachments = (message.attachments ?? []).slice(0, MAX_ATTACHMENTS);
				if (!text && attachments.length === 0) { break; }
				// If this came from a queued chip, drop that entry so it is not sent twice.
				if (message.id !== undefined) { this.queue.splice(Number(message.id), 1); }
				if (!this.abort) { await this.send(text, message.includeSelection === true, attachments); break; }
				this.queue.unshift({ text, includeSelection: message.includeSelection === true, attachments });
				this.interruptQueued = true;
				this.stop();
				await this.postState();
				break;
			}
			case 'stop':
				if (message.value === 'all') { this.queue.length = 0; }
				this.stop();
				break;
			case 'newChat':
				await this.startNew();
				break;
			case 'loadSession':
				await this.loadSession(message.value ?? '');
				break;
			case 'pickModel':
				await this.services.pickModel();
				break;
			case 'setIncludeSelection':
				await this.context.workspaceState.update('openrouter.includeSelection', message.value !== 'false');
				await this.postState();
				break;
			case 'setModel':
				if (message.value) { await this.services.setModel(message.value); }
				break;
			case 'setMode':
				if (isPermissionMode(message.value)) { await this.services.setMode(message.value); }
				break;
			case 'setEffort':
				await this.services.config.update('reasoningEffort', message.value ?? '', vscode.ConfigurationTarget.Global);
				break;
			case 'permission':
				this.answerPermission(message.id ?? '', message.answer ?? 'deny');
				break;
			case 'openDiff':
				await this.openDiff(message.id ?? '');
				break;
			case 'saveConnection':
				this.post({ type: 'setupResult', error: await this.services.saveConnection(message.gateway ?? '', message.key ?? '', message.label) });
				break;
			case 'addKey':
				this.post({ type: 'keyResult', error: await this.services.saveConnection(message.gateway ?? '', message.key ?? '', message.label) });
				break;
			case 'switchKey':
				await this.services.switchKey(message.value ?? '');
				break;
			case 'forgetKey':
				await this.services.forgetKey(message.value ?? '');
				break;
			case 'buy':
				await this.services.openSubscriptionPage();
				break;
			case 'credits':
				await this.services.showCredits();
				break;
			case 'exportChat':
				await this.exportChat();
				break;
			case 'searchFiles':
				this.post({ type: 'fileResults', id: message.id ?? '', results: await this.searchWorkspaceFiles(message.value ?? '') });
				break;
			case 'rewind':
				await this.rewindCheckpoint();
				break;
			case 'retry':
				await this.retryLast();
				break;
			default:
				break;
		}
	}

	/** Restores the files the last turn edited back to their pre-turn content. */
	private async rewindCheckpoint(): Promise<void> {
		const checkpoint = this.lastCheckpoint;
		if (!checkpoint) { return; }
		this.lastCheckpoint = undefined;
		const restored: string[] = [];
		for (const file of [...checkpoint.files].reverse()) {
			const abs = path.join(checkpoint.root, file.path);
			try {
				if (file.before === undefined) {
					await vscode.workspace.fs.delete(vscode.Uri.file(abs));
				} else {
					await vscode.workspace.fs.writeFile(vscode.Uri.file(abs), Buffer.from(file.before, 'utf8'));
				}
				restored.push(file.path);
			} catch { /* a file may already be gone */ }
		}
		this.post({ type: 'event', event: { type: 'notice', message: restored.length ? `Rewound ${restored.length} file${restored.length === 1 ? '' : 's'}: ${restored.join(', ')}.` : 'Nothing to rewind.' } });
		this.post({ type: 'event', event: { type: 'done', rewind: undefined } });
	}

	private answerPermission(id: string, answer: PermissionAnswer): void {
		const entry = this.pending.get(id);
		if (entry) {
			this.pending.delete(id);
			entry.resolve(answer);
		}
	}

	private async openDiff(id: string): Promise<void> {
		const preview = this.pending.get(id)?.request.preview;
		if (!preview) { return; }
		const nonce = randomBytes(4).toString('hex');
		const left = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/before/${nonce}/${path.basename(preview.path)}` });
		const right = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/after/${nonce}/${path.basename(preview.path)}` });
		this.diffContent.set(left.toString(), preview.before);
		this.diffContent.set(right.toString(), preview.after);
		await vscode.commands.executeCommand('vscode.diff', left, right, `Proposed change: ${path.basename(preview.path)}`, { preview: true });
	}

	/** Reopening VS Code brings back the latest chat instead of an empty one. */
	private async restoreLastSession(): Promise<void> {
		if (this.restored || this.session.messages.length > 0) { return; }
		this.restored = true;
		const [latest] = await this.store.list();
		if (latest) { await this.loadSession(latest.id); }
	}

	private async loadSession(id: string): Promise<void> {
		if (this.abort) { return; }
		const session = await this.store.load(id);
		if (session) {
			this.session = session;
			this.remembered = new Set();
			this.lastPromptTokens = estimateTokens(session.messages);
			await this.postTranscript();
			await this.postState();
		}
	}

	private editorContext(): { file: string; lines: string; text: string } | undefined {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.selection.isEmpty) { return undefined; }
		const { start, end } = editor.selection;
		return {
			file: vscode.workspace.asRelativePath(editor.document.uri),
			lines: start.line === end.line ? `${start.line + 1}` : `${start.line + 1}-${end.line + 1}`,
			text: editor.document.getText(editor.selection),
		};
	}

	private async postState(): Promise<void> {
		if (!this.view) { return; }
		const models = this.services.hasKey ? await this.services.models().catch(() => []) : [];
		const selection = this.editorContext();
		this.post({
			type: 'state',
			hasKey: this.services.hasKey,
			gateway: this.services.baseUrl,
			buyUrl: BUY_URL,
			models: models.map(m => ({ id: m.id, name: m.name, efforts: m.reasoningEfforts, contextWindow: m.contextWindow, deprecated: !!m.deprecatedAt })),
			model: this.services.model,
			mode: this.services.mode,
			includeSelection: this.context.workspaceState.get<boolean>('openrouter.includeSelection', true),
			modes: PERMISSION_MODES,
			effort: this.services.config.get<string>('reasoningEffort', ''),
			keys: await this.services.savedKeys().catch(() => []),
			keyStatus: this.services.keyStatus,
			sessions: await this.store.list(),
			sessionId: this.session.id,
			busy: this.abort !== undefined,
			queue: this.queue.map((q, i) => ({ index: i, text: q.text || q.attachments[0]?.name || 'Attachment' })),
			credits: this.services.credits,
			promptTokens: this.lastPromptTokens,
			selection: selection ? { file: selection.file, lines: selection.lines } : undefined,
		});
	}

	private async postTranscript(): Promise<void> {
		this.post({ type: 'transcript', items: transcriptItems([...(this.session.archive ?? []), ...this.session.messages]) });
	}

	/** Fuzzy file search for @-mentions: workspace-relative paths matching the query. */
	private async searchWorkspaceFiles(query: string): Promise<{ path: string }[]> {
		const exclude = `{${[...MENTION_IGNORED].map(d => `**/${d}/**`).join(',')}}`;
		const files = await vscode.workspace.findFiles('**/*', exclude, 400);
		const q = query.trim().toLowerCase();
		const scored = files
			.map(uri => vscode.workspace.asRelativePath(uri))
			.filter(rel => !rel.split('/').some(seg => MENTION_IGNORED.has(seg)))
			.map(rel => ({ path: rel, score: mentionScore(rel, q) }))
			.filter(x => x.score >= 0)
			.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
		const seen = new Set<string>();
		const results: { path: string }[] = [];
		for (const item of scored) {
			if (seen.has(item.path)) { continue; }
			seen.add(item.path);
			results.push({ path: item.path });
			if (results.length >= MAX_MENTION_FILES) { break; }
		}
		return results;
	}

	/** Reads @-mentioned files from the message and inlines their content for the model. */
	private async resolveMentions(root: string, text: string): Promise<{ mentions: { path: string }[]; block: string }> {
		const names = new Set<string>();
		for (const match of text.matchAll(/@([\w./-]+)/g)) { names.add(match[1]); }
		if (names.size === 0) { return { mentions: [], block: '' }; }
		const parts: string[] = [];
		const resolved: { path: string }[] = [];
		let bytes = 0;
		for (const name of names) {
			const [found] = await this.searchWorkspaceFiles(name);
			if (!found) { continue; }
			const abs = path.join(root, found.path);
			try {
				const stat = await vscode.workspace.fs.stat(vscode.Uri.file(abs));
				if (stat.type !== vscode.FileType.File) { continue; }
				const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
				const content = Buffer.from(raw).toString('utf8');
				if (content.includes('�')) { continue; } // likely binary
				const trimmed = content.length > MAX_MENTION_BYTES ? content.slice(0, MAX_MENTION_BYTES) + '\n[... truncated ...]' : content;
				if (bytes + trimmed.length > MAX_MENTION_BYTES) { break; }
				bytes += trimmed.length;
				resolved.push(found);
				parts.push(`--- ${found.path} ---\n${trimmed}`);
			} catch { /* skip unreadable */ }
		}
		return { mentions: resolved, block: parts.length ? `${MENTIONS_OPEN}\n${parts.join('\n\n')}\n</mentioned_files>` : '' };
	}

	private async send(text: string, includeSelection: boolean, attachments: Attachment[] = []): Promise<void> {
		if (this.abort) { return; }
		if (text.startsWith('/') && await this.slashCommand(text)) { return; }

		const client = await this.services.client('sidebar');
		if (!client) { return; }
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) {
			this.post({ type: 'event', event: { type: 'error', message: 'Open a folder first so OpenRouter Client has a workspace to work in.' } });
			return;
		}

		const selection = includeSelection ? this.editorContext() : undefined;
		this.lastSent = { text, includeSelection: includeSelection && !!selection, attachments };
		let withSelection = selection ? `${text}${CONTEXT_OPEN}\nSelected from ${selection.file}:${selection.lines}\n${selection.text}\n</editor_context>` : text;
		const { mentions, block: mentionBlock } = await this.resolveMentions(root, text);
		if (mentionBlock) { withSelection += mentionBlock; }
		const modelId = this.services.model;
		const info = await this.services.modelInfo(modelId);
		const content = buildAttachedContent(withSelection, attachments, canReadImages(modelId, info?.supportsImages));
		this.session.messages.push({ role: 'user', content });
		if (this.session.title === 'New chat') { this.session.title = (text || attachments[0]?.name || 'Attachment').slice(0, 60); }
		this.post({ type: 'event', event: { type: 'user', text, attachments: attachments.map(a => ({ name: a.name, mime: a.mime, isImage: !!a.dataUrl, dataUrl: a.dataUrl })), mentions: mentions.map(m => m.path) } });

		const abort = new AbortController();
		this.abort = abort;
		this.lastCheckpoint = undefined;
		await this.postState();
		await this.run(client, root, abort);
	}

	private async run(client: GatewayClient, root: string, abort: AbortController): Promise<void> {
		const services = this.services;
		const planModel = services.mode === 'plan' ? services.config.get<string>('planModel') : undefined;
		const model = planModel || services.model;
		if (planModel && planModel !== services.model) {
			this.post({ type: 'event', event: { type: 'notice', message: `Plan mode is using ${planModel}.` } });
		}
		const info = await services.modelInfo(model);
		const effort = services.config.get<string>('reasoningEffort', '');
		this.checkpointRoot = root;
		this.checkpoints = new Checkpoints(readFileOrUndefined, (r, rel) => path.join(r, rel), root);
		try {
			await runAgent({
				client,
				model,
				messages: this.session.messages,
				root,
				systemPrompt: await this.systemPrompt(root),
				memoryFile: services.memoryFile,
				commandTimeoutSeconds: services.config.get<number>('commandTimeoutSeconds', 120),
				maxTurns: services.config.get<number>('maxTurns', 50),
				maxTokens: outputTokenLimit(model, info?.maxOutputTokens, services.config.get<number>('maxOutputTokens')),
				modelMaxOutput: info?.maxOutputTokens,
				reasoningEffort: effort && info?.reasoningEfforts.includes(effort) ? effort : undefined,
				contextWindow: info?.contextWindow,
				supportsTools: info?.supportsTools,
				spawnDepth: services.config.get<boolean>('subagents', true) ? 2 : 0,
				getMode: () => services.mode,
				requestPermission: request => this.requestPermission(request, abort.signal),
				onEvent: event => this.onAgentEvent(event),
				remembered: this.remembered,
				signal: abort.signal,
			});
		} catch (error) {
			const unauthorized = error instanceof GatewayError && error.status === 401;
			const keyWorks = unauthorized && await services.keyStillWorks();
			const limitOrKey = error instanceof GatewayError && (error.limitReached || (unauthorized && !keyWorks));
			const message = keyWorks ? 'The gateway refused this request (401), but your API key is working. Retry, or start a new chat if it keeps happening.' : (error as Error).message;
			this.post({ type: 'event', event: { type: 'error', message, showBuy: limitOrKey } });
		} finally {
			this.abort = undefined;
			if (this.checkpoints && this.checkpoints.count > 0) {
				this.lastCheckpoint = { root: this.checkpointRoot, files: this.checkpoints.snapshot };
			}
			this.checkpoints = undefined;
			this.session.updatedAt = Date.now();
			await this.store.save(this.session).catch(() => undefined);
			this.post({ type: 'event', event: { type: 'done', rewind: this.lastCheckpoint ? { count: this.lastCheckpoint.files.length, paths: this.lastCheckpoint.files.map(f => f.path) } : undefined } });
			await this.postState();
			void this.suggestFollowups(client, model);
		}
		// An interrupt message runs even though this turn was aborted; a normally-finished
		// turn drains the queue as usual.
		const wasInterrupted = this.interruptQueued;
		this.interruptQueued = false;
		if (abort.signal.aborted && !wasInterrupted) { return; }
		const next = this.queue.shift();
		if (next) {
			await this.postState();
			await this.send(next.text, next.includeSelection, next.attachments);
		}
	}

	/** Generates a few one-click follow-up prompts from the last exchange, shown as chips. */
	private async suggestFollowups(client: GatewayClient, model: string): Promise<void> {
		if (!this.services.config.get<boolean>('followupSuggestions', true)) { return; }
		const lastUser = [...this.session.messages].reverse().find(m => m.role === 'user');
		const lastAssistant = [...this.session.messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content);
		if (!lastUser || !lastAssistant) { return; }
		const clip = (s: string, n: number) => s.length > n ? s.slice(0, n) + '…' : s;
		const userText = clip(rawUserText(lastUser.content), 400);
		const assistantText = clip(String(lastAssistant.content), 600);
		const prompt = [
			'You suggest 3 short follow-up requests the user might send next in a coding session.',
			'Reply with ONLY 3 lines, each a concise imperative (max 8 words), no numbering, no bullets, no quotes.',
			'Make them specific and actionable (tests, refactor, explain, run, docs).',
			'',
			`User asked: ${userText}`,
			`Assistant replied: ${assistantText}`,
		].join('\n');
		try {
			let text = '';
			for await (const event of client.streamChat({ model, messages: [{ role: 'user', content: prompt }], maxTokens: 120 })) {
				if (event.type === 'text') { text += event.text; }
			}
			const suggestions = text.split('\n').map(l => l.replace(/^[-*•\d.)\s]+/, '').trim()).filter(l => l.length > 2 && l.length < 80).slice(0, 3);
			if (suggestions.length) { this.post({ type: 'suggestions', suggestions }); }
		} catch { /* suggestions are best-effort */ }
	}

	private async systemPrompt(root: string): Promise<string> {
		return buildSystemPrompt({
			root,
			mode: this.services.mode,
			projectInstructions: await loadProjectInstructions(root),
			memory: await readMemory(this.services.memoryFile),
			customInstructions: this.services.config.get<string>('customInstructions'),
		});
	}

	private archive(removed: ChatMessage[]): void {
		const kept = removed.map(m => typeof m.content === 'string' && m.role === 'tool' ? { ...m, content: m.content.slice(0, ARCHIVED_TOOL_CHARS) } : m);
		this.session.archive = [...(this.session.archive ?? []), ...kept];
	}

	private onAgentEvent(event: AgentEvent): void {
		if (event.type === 'compacted') {
			this.archive(event.removed);
			return;
		}
		if (event.type === 'toolStart') {
			// Snapshot the target before the edit lands, so the whole turn can be rewound.
			void this.checkpoints?.capture(event.tool, event.args);
		}
		if (event.type === 'usage') {
			this.lastPromptTokens = event.usage.promptTokens;
			const key = event.usage.model ?? 'unknown';
			const entry = this.spend.get(key) ?? { requests: 0, cost: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0 };
			entry.requests++;
			entry.cost += event.usage.cost ?? 0;
			entry.promptTokens += event.usage.promptTokens;
			entry.completionTokens += event.usage.completionTokens;
			entry.cachedTokens += event.usage.cachedTokens ?? 0;
			entry.reasoningTokens += event.usage.reasoningTokens ?? 0;
			this.spend.set(key, entry);
		}
		this.post({ type: 'event', event });
	}

	private costReport(): string {
		if (this.spend.size === 0) { return 'No requests in this chat yet.'; }
		const lines = ['**This chat so far**', ''];
		let total = 0;
		for (const [model, s] of [...this.spend.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
			total += s.cost;
			const parts = [`${s.requests} request${s.requests === 1 ? '' : 's'}`, `${(s.promptTokens + s.completionTokens).toLocaleString()} tokens`];
			if (s.cachedTokens) { parts.push(`${s.cachedTokens.toLocaleString()} cached`); }
			if (s.reasoningTokens) { parts.push(`${s.reasoningTokens.toLocaleString()} reasoning`); }
			lines.push(`- \`${model}\`: **$${s.cost.toFixed(6)}** (${parts.join(', ')})`);
		}
		lines.push('', `**Total: $${total.toFixed(6)}**`);
		return lines.join('\n');
	}

	private requestPermission(request: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer> {
		if (signal.aborted) { return Promise.resolve('deny'); }
		return new Promise(resolve => {
			this.pending.set(request.callId, { resolve, request });
			this.post({
				type: 'event',
				event: {
					type: 'permission',
					callId: request.callId,
					tool: request.tool,
					summary: request.summary,
					detail: request.tool === 'run_command' ? String(request.args.command) : undefined,
					sensitive: request.kind === 'sensitiveRead' || request.kind === 'sensitiveEdit',
					canDiff: request.preview !== undefined,
				},
			});
		});
	}

	private async slashCommand(text: string): Promise<boolean> {
		const [command, ...rest] = text.split(/\s+/);
		const value = rest.join(' ');
		switch (command) {
			case '/new':
			case '/clear':
				await this.startNew();
				return true;
			case '/help':
				this.post({ type: 'event', event: { type: 'info', text: HELP } });
				return true;
			case '/model':
				if (value) { await this.services.setModel(value); } else { await this.services.pickModel(); }
				return true;
			case '/mode':
				if (isPermissionMode(value)) { await this.services.setMode(value); } else { await this.services.pickMode(); }
				return true;
			case '/credits':
				this.post({ type: 'event', event: { type: 'info', text: `**${this.services.credits.label}**\n\n${this.services.credits.detail}` } });
				return true;
			case '/cost':
				this.post({ type: 'event', event: { type: 'info', text: this.costReport() } });
				return true;
			case '/remember':
				if (!value) { return false; }
				await addMemory(this.services.memoryFile, value);
				this.post({ type: 'event', event: { type: 'notice', message: 'Saved to memory for future chats.' } });
				return true;
			case '/forget':
				if (!value) { return false; }
				this.post({ type: 'event', event: { type: 'notice', message: `Removed ${await removeMemory(this.services.memoryFile, value)} notes.` } });
				return true;
			case '/memory':
				await this.services.openMemory();
				return true;
			case '/compact':
				await this.compactSession();
				return true;
			default:
				return false;
		}
	}

	private async compactSession(): Promise<void> {
		const client = await this.services.client('sidebar');
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!client || !root || this.session.messages.length === 0) { return; }
		const abort = new AbortController();
		this.abort = abort;
		await this.postState();
		try {
			const model = this.services.model;
			const info = await this.services.modelInfo(model);
			const removed = await compact({ client, model, messages: this.session.messages, signal: abort.signal, maxTokens: outputTokenLimit(model, info?.maxOutputTokens, this.services.config.get<number>('maxOutputTokens')) });
			if (removed.length === 0) {
				this.post({ type: 'event', event: { type: 'notice', message: 'There is nothing older to summarize yet.' } });
				return;
			}
			this.archive(removed);
			this.lastPromptTokens = estimateTokens(this.session.messages);
			await this.store.save(this.session);
			await this.postTranscript();
		} catch (error) {
			this.post({ type: 'event', event: { type: 'error', message: (error as Error).message } });
		} finally {
			this.abort = undefined;
			await this.postState();
		}
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const nonce = randomBytes(16).toString('base64');
		const uri = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString();
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri('chat.css')}">
<title>OpenRouter Client</title>
</head>
<body>
<section id="welcome" hidden>
	<h2>Connect OpenRouter Client</h2>
	<p><strong>Did your provider already give you a gateway and API key?</strong> Enter them here.</p>
	<label for="gateway">Gateway URL</label>
	<input id="gateway" type="url" spellcheck="false" autocomplete="off">
	<label for="apiKey">API key</label>
	<input id="apiKey" type="password" spellcheck="false" autocomplete="off" placeholder="sk-or-v1-...">
	<label for="keyLabel">Name for this key <span class="muted">(optional, so you can switch keys later)</span></label>
	<input id="keyLabel" type="text" spellcheck="false" autocomplete="off" placeholder="e.g. Work, Personal">
	<p id="setupError" class="error-text" role="alert" hidden></p>
	<button id="saveConnection" type="button">Connect</button>
	<hr>
	<p><strong>No key yet?</strong> Create one on openrouter.ai, then paste it above.</p>
	<button id="getSubscription" class="secondary" type="button">Get an API key</button>
	<button id="closeSetup" class="link" type="button" hidden>Back to chat</button>
	<p class="muted">Your key is stored in VS Code secret storage. OpenRouter Client is an independent project, not affiliated with or endorsed by OpenRouter.</p>
</section>
<main id="app" hidden>
	<header>
		<select id="sessions" aria-label="Chat history"></select>
		<button id="newChat" class="icon" type="button" title="New chat" aria-label="New chat">+</button>
	</header>
	<div id="transcript" role="log" aria-live="polite"></div>
	<div id="queue" hidden></div>
	<footer>
		<div class="composer">
			<label id="selectionChip" class="chip attach-chip" hidden><span class="at" aria-hidden="true">@</span><input id="includeSelection" type="checkbox" checked aria-label="Include the editor selection"><span id="selectionText"></span></label>
			<div id="mentionMenu" role="listbox" aria-label="Mention a file" hidden></div>
			<div id="attachments" class="row" hidden></div>
			<textarea id="input" rows="3" placeholder="Ask anything… drop or paste files, or type / for commands" aria-label="Message"></textarea>
			<input id="fileInput" type="file" multiple hidden>
			<div class="row composer-actions">
				<button id="attach" class="icon ghost" type="button" title="Attach files" aria-label="Attach files">📎</button>
				<button id="dictate" class="icon ghost" type="button" title="Dictate a message" aria-label="Dictate a message" hidden>🎤</button>
				<button id="model" class="chip model-chip" type="button" aria-label="Choose model" title="Search models"><span class="model-symbol" aria-hidden="true">✦</span><span id="modelName">Choose model</span><span aria-hidden="true" class="chev">▾</span></button>
				<span class="spacer"></span>
				<button id="send" class="icon send" type="button" title="Send" aria-label="Send">➤</button>
				<button id="stop" class="icon ghost" type="button" title="Stop" aria-label="Stop" hidden>■</button>
			</div>
		</div>
		<div id="suggestions" hidden></div>
		<div id="status" class="muted" role="status" hidden></div>
		<details id="advanced"><summary>Options <span id="modeBadge" class="chip" hidden></span><span id="effortBadge" class="chip" hidden></span><span id="credits" class="chip credits-chip"></span></summary>
			<div id="effortWrap" hidden><span class="opt-label">Reasoning</span><div id="effort" class="segmented" role="group" aria-label="Reasoning effort"></div></div>
			<div><span class="opt-label">Permissions</span><div id="mode" class="segmented" role="group" aria-label="Permission mode"></div></div>
			<div><span class="opt-label">Keys</span><div id="keyPicker">
				<button id="keyButton" class="unknown" type="button" title="API key" aria-label="API key" aria-haspopup="true" aria-expanded="false">
					<svg class="key-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M10.5 1a4.5 4.5 0 0 0-4.36 5.63L1.15 11.6a.5.5 0 0 0-.15.36V14.5a.5.5 0 0 0 .5.5h2.75a.5.5 0 0 0 .5-.5V13h1.5a.5.5 0 0 0 .5-.5V11h1.5a.5.5 0 0 0 .35-.15l.77-.77A4.5 4.5 0 1 0 10.5 1Zm1 4.75a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Z"/></svg>
				</button>
				<div id="keyMenu" hidden>
					<div id="keyList"></div>
					<button id="addKey" class="link" type="button">+ Add a key</button>
					<div id="keyForm" hidden>
						<input id="newKey" type="password" spellcheck="false" autocomplete="off" placeholder="API key (sk-or-v1-...)" aria-label="API key">
						<input id="newKeyName" type="text" spellcheck="false" autocomplete="off" placeholder="Name (optional), e.g. Work" aria-label="Name for this key">
						<input id="newKeyGateway" type="url" spellcheck="false" autocomplete="off" placeholder="Gateway URL" aria-label="Gateway URL">
						<p id="keyError" class="error-text" role="alert" hidden></p>
						<div class="row">
							<button id="saveKey" type="button">Save and use</button>
							<button id="cancelKey" class="secondary" type="button">Cancel</button>
						</div>
					</div>
				</div>
			</div></div>
			<div class="opt-row"><span class="opt-label">Credits</span><button id="creditsDetail" class="link" type="button"></button></div>
			<div class="opt-row"><span class="opt-label">Context</span><span id="contextUsage"></span></div>
		</details>
	</footer>
</main>
<script nonce="${nonce}" src="${uri('markdown.js')}"></script>
<script nonce="${nonce}" src="${uri('chat.js')}"></script>
</body>
</html>`;
	}
}

async function readFileOrUndefined(absPath: string): Promise<string | undefined> {
	try {
		const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
		return Buffer.from(raw).toString('utf8');
	} catch {
		return undefined;
	}
}

/** Fuzzy match score for an @-mention query against a relative path. -1 = no match; higher = better. */
function mentionScore(relPath: string, query: string): number {
	if (!query) { return 0; }
	const lower = relPath.toLowerCase();
	const base = lower.split('/').pop() ?? lower;
	if (base.startsWith(query)) { return 100 - base.length; }
	if (lower.includes(query)) { return 50 - lower.indexOf(query); }
	// Subsequence match across the whole path.
	let i = 0;
	for (const ch of lower) { if (ch === query[i]) { i++; if (i === query.length) { return 10; } } }
	return i === query.length ? 10 : -1;
}

function rawUserText(content: ChatMessage['content']): string {
	if (typeof content === 'string') { return content; }
	if (content === null) { return ''; }
	return content.filter((p): p is ContentPart & { type: 'text' } => p.type === 'text').map(p => p.text).join('');
}

function visibleUserText(content: ChatMessage['content']): string {
	const text = rawUserText(content);
	const index = Math.min(...[CONTEXT_OPEN, ATTACHMENTS_OPEN].map(marker => { const i = text.indexOf(marker); return i < 0 ? Infinity : i; }));
	return Number.isFinite(index) ? text.slice(0, index) : text;
}

function firstImageUrl(content: ChatMessage['content']): string | undefined {
	if (!Array.isArray(content)) { return undefined; }
	const part = content.find(p => p.type === 'image_url');
	return part?.type === 'image_url' ? part.image_url.url : undefined;
}

/** Turns stored messages into items the webview can draw. */
export function transcriptItems(messages: ChatMessage[]): object[] {
	const results = new Map(messages.filter(m => m.role === 'tool').map(m => [m.tool_call_id, String(m.content ?? '')]));
	const items: object[] = [];
	for (const message of messages) {
		if (message.role === 'user' && typeof message.content === 'string' && message.content.startsWith(SUMMARY_PREFIX)) {
			items.push({ kind: 'notice', text: 'Older messages above were summarized to save context.' });
		} else if (message.role === 'user') {
			items.push({ kind: 'user', text: visibleUserText(message.content), imageUrl: firstImageUrl(message.content) });
		} else if (message.role === 'assistant') {
			if (typeof message.content === 'string' && message.content) { items.push({ kind: 'assistant', text: message.content }); }
			for (const call of message.tool_calls ?? []) {
				let summary = call.function.name;
				try {
					summary = findTool(call.function.name)?.summary(JSON.parse(call.function.arguments) as Record<string, unknown>) ?? summary;
				} catch { /* keep the tool name */ }
				const output = results.get(call.id) ?? '';
				items.push({ kind: 'tool', summary, output, ok: !output.startsWith('Error:') });
			}
		}
	}
	return items;
}
