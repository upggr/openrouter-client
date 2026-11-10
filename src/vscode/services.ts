import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { addSpend, BUY_URL, creditStatus, CreditRefreshGuard, CreditStatus, SpendRecord } from '../core/credits';
import { DEFAULT_BASE_URL, GatewayClient, GatewayError, LiveLimit, normalizeBaseUrl } from '../core/gateway';
import { defaultKeyLabel, KeyState, keyStates, maskKey, StoredKey } from '../core/keyring';
import { addMemory, readMemory } from '../core/memory';
import { bestScore, families, filterModels, formatContext, formatPrice, groupModels, isFree, ModelFilter, ModelSort, SORT_OPTIONS, sortModels } from '../core/modelPicker';
import { PERMISSION_MODES, PermissionMode, restorePermissionMode } from '../core/permissions';
import { ModelInfo } from '../core/types';

const API_KEY_SECRET = 'openrouter.apiKey';
/** JSON list of every saved key, so the user can switch between gateways and accounts. */
const KEYRING_SECRET = 'openrouter.keyring';
const MODEL_STATE = 'openrouter.model';
const MODE_STATE = 'openrouter.permissionMode';
const SPEND_STATE = 'openrouter.spend';
const BYPASS_ACK_STATE = 'openrouter.bypassAcknowledged';
/** Remembers the picker's sort between sessions. */
const MODEL_SORT_STATE = 'openrouter.modelSort';
/** The gateway may settle usage after the request has finished. */
const CREDIT_REFRESH_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];

/** Keep connection identity and stored spend keys distinct without storing API keys. */
function connectionId(apiKey: string, baseUrl: string): string {
	return createHash('sha256').update(JSON.stringify([apiKey, baseUrl])).digest('hex');
}

export type Surface = 'sidebar' | 'chat-participant' | 'model-provider';

/** Shared state for the sidebar, the @openrouter participant and the model provider. */
export class Services implements vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly modelsChanged = new vscode.EventEmitter<void>();
	readonly onDidChangeModels = this.modelsChanged.event;
	private readonly status: vscode.StatusBarItem;
	private readonly subscriptions: vscode.Disposable[] = [];
	private cachedModels: ModelInfo[] | undefined;
	private currentMode: PermissionMode;
	private liveLimit: LiveLimit | undefined;
	private keyPresent = false;
	private keyHealth: 'ok' | 'rejected' | 'unknown' = 'unknown';
	private readonly creditGuard = new CreditRefreshGuard();
	private creditConnection: string | undefined;
	private creditRefreshTimers: ReturnType<typeof setTimeout>[] = [];
	private spendUpdates: Promise<void> = Promise.resolve();

	constructor(private readonly context: vscode.ExtensionContext) {
		this.currentMode = restorePermissionMode(
			context.workspaceState.get(MODE_STATE), this.config.get<string>('permissionMode'),
			context.globalState.get<boolean>(BYPASS_ACK_STATE) === true,
		);
		this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.status.command = 'openrouter.openChat';
		this.subscriptions.push(
			this.changed,
			this.modelsChanged,
			this.status,
			context.secrets.onDidChange(e => {
				if (e.key === API_KEY_SECRET) { void this.keyChanged(); }
				if (e.key === KEYRING_SECRET) { this.fire(); }
			}),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('openrouter')) {
					this.fire();
					if (e.affectsConfiguration('openrouter.baseUrl')) { void this.keyChanged(); }
				}
			}),
		);
		void this.keyChanged();
	}

	dispose(): void {
		this.creditGuard.reset();
		this.clearCreditTimers();
		vscode.Disposable.from(...this.subscriptions).dispose();
	}

	get config(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration('openrouter');
	}

	/** Private to this project, and outside the repository so it is never committed. */
	get memoryFile(): string {
		return path.join((this.context.storageUri ?? this.context.globalStorageUri).fsPath, 'memory.md');
	}

	async openMemory(): Promise<void> {
		if (!await readMemory(this.memoryFile)) {
			await addMemory(this.memoryFile, 'Add lasting project notes here, one per line.');
		}
		await vscode.window.showTextDocument(vscode.Uri.file(this.memoryFile));
	}

	get hasKey(): boolean {
		return this.keyPresent;
	}

	get mode(): PermissionMode {
		return this.currentMode;
	}

	get model(): string {
		return this.context.globalState.get<string>(MODEL_STATE) ?? this.config.get<string>('defaultModel', 'auto');
	}

	get credits(): CreditStatus {
		return creditStatus(this.context.globalState.get<SpendRecord>(SPEND_STATE), this.config.get<number>('monthlySpendLimit', 0), this.liveLimit, new Date(), this.activeKeyId);
	}

	/** Fingerprint of the active connection, so local spend is not mixed across keys. */
	private get activeKeyId(): string | undefined {
		return this.creditConnection;
	}

	async getApiKey(): Promise<string | undefined> {
		return (await this.context.secrets.get(API_KEY_SECRET)) || process.env.OPENROUTER_API_KEY || undefined;
	}

	/** Returns a client, or undefined after telling a user with no key where to get one. */
	async client(feature: Surface): Promise<GatewayClient | undefined> {
		const apiKey = await this.getApiKey();
		if (!apiKey) {
			void this.promptForKey();
			return undefined;
		}
		return this.buildClient(apiKey, feature);
	}

	private buildClient(apiKey: string, feature: Surface, baseUrl = this.baseUrl): GatewayClient {
		const id = connectionId(apiKey, baseUrl);
		return new GatewayClient({
			baseUrl,
			apiKey,
			appTitle: 'OpenRouter Client for VS Code',
			appUrl: 'https://github.com/upggr/openrouter-client',
			feature,
			idleTimeoutMs: this.config.get<number>('streamIdleTimeoutSeconds', 240) * 1000,
			onUsage: usage => {
				if (!this.creditGuard.matches(id)) { return; }
				this.scheduleCreditRefresh();
				if (usage.cost && Number.isFinite(usage.cost) && usage.cost > 0) { void this.recordCost(usage.cost, id); }
			},
		});
	}

	async promptForKey(): Promise<void> {
		const enter = 'Enter API Key';
		const buy = 'Create a Key';
		const choice = await vscode.window.showInformationMessage('OpenRouter Client needs an OpenRouter API key. Enter the key you already have, or create one on openrouter.ai.', enter, buy);
		if (choice === enter) { await vscode.commands.executeCommand('openrouter.setApiKey'); }
		if (choice === buy) { await this.openSubscriptionPage(); }
	}

	async openSubscriptionPage(): Promise<void> {
		await vscode.env.openExternal(vscode.Uri.parse(BUY_URL));
	}

	get baseUrl(): string {
		return this.config.get<string>('baseUrl', DEFAULT_BASE_URL);
	}

	/** Validates and stores a gateway and key. Returns an error message, or undefined on success. */
	async saveConnection(gateway: string, key: string, label?: string): Promise<string | undefined> {
		try {
			const baseUrl = normalizeBaseUrl(gateway || DEFAULT_BASE_URL);
			if (!key.trim()) { return 'Enter your API key.'; }
			const trimmed = key.trim();
			await this.buildClient(trimmed, 'sidebar', baseUrl).listModels();
			if (baseUrl !== normalizeBaseUrl(this.baseUrl)) {
				await this.config.update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
			}
			await this.context.secrets.store(API_KEY_SECRET, trimmed);
			const ring = await this.keyring();
			const existing = ring.find(k => k.key === trimmed);
			const entry: StoredKey = { id: existing?.id ?? randomUUID(), label: label?.trim() || existing?.label || defaultKeyLabel(trimmed), gateway: baseUrl, key: trimmed };
			await this.storeKeyring([...ring.filter(k => k.key !== trimmed), entry]);
			return undefined;
		} catch (error) {
			return (error as Error).message;
		}
	}

	async clearApiKey(): Promise<void> {
		await this.context.secrets.delete(API_KEY_SECRET);
	}

	async keyring(): Promise<StoredKey[]> {
		try {
			return JSON.parse(await this.context.secrets.get(KEYRING_SECRET) ?? '[]') as StoredKey[];
		} catch {
			return [];
		}
	}

	private async storeKeyring(keys: StoredKey[]): Promise<void> {
		await this.context.secrets.store(KEYRING_SECRET, JSON.stringify(keys));
	}

	/** The key currently in use, masked for display. */
	async activeKeyLabel(): Promise<string | undefined> {
		const active = await this.context.secrets.get(API_KEY_SECRET);
		if (!active) { return undefined; }
		const entry = (await this.keyring()).find(k => k.key === active);
		return entry ? `${entry.label} (${maskKey(active)})` : maskKey(active);
	}

	/** Switch between saved keys, add a new one, or forget a saved one. */
	async pickApiKey(): Promise<void> {
		const active = await this.context.secrets.get(API_KEY_SECRET);
		const ring = await this.keyring();
		const add = '$(add) Add a new gateway and key…';
		const items = ring.map(k => ({
			label: `${k.key === active ? '$(check) ' : ''}${k.label}`,
			description: `${maskKey(k.key)} · ${k.gateway}`,
			detail: k.key === active ? 'Currently in use' : undefined,
			key: k,
		}));
		const picked = await vscode.window.showQuickPick([...items, { label: add, description: '', detail: undefined, key: undefined }], {
			title: 'OpenRouter Client API Keys',
			placeHolder: active ? `Using ${await this.activeKeyLabel()}` : 'No key stored yet',
		});
		if (!picked) { return; }
		if (!picked.key) {
			await vscode.commands.executeCommand('openrouter.setApiKey');
			return;
		}
		if (picked.key.key === active) { return; }
		const chosen = picked.key;
		const actions = await vscode.window.showQuickPick(
			[{ label: '$(arrow-swap) Switch to this key', action: 'switch' }, { label: '$(trash) Forget this key', action: 'forget' }],
			{ title: `${chosen.label} (${maskKey(chosen.key)})` },
		);
		if (actions?.action === 'switch') {
			await this.switchKey(chosen.id);
			void vscode.window.showInformationMessage(`OpenRouter Client now uses ${chosen.label} (${maskKey(chosen.key)}).`);
		} else if (actions?.action === 'forget') {
			await this.forgetKey(chosen.id);
			void vscode.window.showInformationMessage(`Forgot ${chosen.label}. ${chosen.key === active ? 'The active key was left untouched.' : ''}`);
		}
	}

	/** Saved keys for the chat view, masked. A key saved before the ring existed is added to it here. */
	async savedKeys(): Promise<KeyState[]> {
		const active = await this.context.secrets.get(API_KEY_SECRET);
		let ring = await this.keyring();
		if (active && !ring.some(k => k.key === active)) {
			ring = [...ring, { id: randomUUID(), label: defaultKeyLabel(active), gateway: normalizeBaseUrl(this.baseUrl), key: active }];
			await this.storeKeyring(ring);
		}
		return keyStates(ring, active);
	}

	async switchKey(id: string): Promise<void> {
		const chosen = (await this.keyring()).find(k => k.id === id);
		if (!chosen) { return; }
		if (chosen.gateway !== this.baseUrl) {
			await this.config.update('baseUrl', chosen.gateway, vscode.ConfigurationTarget.Global);
		}
		await this.context.secrets.store(API_KEY_SECRET, chosen.key);
		// The secret-change listener also refreshes, but refresh the live limit with the new key explicitly:
		// a different key can mean a different account, and the config listener does not fire when the gateway stayed the same.
		await this.refreshLiveCredits();
	}

	/** Removes a saved key. If it is the one in use, OpenRouter Client moves to another saved key, or to setup when none is left. */
	async forgetKey(id: string): Promise<void> {
		const ring = await this.keyring();
		const chosen = ring.find(k => k.id === id);
		if (!chosen) { return; }
		const rest = ring.filter(k => k.id !== id);
		// The active key moves first, or savedKeys would add the forgotten key back as an unsaved active key.
		if (chosen.key === await this.context.secrets.get(API_KEY_SECRET)) {
			if (rest[0]) { await this.switchKey(rest[0].id); } else { await this.clearApiKey(); }
		}
		await this.storeKeyring(rest);
	}

	/** OpenRouter reports real spend to the API key itself, so this needs no extra sign-in. */
	async refreshLiveCredits(): Promise<void> {
		const apiKey = await this.getApiKey();
		if (!apiKey) { return; }
		const baseUrl = this.baseUrl;
		const id = connectionId(apiKey, baseUrl);
		const generation = this.creditGuard.begin(id);
		if (generation === undefined) { return; }
		try {
			const limit = await this.buildClient(apiKey, 'sidebar', baseUrl).getLiveLimit();
			if (!this.creditGuard.isCurrent(id, generation)) { return; }
			this.liveLimit = limit;
		} catch {
			if (!this.creditGuard.isCurrent(id, generation)) { return; }
			// A key that cannot read its own balance still works for chat, so fall back quietly.
			this.liveLimit = undefined;
		}
		this.fire();
	}

	async models(force = false): Promise<ModelInfo[]> {
		if (this.cachedModels && !force) { return this.cachedModels; }
		const apiKey = await this.getApiKey();
		if (!apiKey) { return []; }
		try {
			this.cachedModels = await this.buildClient(apiKey, 'sidebar').listModels();
			this.keyHealth = 'ok';
		} catch (error) {
			this.keyHealth = error instanceof GatewayError && error.status === 401 ? 'rejected' : 'unknown';
			throw error;
		}
		return this.cachedModels;
	}

	/** Whether the gateway accepted the active key the last time it was asked. */
	get keyStatus(): 'ok' | 'rejected' | 'unknown' {
		return this.keyHealth;
	}

	/** Asks the gateway again, because a 401 on a chat request does not always mean a bad key. */
	async keyStillWorks(): Promise<boolean> {
		await this.models(true).catch(() => undefined);
		return this.keyHealth === 'ok';
	}

	async modelInfo(id: string): Promise<ModelInfo | undefined> {
		return (await this.models().catch(() => [])).find(m => m.id === id);
	}

	async setModel(id: string): Promise<void> {
		await this.context.globalState.update(MODEL_STATE, id);
		this.fire();
	}

	/**
	 * The catalogue runs to hundreds of models, so the picker opens on a recommended
	 * order and carries its own sort and filter controls rather than one flat list.
	 */
	async pickModel(): Promise<void> {
		if (!await this.client('sidebar')) { return; }
		const models = await this.models(true);
		let sort = this.context.globalState.get<ModelSort>(MODEL_SORT_STATE, 'recommended');
		let filter: ModelFilter = {};

		for (;;) {
			const shown = sortModels(filterModels(models, filter), sort);
			const sortLabel = SORT_OPTIONS.find(o => o.id === sort)?.label ?? 'Recommended';
			const active = [
				filter.toolsOnly ? 'tools' : '',
				filter.freeOnly ? 'free' : '',
				filter.visionOnly ? 'vision' : '',
				filter.family ?? '',
			].filter(Boolean).join(', ');

			type Item = vscode.QuickPickItem & { id?: string; action?: 'sort' | 'filter' };
			const items: Item[] = [
				{ label: `$(sort-precedence) Sort: ${sortLabel}`, description: 'Change how models are ordered', action: 'sort', alwaysShow: true },
				{ label: `$(filter) Filter${active ? `: ${active}` : ''}`, description: active ? 'Change or clear filters' : 'Tools, free, vision or vendor', action: 'filter', alwaysShow: true },
			];
			for (const group of groupModels(shown, sort)) {
				if (group.label) { items.push({ label: group.label, kind: vscode.QuickPickItemKind.Separator }); }
				for (const m of group.models) { items.push(this.modelItem(m)); }
			}

			const picked = await vscode.window.showQuickPick(items, {
				title: `Select Model · ${shown.length} of ${models.length}`,
				placeHolder: 'Search by name, vendor, price or capability…',
				matchOnDescription: true,
				matchOnDetail: true,
			});
			if (!picked) { return; }
			if (picked.action === 'sort') {
				const choice = await vscode.window.showQuickPick(
					SORT_OPTIONS.map(o => ({ label: o.label, detail: o.detail, id: o.id, picked: o.id === sort })),
					{ title: 'Sort Models By' },
				);
				if (choice) {
					sort = choice.id;
					await this.context.globalState.update(MODEL_SORT_STATE, sort);
				}
				continue;
			}
			if (picked.action === 'filter') {
				filter = await this.pickModelFilter(models, filter);
				continue;
			}
			if (picked.id) { await this.setModel(picked.id); return; }
		}
	}

	private modelItem(m: ModelInfo): vscode.QuickPickItem & { id: string } {
		const icon = m.id === this.model ? '$(check)' : m.deprecatedAt ? '$(warning)' : isFree(m) ? '$(gift)' : '$(sparkle)';
		const score = bestScore(m);
		return {
			label: `${icon} ${m.name}`,
			description: [m.id, m.id === this.model ? 'current' : '', m.deprecatedAt ? 'deprecated' : ''].filter(Boolean).join(' · '),
			detail: [
				formatPrice(m),
				formatContext(m),
				m.supportsTools ? 'tools' : 'no tools',
				m.supportsImages ? 'vision' : '',
				m.reasoningEfforts.length ? 'reasoning' : '',
				score !== undefined ? `score ${Math.round(score)}` : '',
			].filter(Boolean).join(' · '),
			id: m.id,
		};
	}

	private async pickModelFilter(models: ModelInfo[], current: ModelFilter): Promise<ModelFilter> {
		const CLEAR = 'clear';
		const choice = await vscode.window.showQuickPick(
			[
				{ label: '$(tools) Tools only', detail: 'Models the agent can use to edit files', id: 'tools', picked: !!current.toolsOnly },
				{ label: '$(gift) Free only', detail: 'Models that cost nothing to run', id: 'free', picked: !!current.freeOnly },
				{ label: '$(device-camera) Vision only', detail: 'Models that accept images', id: 'vision', picked: !!current.visionOnly },
				{ label: '$(organization) Choose a vendor…', detail: 'Anthropic, OpenAI, Google and others', id: 'family' },
				{ label: '$(clear-all) Clear filters', id: CLEAR },
			],
			{ title: 'Filter Models', placeHolder: 'Filters apply on top of each other' },
		);
		if (!choice) { return current; }
		if (choice.id === CLEAR) { return {}; }
		if (choice.id === 'family') {
			const vendor = await vscode.window.showQuickPick(
				families(models).map(f => ({ label: f.id, description: `${f.count} model${f.count === 1 ? '' : 's'}`, id: f.id })),
				{ title: 'Vendor', placeHolder: 'Search vendors…' },
			);
			return vendor ? { ...current, family: current.family === vendor.id ? undefined : vendor.id } : current;
		}
		if (choice.id === 'tools') { return { ...current, toolsOnly: !current.toolsOnly }; }
		if (choice.id === 'free') { return { ...current, freeOnly: !current.freeOnly }; }
		return { ...current, visionOnly: !current.visionOnly };
	}

	/** Switches mode, showing the warning the first time bypass is turned on. Returns false if declined. */
	async setMode(mode: PermissionMode): Promise<boolean> {
		if (!await this.confirmBypass(mode)) {
			this.fire();
			return false;
		}
		// Keep elevated permissions scoped to this workspace, not every project the user opens.
		await this.context.workspaceState.update(MODE_STATE, mode);
		this.currentMode = mode;
		this.fire();
		return true;
	}

	async confirmBypass(mode: PermissionMode): Promise<boolean> {
		if (mode !== 'bypassPermissions' || this.context.globalState.get(BYPASS_ACK_STATE)) { return true; }
		const enable = 'Enable Bypass';
		const choice = await vscode.window.showWarningMessage(
			'Bypass permissions lets the agent edit any file and run any command with no prompts, including outside this workspace. A malicious file or web page could steer it. Use it only in a sandbox or a project you can restore.',
			{ modal: true },
			enable,
		);
		if (choice !== enable) { return false; }
		await this.context.globalState.update(BYPASS_ACK_STATE, true);
		return true;
	}

	async pickMode(): Promise<void> {
		const picked = await vscode.window.showQuickPick(
			PERMISSION_MODES.map(m => ({ label: m.label, description: m.id === this.mode ? 'current' : undefined, detail: m.detail, id: m.id })),
			{ title: 'Permission Mode' },
		);
		if (picked) { await this.setMode(picked.id); }
	}

	async showCredits(): Promise<void> {
		const credits = this.credits;
		const buy = 'Add Credits';
		const refresh = 'Refresh';
		const choice = await vscode.window.showInformationMessage(`${credits.label}. ${credits.detail}`, buy, refresh);
		if (choice === buy) { await this.openSubscriptionPage(); }
		if (choice === refresh) { await this.refreshLiveCredits(); }
	}

	private async recordCost(cost: number, id: string): Promise<void> {
		const update = async () => {
			if (!this.creditGuard.matches(id)) { return; }
			const before = this.credits.level;
			await this.context.globalState.update(SPEND_STATE, addSpend(this.context.globalState.get<SpendRecord>(SPEND_STATE), cost, new Date(), id));
			if (!this.creditGuard.matches(id)) { return; }
			this.fire();
			const after = this.credits;
			if (after.level !== before && after.level !== 'ok') {
				const buy = 'Get More';
				void vscode.window.showWarningMessage(`OpenRouter Client credits: ${after.label}. ${after.detail}`, buy)
					.then(choice => { if (choice) { void this.openSubscriptionPage(); } });
			}
		};
		this.spendUpdates = this.spendUpdates.then(update, update);
		await this.spendUpdates;
	}

	private clearCreditTimers(): void {
		for (const timer of this.creditRefreshTimers) { clearTimeout(timer); }
		this.creditRefreshTimers = [];
	}

	/** Poll during a burst too, since the gateway can settle usage late. */
	private scheduleCreditRefresh(): void {
		if (this.creditRefreshTimers.length) { return; }
		for (const delay of CREDIT_REFRESH_DELAYS_MS) {
			const timer = setTimeout(() => {
				this.creditRefreshTimers = this.creditRefreshTimers.filter(t => t !== timer);
				void this.refreshLiveCredits();
			}, delay);
			this.creditRefreshTimers.push(timer);
		}
	}

	private async keyChanged(): Promise<void> {
		this.clearCreditTimers();
		const generation = this.creditGuard.reset();
		this.creditConnection = undefined;
		this.liveLimit = undefined;
		this.fire();
		const apiKey = await this.getApiKey();
		if (!this.creditGuard.isCurrent(undefined, generation)) { return; }
		this.keyPresent = !!apiKey;
		this.creditConnection = apiKey ? connectionId(apiKey, this.baseUrl) : undefined;
		this.creditGuard.reset(this.creditConnection);
		this.cachedModels = undefined;
		this.keyHealth = 'unknown';
		this.modelsChanged.fire();
		await this.refreshLiveCredits();
		this.fire();
	}

	private fire(): void {
		this.renderStatus();
		this.changed.fire();
	}

	private renderStatus(): void {
		const bypass = this.currentMode === 'bypassPermissions';
		if (!this.keyPresent) {
			this.status.text = '$(key) OpenRouter Client: add API key';
			this.status.command = 'openrouter.setApiKey';
			this.status.backgroundColor = undefined;
			this.status.tooltip = 'Enter your OpenRouter API key';
		} else {
			const credits = this.credits;
			this.status.text = `${bypass ? '$(warning)' : '$(sparkle)'} OpenRouter Client ${credits.label}`;
			this.status.command = 'openrouter.showCredits';
			// Red is only for a real credit problem; bypass mode just gets the warning icon.
			this.status.backgroundColor = credits.level === 'empty'
				? new vscode.ThemeColor('statusBarItem.errorBackground')
				: credits.level === 'low' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
			this.status.tooltip = `${this.model} · ${this.currentMode}\n${credits.detail}`;
		}
		this.status.show();
	}
}
