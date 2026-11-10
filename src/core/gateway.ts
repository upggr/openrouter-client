import { randomBytes } from 'node:crypto';
import { byteSize, fitRequestSize, MAX_REQUEST_BYTES } from './requestSize';
import { ChatRequest, ChatStreamer, ModelInfo, StreamEvent, ToolCall, Usage } from './types';

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api';

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const AUTO_MODEL = 'openrouter/auto';
const DEFAULT_IDLE_TIMEOUT_MS = 600_000;
/** A dependable, cheap, tool-capable model to fall back to when routing fails. */
const FAILOVER_MODEL = /^(deepseek|mistralai|google)\//i;
const MAX_RETRIES = 3;

export class GatewayError extends Error {
	constructor(message: string, readonly status?: number, readonly code?: string, readonly limitReached = false) {
		super(message);
		this.name = 'GatewayError';
	}
}

/** Remaining allowance on the account, from OpenRouter's credits API. */
export interface LiveLimit {
	limit: number;
	used: number;
	remaining: number;
	reached: boolean;
	period?: string;
	resetsAt?: string;
	/** ISO currency code; OpenRouter bills in USD. */
	currency?: string;
	/** Whether the figure describes this key's own cap or the whole account balance. */
	scope?: 'key' | 'account';
}

const SUSPENSION_MESSAGES: Record<string, string> = {
	KEY_DISABLED: 'This API key is disabled.',
};
const LIMIT_TEXT = /limit|budget|quota|spend.?cap|hard.?cap|insufficient|credit/i;

/** Returns a normalized base URL, refusing destinations that must never receive the key. */
export function normalizeBaseUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new GatewayError(`Invalid OpenRouter API URL: ${raw}`);
	}
	const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
		throw new GatewayError('The API URL must use https (http is allowed only for localhost).');
	}
	if (url.hostname === 'openrouter.com' || url.hostname.endsWith('.openrouter.com')) {
		throw new GatewayError('openrouter.com is not OpenRouter. The API is at https://openrouter.ai/api.');
	}
	return `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}`;
}

export interface GatewayOptions {
	baseUrl: string;
	apiKey: string;
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	/** Sent as X-Title so the account's activity page shows which app made the request. */
	appTitle?: string;
	/** Sent as HTTP-Referer, which OpenRouter uses for app attribution and rankings. */
	appUrl?: string;
	/** Kept for parity with the request surfaces; OpenRouter has no per-feature header. */
	feature?: string;
	/** How long a stream may stay completely silent before it counts as hung. */
	idleTimeoutMs?: number;
	/** Called for every completed request, whichever feature made it. */
	onUsage?: (usage: Usage) => void;
}

export class GatewayClient implements ChatStreamer {
	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly fetchImpl: typeof fetch;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly appTitle?: string;
	private readonly appUrl?: string;
	private readonly idleTimeoutMs: number;
	private readonly feature?: string;
	private readonly onUsage?: (usage: Usage) => void;
	/** Once automatic routing fails, later turns on this client skip straight to this model. */
	private failoverModel?: string;

	constructor(options: GatewayOptions) {
		this.baseUrl = normalizeBaseUrl(options.baseUrl);
		this.apiKey = options.apiKey;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
		this.appTitle = options.appTitle;
		this.appUrl = options.appUrl;
		this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
		this.feature = options.feature;
		this.onUsage = options.onUsage;
	}

	async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
		const response = await this.send('/v1/models', { method: 'GET', signal });
		const body = (await response.json()) as { data?: unknown[] };
		return (body.data ?? []).map(toModelInfo).filter((m): m is ModelInfo => m !== undefined);
	}

	/**
	 * Reads real spend from OpenRouter with the API key itself, so the credit figure
	 * is authoritative rather than a local estimate.
	 *
	 * A key can carry a spending cap that is larger than the credits left on the account,
	 * and either can stop a request first, so both are read and the smaller one wins.
	 */
	async getLiveLimit(signal?: AbortSignal): Promise<LiveLimit | undefined> {
		const [keyInfo, credits] = await Promise.all([
			this.readJson<{
				data?: {
					usage?: number; limit?: number | null; limit_remaining?: number | null;
					effective_budget?: { limit_usd?: number | null; spend_usd?: number | null; remaining_usd?: number | null; reset_interval?: string | null; resets_at?: string | null };
				};
			}>('/v1/key', signal),
			this.readJson<{ data?: { total_credits?: number; total_usage?: number } }>('/v1/credits', signal),
		]);
		const candidates: LiveLimit[] = [];
		const key = keyInfo?.data;
		// effective_budget already accounts for organisation guardrails, so prefer it over the flat fields.
		const budget = key?.effective_budget;
		const keyLimit = budget?.limit_usd ?? key?.limit;
		if (typeof keyLimit === 'number') {
			const used = budget?.spend_usd ?? key?.usage ?? 0;
			const remaining = budget?.remaining_usd ?? key?.limit_remaining ?? Math.max(keyLimit - used, 0);
			candidates.push({
				limit: keyLimit,
				used,
				remaining: Math.max(remaining, 0),
				reached: remaining <= 0,
				scope: 'key',
				currency: 'USD',
				period: budget?.reset_interval ?? undefined,
				resetsAt: budget?.resets_at ?? undefined,
			});
		}
		const total = credits?.data?.total_credits;
		const spent = credits?.data?.total_usage;
		if (typeof total === 'number' && typeof spent === 'number') {
			candidates.push({
				limit: total,
				used: spent,
				remaining: Math.max(total - spent, 0),
				reached: total - spent <= 0,
				scope: 'account',
				currency: 'USD',
			});
		}
		if (!candidates.length) { return undefined; }
		// Whichever has least left is the one that will actually stop the next request.
		return candidates.reduce((a, b) => (b.remaining < a.remaining ? b : a));
	}

	/** GETs JSON with the API key, returning undefined when the endpoint is unavailable. */
	private async readJson<T>(path: string, signal?: AbortSignal): Promise<T | undefined> {
		const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
			headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
			signal,
		});
		if (response.status === 401 || response.status === 403) {
			throw new GatewayError('OpenRouter rejected your API key.', response.status);
		}
		if (!response.ok) { return undefined; }
		return (await response.json().catch(() => undefined)) as T | undefined;
	}

	private postChat(request: ChatRequest, model: string, signal?: AbortSignal): Promise<Response> {
		const body: Record<string, unknown> = {
			model,
			messages: [],
			stream: true,
			stream_options: { include_usage: true },
			// OpenRouter only reports the real credit cost of a request when usage is requested.
			usage: { include: true },
		};
		if (request.tools?.length) {
			body.tools = request.tools;
			body.tool_choice = request.toolChoice ?? 'auto';
		}
		if (request.maxTokens) { body.max_tokens = request.maxTokens; }
		if (request.reasoningEffort) { body.reasoning_effort = request.reasoningEffort; }
		body.messages = fitRequestSize(request.messages, byteSize(body));
		const payload = JSON.stringify(body);
		const size = Buffer.byteLength(payload);
		if (size > MAX_REQUEST_BYTES) {
			throw new GatewayError(`This message is too large to send (${(size / 1_000_000).toFixed(1)} MB). Attach fewer or smaller files.`);
		}
		return this.send('/v1/chat/completions', {
			method: 'POST',
			// One key across retries, so a retried request is not billed twice.
			headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Idempotency-Key': uuidV7() },
			body: payload,
			signal,
		});
	}

	private async findFailoverModel(request: ChatRequest, signal?: AbortSignal): Promise<ModelInfo | undefined> {
		const models = await this.listModels(signal);
		return models.find(m => FAILOVER_MODEL.test(m.id) && (!request.tools?.length || m.supportsTools));
	}

	async *streamChat(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
		// Thinking models can be silent for minutes, so only a very long silence counts as a hang.
		const watchdog = new AbortController();
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const touch = () => {
			clearTimeout(timer);
			timer = setTimeout(() => { timedOut = true; watchdog.abort(); }, this.idleTimeoutMs);
		};
		const combined = signal ? AbortSignal.any([signal, watchdog.signal]) : watchdog.signal;
		touch();
		try {
			yield* this.streamOnce(request, combined, touch);
		} catch (error) {
			if (timedOut) {
				throw new GatewayError(`OpenRouter stopped responding for ${Math.round(this.idleTimeoutMs / 1000)} seconds. Send "continue" to try again.`);
			}
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	private async *streamOnce(request: ChatRequest, signal: AbortSignal, touch: () => void): AsyncGenerator<StreamEvent> {
		const model = request.model === AUTO_MODEL && this.failoverModel ? this.failoverModel : request.model;
		let response: Response;
		try {
			response = await this.postChat(request, model, signal);
		} catch (error) {
			if (model !== AUTO_MODEL || !isProviderRejection(error)) { throw error; }
			const fallback = await this.findFailoverModel(request, signal).catch(() => undefined);
			if (!fallback) { throw error; }
			this.failoverModel = fallback.id;
			yield { type: 'failover', model: fallback.id, name: fallback.name, contextWindow: fallback.contextWindow };
			response = await this.postChat(request, fallback.id, signal);
		}
		touch();
		if (!response.body) {
			throw new GatewayError('OpenRouter returned an empty response.');
		}
		const calls = new Map<number, ToolCall>();
		let reportedModel: string | undefined;
		for await (const data of readSse(response.body, signal)) {
			touch();
			if (data === '[DONE]') { break; }
			let chunk: GatewayChunk;
			try {
				chunk = JSON.parse(data) as GatewayChunk;
			} catch {
				continue;
			}
			if (chunk.error) {
				throw new GatewayError(this.redact(chunk.error.message ?? 'OpenRouter reported an error.'));
			}
			if (chunk.model && chunk.model !== reportedModel) {
				reportedModel = chunk.model;
				yield { type: 'routedModel', model: reportedModel };
			}
			const choice = chunk.choices?.[0];
			const delta = choice?.delta;
			if (delta?.content) { yield { type: 'text', text: delta.content }; }
			const reasoning = delta?.reasoning_content ?? delta?.reasoning;
			if (typeof reasoning === 'string' && reasoning) { yield { type: 'reasoning', text: reasoning }; }
			for (const part of delta?.tool_calls ?? []) {
				const index = part.index ?? 0;
				let call = calls.get(index);
				if (!call) {
					call = { id: '', type: 'function', function: { name: '', arguments: '' } };
					calls.set(index, call);
				}
				if (part.id && !call.id) { call.id = part.id; }
				if (part.function?.name && !call.function.name) { call.function.name = part.function.name; }
				if (part.function?.arguments) { call.function.arguments += part.function.arguments; }
			}
			if (chunk.usage) {
				const usage = toUsage(chunk.usage, chunk.model, chunk.provider);
				this.onUsage?.(usage);
				yield { type: 'usage', usage };
			}
			if (choice?.finish_reason) {
				for (const [index, call] of [...calls].sort((a, b) => a[0] - b[0])) {
					if (!call.id) { call.id = `call_${index}_${Math.random().toString(36).slice(2, 10)}`; }
					yield { type: 'tool_call', call };
				}
				calls.clear();
				yield { type: 'finish', reason: choice.finish_reason };
			}
		}
	}

	private async send(path: string, init: RequestInit): Promise<Response> {
		const headers: Record<string, string> = { ...(init.headers as Record<string, string>), Authorization: `Bearer ${this.apiKey}` };
		if (this.appTitle) { headers['X-Title'] = this.appTitle; }
		if (this.appUrl) { headers['HTTP-Referer'] = this.appUrl; }
		let freshKeyTried = false;
		for (let attempt = 0; ; attempt++) {
			let response: Response;
			try {
				response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
			} catch (error) {
				if (init.signal?.aborted) { throw error; }
				if (attempt >= MAX_RETRIES) {
					throw new GatewayError(`Could not reach OpenRouter: ${this.redact(String(error))}`);
				}
				await this.sleep(backoff(attempt));
				continue;
			}
			if (response.ok) { return response; }
			// The gateway also answers 401 when an idempotency key is reused, so a retry gets one fresh key.
			if (response.status === 401 && attempt > 0 && headers['Idempotency-Key'] && !freshKeyTried) {
				freshKeyTried = true;
				headers['Idempotency-Key'] = uuidV7();
				continue;
			}
			if (RETRYABLE.has(response.status) && attempt < MAX_RETRIES) {
				const text = await response.text().catch(() => '');
				if (response.status === 429 && LIMIT_TEXT.test(text)) { throw this.toError(response.status, text); }
				const retryAfter = Number(response.headers.get('retry-after'));
				await this.sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : backoff(attempt));
				continue;
			}
			throw this.toError(response.status, await response.text().catch(() => ''));
		}
	}

	private toError(status: number, text: string): GatewayError {
		const { code, message } = parseError(text);
		if (code && SUSPENSION_MESSAGES[code]) { return new GatewayError(SUSPENSION_MESSAGES[code], status, code); }
		if (status === 401) { return new GatewayError('OpenRouter rejected your API key (401). Run "OpenRouter: Set API Key".', status, code); }
		// OpenRouter answers 402 when credits run out; limit-flavoured 403/429 mean the same.
		const limitReached = status === 402 || ((status === 403 || status === 429) && LIMIT_TEXT.test(`${code ?? ''} ${message}`));
		if (limitReached) { return new GatewayError(`Your OpenRouter credits have run out. ${this.redact(message).slice(0, 300)}`.trim(), status, code, true); }
		return new GatewayError(`OpenRouter error ${status}: ${this.redact(message).slice(0, 500)}`, status, code);
	}

	private redact(text: string): string {
		return this.apiKey ? text.split(this.apiKey).join('***') : text;
	}
}

/** Automatic routing intermittently picks a provider that refuses the request. */
export function isProviderRejection(error: unknown): boolean {
	return error instanceof GatewayError && error.status === 400 && /model provider rejected/i.test(error.message);
}

function parseError(text: string): { code?: string; message: string } {
	try {
		const body = JSON.parse(text) as {
			error?: { code?: string; message?: string } | string;
			message?: string;
			details?: { code?: string; message?: string }[];
		};
		if (typeof body.error === 'string') { return { message: body.error }; }
		const detail = body.details?.[0];
		return { code: body.error?.code ?? detail?.code, message: body.error?.message ?? detail?.message ?? body.message ?? text };
	} catch {
		return { message: text };
	}
}

interface GatewayChunk {
	model?: string;
	/** Which upstream served the request, which matters when routing with auto. */
	provider?: string;
	error?: { message?: string };
	usage?: RawUsage;
	choices?: {
		finish_reason?: string | null;
		delta?: {
			content?: string | null;
			reasoning_content?: string | null;
			reasoning?: string | null;
			tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
		};
	}[];
}

interface RawUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	cost?: number;
	cache_read_input_tokens?: number;
	prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number; cache_creation_tokens?: number };
	completion_tokens_details?: { reasoning_tokens?: number };
}

function toUsage(raw: RawUsage, model?: string, provider?: string): Usage {
	return {
		promptTokens: raw.prompt_tokens ?? 0,
		completionTokens: raw.completion_tokens ?? 0,
		cost: raw.cost,
		cachedTokens: raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens,
		cacheWriteTokens: raw.prompt_tokens_details?.cache_write_tokens ?? raw.prompt_tokens_details?.cache_creation_tokens,
		reasoningTokens: raw.completion_tokens_details?.reasoning_tokens,
		model,
		provider,
	};
}

/** Kept for request identity across retries, so a retried request is not billed twice. */
export function uuidV7(now = Date.now()): string {
	const bytes = randomBytes(16);
	bytes.writeUIntBE(now, 0, 6);
	bytes[6] = (bytes[6] & 0x0f) | 0x70;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function backoff(attempt: number): number {
	return 500 * 2 ** attempt;
}

/** Yields the `data:` payload of each server-sent event. */
export async function* readSse(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	let buffer = '';
	let data: string[] = [];
	// A hung read must still unblock the moment the user stops the request.
	const onAbort = () => void reader.cancel().catch(() => undefined);
	signal?.addEventListener('abort', onAbort, { once: true });
	try {
		for (;;) {
			if (signal?.aborted) { return; }
			const { value, done } = await reader.read();
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			let newline: number;
			while ((newline = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, newline).replace(/\r$/, '');
				buffer = buffer.slice(newline + 1);
				if (line === '') {
					if (data.length) { yield data.join('\n'); data = []; }
				} else if (line.startsWith('data:')) {
					data.push(line.slice(5).replace(/^ /, ''));
				}
			}
			if (done) {
				if (buffer.startsWith('data:')) { data.push(buffer.slice(5).replace(/^ /, '')); }
				if (data.length) { yield data.join('\n'); }
				return;
			}
		}
	} finally {
		signal?.removeEventListener('abort', onAbort);
		// Not awaited: the gateway can end a stream with a malformed chunk, and cleanup must never block.
		void reader.cancel().catch(() => undefined);
	}
}

/** OpenRouter prices per token as decimal strings; "0" means free and "-1" means unknown. */
function perMillion(price: string | undefined): number | undefined {
	if (price === undefined) { return undefined; }
	const value = Number(price);
	if (!Number.isFinite(value) || value < 0) { return undefined; }
	return value * 1_000_000;
}

/** Benchmark indexes arrive as null when a model has not been scored. */
function score(value: number | null | undefined): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Modalities arrive lowercase ("text", "image"); the rest of the app expects upper case. */
function modalities(list: string[] | undefined, fallback: string[]): string[] {
	const mapped = list?.map(m => m.toUpperCase()).filter(Boolean);
	return mapped?.length ? mapped : fallback;
}

function toModelInfo(raw: unknown): ModelInfo | undefined {
	const m = raw as {
		id?: string; canonical_slug?: string; name?: string; description?: string;
		context_length?: number;
		architecture?: { input_modalities?: string[]; output_modalities?: string[]; modality?: string };
		top_provider?: { context_length?: number; max_completion_tokens?: number | null };
		pricing?: { prompt?: string; completion?: string };
		supported_parameters?: string[];
		expiration_date?: string | null;
		benchmarks?: { artificial_analysis?: { intelligence_index?: number | null; coding_index?: number | null; agentic_index?: number | null } | null } | null;
	};
	if (!m.id) { return undefined; }
	const params = m.supported_parameters ?? [];
	const aa = m.benchmarks?.artificial_analysis;
	const input = modalities(m.architecture?.input_modalities, ['TEXT']);
	const output = modalities(m.architecture?.output_modalities, ['TEXT']);
	// Only chat-style text output is usable here; image or audio generators are not.
	if (!output.includes('TEXT')) { return undefined; }
	const context = m.top_provider?.context_length ?? m.context_length ?? 128_000;
	return {
		id: m.id,
		name: m.name ?? m.id,
		// "anthropic/claude-3.5-sonnet" groups under its vendor, which is what the picker shows.
		family: (m.id.includes('/') ? m.id.split('/')[0] : m.id).toLowerCase(),
		description: m.description,
		contextWindow: context,
		maxOutputTokens: m.top_provider?.max_completion_tokens ?? Math.min(8_192, context),
		supportsTools: params.includes('tools'),
		supportsImages: input.includes('IMAGE'),
		reasoningEfforts: params.includes('reasoning_effort') ? ['low', 'medium', 'high'] : [],
		deprecatedAt: m.expiration_date ?? undefined,
		inputModalities: input,
		outputModalities: output,
		promptPricePerMillion: perMillion(m.pricing?.prompt),
		completionPricePerMillion: perMillion(m.pricing?.completion),
		intelligence: score(aa?.intelligence_index),
		codingScore: score(aa?.coding_index),
		agenticScore: score(aa?.agentic_index),
	};
}
