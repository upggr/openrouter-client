import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { compact, runAgent, withCacheMarkers, AgentEvent, PermissionAnswer } from '../core/agent';
import { buildAttachedContent, canReadImages, truncateAttachmentText } from '../core/attachments';
import { compactLimit, compactionCut, DEFAULT_OUTPUT_TOKENS, estimateTokens, keepTokensFor, outputTokenLimit, flattenForSummary, looksLikeOverflow, trimForRequest } from '../core/context';
import { addSpend, creditStatus, CreditRefreshGuard } from '../core/credits';
import { bestScore, blendedPrice, families, filterModels, formatContext, formatPrice, groupModels, isFree, priceVaries, sortModels } from '../core/modelPicker';
import { Checkpoints } from '../core/checkpoints';
import { LiveLimit } from '../core/gateway';
import { sessionToMarkdown } from '../core/exportChat';
import { GatewayClient, GatewayError, normalizeBaseUrl } from '../core/gateway';
import { addMemory, readMemory } from '../core/memory';
import { decide, PermissionMode, rememberKey, restorePermissionMode } from '../core/permissions';
import { buildSystemPrompt } from '../core/prompt';
import { newSession, SessionStore } from '../core/sessions';
import { findTool, globToRegExp, isSensitivePath, ToolContext } from '../core/tools';
import { ChatMessage, ChatStreamer, ContentPart, ModelInfo, StreamEvent, ToolCall } from '../core/types';
import { defaultKeyLabel, keyStates, maskKey } from '../core/keyring';
import { byteSize, fitRequestSize, MAX_REQUEST_BYTES } from '../core/requestSize';

const KEY = 'sk-or-v1-testkey';

function sse(res: ServerResponse, chunks: object[], headers: Record<string, string> = {}): void {
	res.writeHead(200, { 'Content-Type': 'text/event-stream', ...headers });
	for (const chunk of chunks) { res.write(`data: ${JSON.stringify(chunk)}\n\n`); }
	res.end('data: [DONE]\n\n');
}

let server: Server;
let base: string;
let handler: (req: IncomingMessage, res: ServerResponse) => void;

before(async () => {
	server = createServer((req, res) => handler(req, res));
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

const client = (extra = {}) => new GatewayClient({ baseUrl: base, apiKey: KEY, sleep: async () => undefined, ...extra });

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
	const out: StreamEvent[] = [];
	for await (const event of gen) { out.push(event); }
	return out;
}

test('base URL rules protect the key', () => {
	assert.equal(normalizeBaseUrl('https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api');
	assert.throws(() => normalizeBaseUrl('http://openrouter.ai/api'), GatewayError);
	assert.throws(() => normalizeBaseUrl('https://openrouter.com'), /not OpenRouter/);
	assert.equal(normalizeBaseUrl('http://localhost:4000'), 'http://localhost:4000');
});

test('assembles streamed tool calls whose id arrives only once', async () => {
	let auth: string | undefined;
	let title: string | undefined;
	let idempotency: string | undefined;
	let referer: string | undefined;
	handler = (req, res) => {
		auth = req.headers.authorization;
		title = req.headers['x-title'] as string;
		idempotency = req.headers['idempotency-key'] as string;
		referer = req.headers['http-referer'] as string;
		sse(res, [
			{ model: 'routed', choices: [{ delta: { content: 'Hi', tool_calls: [{ index: 0, id: 'a', function: { name: 'read_file', arguments: '' } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"x"}' } }] } }] },
			{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
			{ model: 'routed', choices: [{ delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 2, cost: 0.5 } },
		]);
	};
	const costs: number[] = [];
	const events = await collect(client({ appTitle: 'OpenRouter Client', appUrl: 'https://example.test', feature: 'sidebar', onUsage: (u: { cost: number }) => costs.push(u.cost) }).streamChat({ model: 'm', messages: [] }));
	assert.equal(auth, `Bearer ${KEY}`);
	assert.equal(title, 'OpenRouter Client');
	const call = events.find(e => e.type === 'tool_call') as { call: ToolCall };
	assert.deepEqual(call.call, { id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } });
	assert.deepEqual(costs, [0.5]);
	const usage = events.find(e => e.type === 'usage') as { usage: { model: string } };
	assert.equal(usage.usage.model, 'routed');
	assert.match(idempotency ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.equal(referer, 'https://example.test');
});

const REJECTED = JSON.stringify({ type: 'error', error: { message: 'The model provider rejected this request. Check the model, parameters and input size, then retry; if the problem persists, contact support with the correlation_id.', type: 'invalid_request_error', code: '400', correlation_id: 'x' } });
const text = { input_modalities: ['text'], output_modalities: ['text'] };
const FAILOVER_MODELS = { data: [
	{ id: 'anthropic/claude', name: 'Claude', architecture: text, supported_parameters: ['tools'] },
	{ id: 'deepseek/no-tools', name: 'No Tools', architecture: text, supported_parameters: [] },
	{ id: 'deepseek/v4-pro', name: 'DeepSeek V4 Pro', architecture: text, supported_parameters: ['tools'], top_provider: { context_length: 128000 } },
	{ id: 'deepseek/v4.1-flash', name: 'DeepSeek Flash', architecture: text, supported_parameters: ['tools'] },
] };
const TOOL = { type: 'function' as const, function: { name: 't', description: 'd', parameters: {} } };

function failoverGateway(models: object, rejection = REJECTED) {
	const used: string[] = [];
	handler = (req, res) => {
		if (req.method === 'GET') { res.end(JSON.stringify(models)); return; }
		let raw = '';
		req.on('data', c => { raw += c; });
		req.on('end', () => {
			const { model } = JSON.parse(raw) as { model: string };
			used.push(model);
			if (model === 'openrouter/auto') { res.writeHead(400).end(rejection); return; }
			sse(res, [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
		});
	};
	return used;
}

test('stream identifies routed models before output and without waiting for usage', async () => {
	handler = (_req, res) => sse(res, [
		{ model: 'vendor/model-a', choices: [{ delta: { content: 'hello' } }] },
		{ model: 'vendor/model-a', choices: [{ delta: { content: ' again' } }] },
		{ model: 'vendor/model-b', choices: [{ delta: { content: 'world' }, finish_reason: 'stop' }] },
	]);
	const events = await collect(client().streamChat({ model: 'openrouter/auto', messages: [] }));
	assert.deepEqual(events.filter(e => e.type === 'routedModel'), [
		{ type: 'routedModel', model: 'vendor/model-a' },
		{ type: 'routedModel', model: 'vendor/model-b' },
	]);
	assert.deepEqual(events[0], { type: 'routedModel', model: 'vendor/model-a' });
	assert.equal(events[1].type, 'text');
});

test('agent forwards routed model events to the UI', async () => {
	const { root, clean } = workspace();
	try {
		const events: AgentEvent[] = [];
		const stream = scripted([[{ type: 'routedModel', model: 'vendor/model-a' }, say('hello')]]);
		await runAgent(agentOptions(stream, root, 'default', 'deny', events));
		assert.deepEqual(events[0], { type: 'routedModel', model: 'vendor/model-a' });
	} finally { clean(); }
});

test('auto fails over to a tool-capable model and stays there', async () => {
	const used = failoverGateway(FAILOVER_MODELS);
	const c = client();
	const first = await collect(c.streamChat({ model: 'openrouter/auto', messages: [], tools: [TOOL] }));
	assert.deepEqual(first[0], { type: 'failover', model: 'deepseek/v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 128000 });
	assert.ok(first.some(e => e.type === 'text'));
	const second = await collect(c.streamChat({ model: 'openrouter/auto', messages: [], tools: [TOOL] }));
	assert.ok(!second.some(e => e.type === 'failover'));
	assert.deepEqual(used, ['openrouter/auto', 'deepseek/v4-pro', 'deepseek/v4-pro']);
});

test('no failover for a chosen model, another 400, or when no fallback exists', async () => {
	let used = failoverGateway(FAILOVER_MODELS);
	handler = (req, res) => { used.push('x'); req.resume(); res.writeHead(400).end(REJECTED); };
	await assert.rejects(collect(client().streamChat({ model: 'anthropic/claude', messages: [] })), /model provider rejected/);
	assert.deepEqual(used, ['x']);

	used = failoverGateway(FAILOVER_MODELS, JSON.stringify({ error: { message: 'messages is required' } }));
	await assert.rejects(collect(client().streamChat({ model: 'openrouter/auto', messages: [] })), /messages is required/);
	assert.deepEqual(used, ['openrouter/auto']);

	used = failoverGateway({ data: [{ id: 'anthropic/claude', architecture: text }] });
	await assert.rejects(collect(client().streamChat({ model: 'openrouter/auto', messages: [] })), /model provider rejected/);
	assert.deepEqual(used, ['openrouter/auto']);
});

test('the agent tells the user about a failover', async () => {
	const { root, clean } = workspace();
	try {
		const events: AgentEvent[] = [];
		const stream = scripted([[{ type: 'failover', model: 'd', name: 'DeepSeek', contextWindow: 1000 }, say('ok')]]);
		await runAgent(agentOptions(stream, root, 'default', 'allow', events));
		assert.ok(events.some(e => e.type === 'notice' && e.message.includes('DeepSeek')));
	} finally { clean(); }
});

test('retries keep the same idempotency key', async () => {
	const keys: unknown[] = [];
	handler = (req, res) => {
		keys.push(req.headers['idempotency-key']);
		if (keys.length < 2) { res.writeHead(502).end(); return; }
		sse(res, [{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }]);
	};
	await collect(client().streamChat({ model: 'm', messages: [] }));
	assert.equal(keys.length, 2);
	assert.equal(keys[0], keys[1]);
});

test('retries temporary failures and never leaks the key', async () => {
	let calls = 0;
	handler = (_req, res) => {
		calls++;
		if (calls < 3) { res.writeHead(503).end(); return; }
		res.writeHead(400).end(JSON.stringify({ error: { message: `bad ${KEY}` } }));
	};
	await assert.rejects(collect(client().streamChat({ model: 'm', messages: [] })), (e: GatewayError) => {
		assert.equal(calls, 3);
		assert.ok(!e.message.includes(KEY));
		return e.status === 400;
	});
});

test('a spending limit is not retried and is marked as reached', async () => {
	let calls = 0;
	handler = (_req, res) => { calls++; res.writeHead(429).end(JSON.stringify({ error: { code: 'SPEND_LIMIT_EXCEEDED', message: 'Budget hit' } })); };
	await assert.rejects(collect(client().streamChat({ model: 'm', messages: [] })), (e: GatewayError) => e.limitReached && calls === 1);
});

test('a 402 out of credits is reported as the limit being reached', async () => {
	// OpenRouter answers 402 when the account runs out, with no limit wording needed.
	let calls = 0;
	handler = (_req, res) => { calls++; res.writeHead(402).end(JSON.stringify({ error: { message: 'Insufficient credits' } })); };
	await assert.rejects(collect(client().streamChat({ model: 'm', messages: [] })), (e: GatewayError) => e.limitReached && calls === 1);
});

test('explains suspended keys', async () => {
	handler = (_req, res) => res.writeHead(403).end(JSON.stringify({ error: { code: 'KEY_DISABLED', type: 'permission_error', message: 'no' } }));
	await assert.rejects(collect(client().streamChat({ model: 'm', messages: [] })), /disabled/);
});

test('maps models and hides inactive ones', async () => {
	handler = (_req, res) => res.end(JSON.stringify({ data: [
		{
			id: 'anthropic/claude', name: 'Anthropic: Claude', context_length: 200000,
			architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
			top_provider: { context_length: 200000, max_completion_tokens: 8192 },
			pricing: { prompt: '0.000003', completion: '0.000015' },
			supported_parameters: ['tools', 'reasoning_effort'],
		},
		// Image generators have no text output and cannot be chatted with.
		{ id: 'vendor/painter', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
		{
			id: 'free/model', name: 'Free', context_length: 8000,
			architecture: { input_modalities: ['text'], output_modalities: ['text'] },
			pricing: { prompt: '0', completion: '0' }, supported_parameters: [],
			expiration_date: '2026-10-29',
		},
	] }));
	const models = await client().listModels();
	assert.deepEqual(models.map(m => m.id), ['anthropic/claude', 'free/model']);
	assert.equal(models[0].supportsImages, true);
	assert.equal(models[0].supportsTools, true);
	assert.equal(models[0].family, 'anthropic');
	assert.deepEqual(models[0].reasoningEfforts, ['low', 'medium', 'high']);
	// Prices arrive per token and are shown per million.
	assert.equal(models[0].promptPricePerMillion, 3);
	assert.equal(models[0].completionPricePerMillion, 15);
	assert.equal(models[1].supportsTools, false);
	assert.equal(models[1].promptPricePerMillion, 0);
	assert.equal(models[1].deprecatedAt, '2026-10-29');
});

test('rich usage details are read from the stream', async () => {
	handler = (_req, res) => sse(res, [
		{ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] },
		{ choices: [{ delta: {} }], usage: { prompt_tokens: 18, completion_tokens: 4, cost: 4.18e-6, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 12 }, completion_tokens_details: { reasoning_tokens: 3 } } },
	]);
	const events = await collect(client().streamChat({ model: 'm', messages: [] }));
	const usage = events.find(e => e.type === 'usage');
	assert.equal(usage?.type, 'usage');
	if (usage?.type === 'usage') {
		assert.equal(usage.usage.promptTokens, 18);
		assert.equal(usage.usage.completionTokens, 4);
		assert.equal(usage.usage.cost, 4.18e-6);
		assert.equal(usage.usage.cacheWriteTokens, 12);
		assert.equal(usage.usage.reasoningTokens, 3);
	}
});

/** Serves OpenRouter's two balance endpoints. */
function balanceGateway(key: object | null, credits: object | null) {
	const seen: string[] = [];
	handler = (req, res) => {
		seen.push(req.url ?? '');
		const body = req.url === '/v1/key' ? key : credits;
		if (!body) { res.writeHead(404).end('{}'); return; }
		res.end(JSON.stringify({ data: body }));
	};
	return seen;
}

test('reads the live balance with the API key', async () => {
	let auth: string | undefined;
	handler = (req, res) => {
		auth = req.headers.authorization;
		const body = req.url === '/v1/key'
			? { usage: 4, limit: 10, limit_remaining: 6 }
			: { total_credits: 100, total_usage: 1 };
		res.end(JSON.stringify({ data: body }));
	};
	const live = await client().getLiveLimit();
	assert.equal(auth, `Bearer ${KEY}`);
	assert.equal(live?.remaining, 6);
	assert.equal(live?.scope, 'key');
	assert.equal(creditStatus(undefined, 0, live).label, '$6.00 left');
	assert.equal(creditStatus(undefined, 0, live).live, true);
});

test('a key cap larger than the remaining credits does not overstate what is left', async () => {
	// Seen live: a $10 key cap on an account with only $5.10 of credits left.
	const seen = balanceGateway({ usage: 0, limit: 10, limit_remaining: 10 }, { total_credits: 80, total_usage: 74.9 });
	const live = await client().getLiveLimit();
	assert.deepEqual(seen.sort(), ['/v1/credits', '/v1/key']);
	assert.equal(live?.scope, 'account');
	assert.ok(Math.abs((live?.remaining ?? 0) - 5.1) < 1e-9);
});

test('prefers the effective budget, which includes organisation guardrails', async () => {
	balanceGateway(
		{ usage: 9, limit: 50, limit_remaining: 41, effective_budget: { limit_usd: 20, spend_usd: 9, remaining_usd: 11, reset_interval: 'monthly', resets_at: '2026-12-01T00:00:00Z' } },
		{ total_credits: 500, total_usage: 9 },
	);
	const live = await client().getLiveLimit();
	assert.equal(live?.scope, 'key');
	assert.equal(live?.remaining, 11);
	assert.equal(live?.period, 'monthly');
	assert.equal(live?.resetsAt, '2026-12-01T00:00:00Z');
});

test('falls back to the account balance when the key has no limit of its own', async () => {
	balanceGateway({ usage: 4, limit: null }, { total_credits: 25, total_usage: 10 });
	const live = await client().getLiveLimit();
	assert.equal(live?.remaining, 15);
	assert.equal(live?.scope, 'account');
});

test('a key with a cap still reports when the balance endpoint is unavailable', async () => {
	balanceGateway({ usage: 1, limit: 10, limit_remaining: 9 }, null);
	const live = await client().getLiveLimit();
	assert.equal(live?.scope, 'key');
	assert.equal(live?.remaining, 9);
});

test('local credits reset each month and show what is left', () => {
	const october = new Date('2026-10-31T12:00:00Z');
	const november = new Date('2026-11-01T12:00:00Z');
	const record = addSpend(addSpend(undefined, 1, october), 2, october);
	assert.equal(record.total, 3);
	assert.equal(addSpend(record, 1, november).total, 1);
	// Locally counted totals are labelled as estimates, since they read a little high.
	assert.equal(creditStatus(record, 5, undefined, october).label, '~$2.00 left (est.)');
	assert.equal(creditStatus(record, 3, undefined, october).level, 'empty');
	assert.equal(creditStatus(record, 0, undefined, october).label, '~$3.00 this month');
	assert.equal(creditStatus(record, 5, undefined, november).label, '~$5.00 left (est.)');
	assert.match(creditStatus(record, 0, undefined, october).detail, /counted on this computer/);
});

test('local spend is tracked per key so a key switch does not mix accounts', () => {
	const now = new Date('2026-11-08T12:00:00Z');
	const firstKey = addSpend(addSpend(undefined, 10, now, 'sk-or-v1-'), 5, now, 'sk-or-v1-');
	assert.equal(firstKey.total, 15);
	// The same record read as another key shows nothing, and a spend on the other key starts over.
	assert.equal(creditStatus(firstKey, 0, undefined, now, 'sk-pax9-').label, '~$0.00 this month');
	assert.equal(addSpend(firstKey, 2, now, 'sk-pax9-').total, 2);
	assert.equal(creditStatus(firstKey, 0, undefined, now, 'sk-or-v1-').label, '~$15.00 this month');
});

test('live limits show the reported currency', () => {
	const live: LiveLimit = { limit: 20, used: 10.29, remaining: 9.71, reached: false, period: 'monthly', currency: 'EUR' };
	assert.equal(creditStatus(undefined, 0, live).label, '€9.71 left');
	assert.match(creditStatus(undefined, 0, live).detail, /€10\.29 used of €20\.00/);
});

test('permission preferences restore per workspace without bypassing consent', () => {
	for (const mode of ['default', 'acceptEdits', 'plan', 'bypassPermissions']) {
		assert.equal(restorePermissionMode(mode, 'default', true), mode);
	}
	assert.equal(restorePermissionMode('bypassPermissions', 'default', false), 'default');
	assert.equal(restorePermissionMode(undefined, 'bypassPermissions', false), 'default');
	assert.equal(restorePermissionMode(undefined, 'plan', true), 'plan');
	assert.equal(restorePermissionMode('invalid', 'acceptEdits', true), 'acceptEdits');
	assert.equal(restorePermissionMode('toString', 'invalid', true), 'default');
	assert.equal(restorePermissionMode(undefined, undefined, true), 'default', 'another workspace does not inherit bypass');
});

test('permission policy', () => {
	const expected: [PermissionMode, Parameters<typeof decide>[1], string][] = [
		['default', 'read', 'allow'], ['default', 'edit', 'ask'], ['default', 'execute', 'ask'], ['default', 'sensitiveRead', 'ask'],
		['acceptEdits', 'edit', 'allow'], ['acceptEdits', 'sensitiveEdit', 'ask'], ['acceptEdits', 'execute', 'ask'],
		['plan', 'read', 'allow'], ['plan', 'edit', 'deny'], ['plan', 'sensitiveEdit', 'deny'], ['plan', 'execute', 'deny'],
		['bypassPermissions', 'execute', 'allow'], ['bypassPermissions', 'sensitiveEdit', 'allow'],
	];
	for (const [mode, kind, decision] of expected) { assert.equal(decide(mode, kind), decision, `${mode}/${kind}`); }
	assert.equal(rememberKey('run_command', { command: 'git status' }), 'run_command:git status');
	assert.equal(rememberKey('edit_file', { path: './a' }, 'edit'), 'edit_file:edit:a');
	assert.notEqual(rememberKey('edit_file', { path: 'a' }, 'edit'), rememberKey('edit_file', { path: 'b' }, 'edit'));
	assert.notEqual(rememberKey('edit_file', { path: 'a' }, 'edit'), rememberKey('edit_file', { path: 'a' }, 'sensitiveEdit'));
});

test('sensitive path detection', () => {
	for (const p of ['.env', 'a/.env.local', 'id_rsa', 'x/server.pem', '/home/me/.ssh/config', '.npmrc']) { assert.ok(isSensitivePath(p), p); }
	for (const p of ['.env.example', 'src/index.ts', 'keyboard.ts']) { assert.ok(!isSensitivePath(p), p); }
});

test('live credit balance stays authoritative and local request costs are labelled separately', () => {
	const live: LiveLimit = { limit: 10, used: 4, remaining: 6, reached: false, scope: 'account', currency: 'USD' };
	const now = new Date('2026-11-08T12:00:00Z');
	const record = addSpend(undefined, 0.25, now, 'connection-a');
	const status = creditStatus(record, 0, live, now, 'connection-a');
	assert.equal(status.label, '$6.00 left');
	assert.match(status.detail, /this computer: ~\$0\.2500 in reported request costs/);
	assert.doesNotMatch(creditStatus(record, 0, live, now, 'connection-b').detail, /this computer/);
});

test('credit refresh guard ignores stale responses and old connections', () => {
	const guard = new CreditRefreshGuard();
	guard.reset('connection-a');
	const first = guard.begin('connection-a')!;
	const second = guard.begin('connection-a')!;
	assert.equal(guard.isCurrent('connection-a', first), false);
	assert.equal(guard.isCurrent('connection-a', second), true);
	guard.reset('connection-b');
	assert.equal(guard.matches('connection-a'), false);
	assert.equal(guard.begin('connection-a'), undefined);
	assert.equal(guard.isCurrent('connection-a', second), false);
	assert.equal(guard.matches('connection-b'), true);
});

test('glob matching', () => {
	assert.ok(globToRegExp('src/**/*.ts').test('src/a/b.ts'));
	assert.ok(globToRegExp('src/**/*.ts').test('src/b.ts'));
	assert.ok(globToRegExp('*.{js,ts}').test('a.ts'));
	assert.ok(!globToRegExp('*.ts').test('a/b.ts'));
});

function workspace(): { root: string; ctx: ToolContext; clean: () => void } {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'OpenRouter Client-test-')));
	return { root, ctx: { root, allowOutsideWorkspace: false, commandTimeoutSeconds: 5 }, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const tool = (name: string) => findTool(name)!;

test('workspace boundary blocks traversal and symlinks', async () => {
	const { root, ctx, clean } = workspace();
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'OpenRouter Client-out-'));
	try {
		fs.writeFileSync(path.join(outside, 's.txt'), 'secret');
		fs.symlinkSync(outside, path.join(root, 'link'));
		fs.symlinkSync(path.join(outside, 'missing-target.txt'), path.join(root, 'dangling'));
		await assert.rejects(tool('read_file').run({ path: '../x' }, ctx), /outside the workspace/);
		await assert.rejects(tool('read_file').run({ path: 'link/s.txt' }, ctx), /outside the workspace/);
		await assert.rejects(tool('write_file').run({ path: 'link/new.txt', content: 'x' }, ctx), /outside the workspace/);
		await assert.rejects(tool('write_file').run({ path: 'dangling', content: 'x' }, ctx), /outside the workspace/);
		assert.ok(!fs.existsSync(path.join(outside, 'missing-target.txt')));
		assert.match(await tool('read_file').run({ path: path.join(outside, 's.txt') }, { ...ctx, allowOutsideWorkspace: true }), /secret/);
	} finally {
		clean();
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test('edit requires a unique match', async () => {
	const { root, ctx, clean } = workspace();
	try {
		fs.writeFileSync(path.join(root, 'a.txt'), 'x x y');
		await assert.rejects(tool('edit_file').run({ path: 'a.txt', old_string: 'x', new_string: 'z' }, ctx), /2 times/);
		await assert.rejects(tool('edit_file').run({ path: 'a.txt', old_string: 'q', new_string: 'z' }, ctx), /not found/);
		await tool('edit_file').run({ path: 'a.txt', old_string: 'x', new_string: 'z', replace_all: true }, ctx);
		assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'z z y');
	} finally { clean(); }
});

test('search skips secrets and dependency folders', async () => {
	const { root, ctx, clean } = workspace();
	try {
		fs.writeFileSync(path.join(root, '.env'), 'NEEDLE=1');
		fs.symlinkSync('.env', path.join(root, 'alias.txt'));
		fs.mkdirSync(path.join(root, '.ssh'));
		fs.writeFileSync(path.join(root, '.ssh', '.env.example'), 'NEEDLE=2');
		fs.symlinkSync('.ssh', path.join(root, 'sshdir'), 'dir');
		fs.writeFileSync(path.join(root, 'a.ts'), 'NEEDLE');
		fs.mkdirSync(path.join(root, 'node_modules'));
		fs.writeFileSync(path.join(root, 'node_modules', 'b.ts'), 'NEEDLE');
		assert.equal(await tool('search_text').run({ pattern: 'NEEDLE' }, ctx), 'a.ts:1:NEEDLE');
		assert.equal(await tool('search_text').run({ pattern: 'NEEDLE', path: 'sshdir' }, ctx), 'No matches.');
	} finally { clean(); }
});

test('commands report exit codes, time out and hide the API key', async () => {
	const { ctx, clean } = workspace();
	process.env.OPENROUTER_API_KEY = KEY;
	try {
		assert.match(await tool('run_command').run({ command: 'echo hi; exit 3' }, ctx), /hi\s+Exit code 3/);
		assert.match(await tool('run_command').run({ command: 'sleep 5', timeout_seconds: 0.2 }, ctx), /Timed out/);
		assert.ok(!(await tool('run_command').run({ command: 'echo "[$OPENROUTER_API_KEY]"' }, ctx)).includes(KEY));
	} finally {
		delete process.env.OPENROUTER_API_KEY;
		clean();
	}
});

test('editing .vscode or secrets is classed as sensitive, including case variants', async () => {
	const { ctx, clean } = workspace();
	try {
		for (const p of ['.vscode/tasks.json', '.VSCode/tasks.json', '.GIT/hooks/pre-commit', '.git/hooks/pre-commit']) {
			assert.equal(await tool('write_file').kind({ path: p }, ctx), 'sensitiveEdit', p);
			assert.equal(await tool('edit_file').kind({ path: p }, ctx), 'sensitiveEdit', p);
		}
		assert.equal(await tool('read_file').kind({ path: '.env' }, ctx), 'sensitiveRead');
		assert.equal(await tool('write_file').kind({ path: 'src/a.ts' }, ctx), 'edit');
		assert.equal(await tool('read_file').kind({ path: '.AWS/config' }, ctx), 'sensitiveRead');
	} finally { clean(); }
});

test('sensitive classification follows symlinks to files and existing parent directories', async () => {
	const { root, ctx, clean } = workspace();
	try {
		fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
		fs.writeFileSync(path.join(root, '.env'), 'SECRET=private');
		fs.symlinkSync('.env', path.join(root, 'notes.md'));
		fs.symlinkSync('.git', path.join(root, 'hooksdir'), 'dir');
		// A dangling link is judged by where a write through it would land.
		fs.symlinkSync('credentials.json', path.join(root, 'todo.txt'));
		assert.equal(await tool('read_file').kind({ path: 'notes.md' }, ctx), 'sensitiveRead');
		for (const name of ['write_file', 'edit_file']) {
			assert.equal(await tool(name).kind({ path: 'notes.md' }, ctx), 'sensitiveEdit');
			assert.equal(await tool(name).kind({ path: 'hooksdir/hooks/new-hook' }, ctx), 'sensitiveEdit');
			assert.equal(await tool(name).kind({ path: 'todo.txt' }, ctx), 'sensitiveEdit');
		}
	} finally { clean(); }
});

function scripted(turns: StreamEvent[][]): ChatStreamer & { requests: ChatMessage[][] } {
	const requests: ChatMessage[][] = [];
	return {
		requests,
		async *streamChat(request) {
			requests.push(request.messages.map(m => ({ ...m })));
			for (const event of turns[requests.length - 1] ?? []) { yield event; }
		},
	};
}

const call = (id: string, name: string, args: object): StreamEvent => ({ type: 'tool_call', call: { id, type: 'function', function: { name, arguments: JSON.stringify(args) } } });
const say = (text: string): StreamEvent => ({ type: 'text', text });

function agentOptions(stream: ChatStreamer, root: string, mode: PermissionMode, answer: PermissionAnswer, sink: AgentEvent[], messages: ChatMessage[] = [{ role: 'user', content: 'go' }]) {
	return {
		client: stream, model: 'm', systemPrompt: 's', messages, root, commandTimeoutSeconds: 5, maxTurns: 5,
		getMode: () => mode, requestPermission: async () => answer, onEvent: (e: AgentEvent) => sink.push(e),
	};
}

test('agent asks in default mode, runs the tool and feeds back the result', async () => {
	const { root, clean } = workspace();
	try {
		const stream = scripted([[call('1', 'write_file', { path: 'n.txt', content: 'v' })], [say('done')]]);
		const events: AgentEvent[] = [];
		await runAgent(agentOptions(stream, root, 'default', 'allow', events));
		assert.equal(fs.readFileSync(path.join(root, 'n.txt'), 'utf8'), 'v');
		assert.equal(stream.requests[1].at(-1)?.role, 'tool');
		assert.equal(stream.requests[1].at(-1)?.tool_call_id, '1');
		assert.ok(events.some(e => e.type === 'toolEnd' && e.ok));
	} finally { clean(); }
});

test('the agent can spawn a sub-agent that runs tools and returns a result', async () => {
	const { root, clean } = workspace();
	try {
		const events: AgentEvent[] = [];
		let subRan = false;
		const stream: ChatStreamer = {
			async *streamChat(request) {
				const last = request.messages.at(-1);
				const lastText = last && typeof last.content === 'string' ? last.content : '';
				// The sub-agent's fresh conversation carries the task as its only user message.
				if (last?.role === 'user' && lastText.includes('read note.txt')) {
					subRan = true;
					yield call('s1', 'read_file', { path: 'note.txt' });
					return;
				}
				if (last?.role === 'tool' && last.tool_call_id === 's1') {
					yield say('The file says hello.');
					return;
				}
				// Main agent: spawn the sub-agent once, then finish.
				if (last?.role === 'user') {
					yield call('m1', 'spawn_agent', { task: 'read note.txt and report it', name: 'read note' });
					return;
				}
				yield say('main done');
			},
		};
		fs.writeFileSync(path.join(root, 'note.txt'), 'hello');
		// Depth 1 lets the main agent spawn but stops the sub-agent from nesting further.
		const opts = { ...agentOptions(stream, root, 'default', 'allow', events), spawnDepth: 1 };
		await runAgent(opts);
		assert.ok(subRan, 'sub-agent ran');
		const spawnEnd = events.find(e => e.type === 'toolEnd' && e.callId === 'm1') as { ok: boolean; output: string } | undefined;
		assert.ok(spawnEnd && spawnEnd.ok, 'spawn_agent succeeded');
		assert.match(spawnEnd?.output ?? '', /hello/, 'sub-agent result fed back to the main agent');
		// Sub-agent's inner tool calls are re-emitted namespaced under the parent call.
		assert.ok(events.some(e => e.type === 'toolStart' && String(e.callId).startsWith('m1:')), 'sub-agent activity surfaced');
	} finally { clean(); }
});

test('spawn_agent is refused when the depth limit is reached', async () => {
	const { root, clean } = workspace();
	try {
		const events: AgentEvent[] = [];
		const stream = scripted([[call('m1', 'spawn_agent', { task: 'x' })], [say('done')]]);
		const opts = { ...agentOptions(stream, root, 'default', 'allow', events), spawnDepth: 0 };
		await runAgent(opts);
		const spawnEnd = events.find(e => e.type === 'toolEnd' && e.callId === 'm1') as { ok: boolean; output: string } | undefined;
		assert.ok(spawnEnd && !spawnEnd.ok, 'refused at depth 0');
		assert.match(spawnEnd?.output ?? '', /disabled|nesting limit/);
	} finally { clean(); }
});

test('denied and plan-mode actions never touch the disk', async () => {
	const { root, clean } = workspace();
	try {
		await runAgent(agentOptions(scripted([[call('1', 'write_file', { path: 'a', content: 'v' })], [say('ok')]]), root, 'default', 'deny', []));
		await runAgent(agentOptions(scripted([[call('1', 'run_command', { command: 'touch b' })], [say('ok')]]), root, 'plan', 'allow', []));
		assert.deepEqual(fs.readdirSync(root), []);
	} finally { clean(); }
});

test('bypass mode never asks', async () => {
	const { root, clean } = workspace();
	try {
		const options = { ...agentOptions(scripted([[call('1', 'run_command', { command: 'touch c' })], [say('ok')]]), root, 'bypassPermissions', 'deny', []), requestPermission: async (): Promise<PermissionAnswer> => { throw new Error('asked'); } };
		await runAgent(options);
		assert.deepEqual(fs.readdirSync(root), ['c']);
	} finally { clean(); }
});

test('an always answer for one command does not approve a different one', async () => {
	const { root, clean } = workspace();
	try {
		const asked: string[] = [];
		const stream = scripted([
			[call('1', 'run_command', { command: 'echo a' })],
			[call('2', 'run_command', { command: 'echo a' })],
			[call('3', 'run_command', { command: 'echo a; touch z' })],
			[say('ok')],
		]);
		await runAgent({ ...agentOptions(stream, root, 'default', 'always', []), requestPermission: async r => { asked.push(String(r.args.command)); return r.args.command === 'echo a' ? 'always' : 'deny'; } });
		assert.deepEqual(asked, ['echo a', 'echo a; touch z']);
		assert.deepEqual(fs.readdirSync(root), []);
	} finally { clean(); }
});

test('always approvals are scoped to a file and never skip sensitive edit consent', async () => {
	const { root, clean } = workspace();
	try {
		for (const name of ['write_file', 'edit_file']) {
			fs.writeFileSync(path.join(root, 'notes.txt'), 'old');
			fs.writeFileSync(path.join(root, 'other.txt'), 'old');
			const args = (p: string) => ({ path: p, content: 'new', old_string: 'old', new_string: 'new' });
			const stream = scripted([
				[call('1', name, args('notes.txt'))],
				[call('2', name, args('./notes.txt'))],
				[call('3', name, args('other.txt'))],
				[call('4', name, args('.git/hooks/pre-commit'))],
				[call('5', name, args('.env'))],
				[say('ok')],
			]);
			const asked: string[] = [];
			await runAgent({
				...agentOptions(stream, root, 'default', 'deny', []), maxTurns: 6,
				requestPermission: async r => {
					asked.push(String(r.args.path));
					return r.args.path === 'notes.txt' ? 'always' : 'deny';
				},
			});
			assert.deepEqual(asked, ['notes.txt', 'other.txt', '.git/hooks/pre-commit', '.env'], name);
			assert.equal(fs.readFileSync(path.join(root, 'other.txt'), 'utf8'), 'old');
			assert.ok(!fs.existsSync(path.join(root, '.env')));
			assert.ok(!fs.existsSync(path.join(root, '.git')));
		}
	} finally { clean(); }
});

test('sensitive reads and edits always need fresh approval, even for the same path', async () => {
	const { root, clean } = workspace();
	try {
		fs.writeFileSync(path.join(root, '.env'), 'SECRET=old');
		for (const name of ['read_file', 'write_file', 'edit_file']) {
			let asked = 0;
			const args = { path: '.env', content: 'SECRET=new', old_string: 'old', new_string: 'new' };
			const stream = scripted([[call('1', name, args)], [call('2', name, args)], [say('ok')]]);
			await runAgent({ ...agentOptions(stream, root, 'default', 'deny', []), requestPermission: async () => { asked++; return 'always'; } });
			assert.equal(asked, 2, name);
		}
	} finally { clean(); }
});

test('acceptEdits and plan mode require consent to access symlinked secrets', async () => {
	const { root, clean } = workspace();
	try {
		fs.writeFileSync(path.join(root, '.env'), 'SECRET=old');
		fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
		fs.symlinkSync('.env', path.join(root, 'notes.md'));
		fs.symlinkSync('.git', path.join(root, 'hooksdir'), 'dir');
		const asked: string[] = [];
		const stream = scripted([
			[call('1', 'read_file', { path: 'notes.md' })],
			[call('2', 'write_file', { path: 'hooksdir/hooks/new-hook', content: 'unapproved' })],
			[call('3', 'write_file', { path: '.GIT/hooks/new-hook', content: 'unapproved' })],
			[say('ok')],
		]);
		await runAgent({
			...agentOptions(stream, root, 'acceptEdits', 'deny', []),
			requestPermission: async r => { asked.push(r.kind); return 'deny'; },
		});
		assert.deepEqual(asked, ['sensitiveRead', 'sensitiveEdit', 'sensitiveEdit']);
		assert.ok(!fs.existsSync(path.join(root, '.git', 'hooks', 'new-hook')));
		const plan = scripted([[call('1', 'read_file', { path: 'notes.md' })], [say('ok')]]);
		await runAgent({
			...agentOptions(plan, root, 'plan', 'deny', []),
			requestPermission: async r => { asked.push(r.kind); return 'deny'; },
		});
		assert.equal(asked.at(-1), 'sensitiveRead');
		assert.ok(!JSON.stringify(plan.requests).includes('SECRET=old'));
	} finally { clean(); }
});

test('invalid tool arguments go back to the model and every call gets a result', async () => {
	const { root, clean } = workspace();
	try {
		const bad: StreamEvent = { type: 'tool_call', call: { id: '1', type: 'function', function: { name: 'read_file', arguments: '{oops' } } };
		const stream = scripted([[bad, call('2', 'nope', {})], [say('ok')]]);
		await runAgent(agentOptions(stream, root, 'default', 'allow', []));
		const tools = stream.requests[1].filter(m => m.role === 'tool');
		assert.deepEqual(tools.map(m => m.tool_call_id), ['1', '2']);
		assert.match(String(tools[0].content), /not valid JSON/);
	} finally { clean(); }
});

test('stopping mid-run still answers every tool call so history stays valid', async () => {
	const { root, clean } = workspace();
	try {
		const abort = new AbortController();
		const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
		const stream = scripted([[call('1', 'run_command', { command: 'echo a' }), call('2', 'run_command', { command: 'echo b' })]]);
		await runAgent({ ...agentOptions(stream, root, 'default', 'allow', [], messages), signal: abort.signal, requestPermission: async () => { abort.abort(); return 'deny'; } });
		assert.deepEqual(messages.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['1', '2']);
	} finally { clean(); }
});

test('context is summarized when nearly full', async () => {
	const { root, clean } = workspace();
	try {
		const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
		const stream = scripted([
			[call('1', 'list_files', {}), { type: 'usage', usage: { promptTokens: 90, completionTokens: 1 } }],
			[say('the summary')],
			[say('finished')],
		]);
		await runAgent({ ...agentOptions(stream, root, 'default', 'allow', [], messages), contextWindow: 100 });
		assert.match(String(messages[0].content), /the summary/);
		assert.equal(messages.at(-1)?.content, 'finished');
	} finally { clean(); }
});

test('a chat nearing the gateway size limit is summarized even with a huge context window', async () => {
	const { root, clean } = workspace();
	try {
		const big = 'w'.repeat(400_000);
		const messages: ChatMessage[] = [{ role: 'user', content: big }, { role: 'assistant', content: 'a' }, { role: 'user', content: big }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'latest' }];
		const events: AgentEvent[] = [];
		const stream = scripted([[say('the summary')], [say('finished')]]);
		await runAgent({ ...agentOptions(stream, root, 'default', 'allow', events, messages), contextWindow: 10_000_000 });
		assert.match(String(messages[0].content), /the summary/);
		assert.ok(events.some(e => e.type === 'compacted'));
		assert.ok(JSON.stringify(stream.requests[1]).length < 100_000);
		assert.equal(messages.at(-1)?.content, 'finished');
	} finally { clean(); }
});

test('a failed size summary still sends the request', async () => {
	const { root, clean } = workspace();
	try {
		const big = 'w'.repeat(400_000);
		const messages: ChatMessage[] = [{ role: 'user', content: big }, { role: 'assistant', content: 'a' }, { role: 'user', content: big }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'latest' }];
		const events: AgentEvent[] = [];
		const stream = scripted([[], [say('finished')]]);
		await runAgent({ ...agentOptions(stream, root, 'default', 'allow', events, messages), contextWindow: 10_000_000 });
		assert.ok(events.some(e => e.type === 'notice' && /Could not summarize/.test(e.message)));
		assert.equal(messages.at(-1)?.content, 'finished');
	} finally { clean(); }
});

const toolTurn = (id: string, name: string, args: object, output: string): ChatMessage[] => [
	{ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
	{ role: 'tool', tool_call_id: id, content: output },
];

test('an earlier read of the same file is dropped from the request but kept in the chat', () => {
	const messages: ChatMessage[] = [
		{ role: 'user', content: 'go' },
		...toolTurn('1', 'read_file', { path: 'a.ts' }, 'old content'),
		...toolTurn('2', 'read_file', { path: 'b.ts' }, 'other file'),
		...toolTurn('3', 'read_file', { path: 'a.ts' }, 'new content'),
	];
	const sent = trimForRequest(messages);
	assert.match(String(sent[2].content), /Superseded/);
	assert.equal(sent[4].content, 'other file');
	assert.equal(sent[6].content, 'new content');
	assert.equal(messages[2].content, 'old content');
});

test('old tool output is shortened past the limit and recent output is untouched', () => {
	const big = 'x'.repeat(40_000);
	const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
	for (let i = 0; i < 12; i++) { messages.push(...toolTurn(String(i), 'run_command', { command: `c${i}` }, big)); }
	const sent = trimForRequest(messages, 100_000);
	const tools = sent.filter(m => m.role === 'tool');
	assert.match(String(tools[0].content), /Older output removed/);
	assert.ok(tools.slice(-8).every(m => m.content === big));
	assert.ok(estimateTokens(sent) < estimateTokens(messages));
	assert.equal(messages[2].content, big);
	assert.ok(trimForRequest(messages, 1_000_000).filter(m => m.role === 'tool').every(m => m.content === big), 'large models keep everything until they are well filled');
});

test('compaction never starts the kept part on a tool result', () => {
	const big = 'y'.repeat(100_000);
	const messages: ChatMessage[] = [{ role: 'user', content: 'a' }, ...toolTurn('1', 'run_command', { command: 'x' }, big), { role: 'user', content: 'b' }, ...toolTurn('2', 'run_command', { command: 'y' }, 'small')];
	const cut = compactionCut(messages, 1_000);
	assert.notEqual(messages[cut].role, 'tool');
	assert.equal(cut, 3);
	assert.equal(compactionCut([{ role: 'user', content: 'only' }], 1_000), 0);
});

test('compaction keeps recent work, returns what it removed and sends no tool messages', async () => {
	const messages: ChatMessage[] = [{ role: 'user', content: 'first' }, ...toolTurn('1', 'run_command', { command: 'x' }, 'z'.repeat(100_000)), { role: 'user', content: 'latest' }];
	const stream = scripted([[say('short summary')]]);
	const removed = await compact({ client: stream, model: 'm', messages }, 1_000);
	assert.equal(removed.length, 3);
	assert.equal(messages.length, 2);
	assert.match(String(messages[0].content), /short summary/);
	assert.equal(messages[1].content, 'latest');
	assert.ok(stream.requests[0].every(m => m.role === 'user'));
	assert.deepEqual(await compact({ client: stream, model: 'm', messages: [{ role: 'user', content: 'x' }] }), []);
});

test('attachments are inlined as data, and an image is dropped with a note when the model cannot see it', () => {
	const files = [
		{ name: 'notes.txt', mime: 'text/plain', text: 'hello', truncated: false },
		{ name: 'shot.png', mime: 'image/png', dataUrl: 'data:image/png;base64,abc' },
	];
	const withVision = buildAttachedContent('look at this', files, true);
	assert.ok(Array.isArray(withVision));
	const textPart = (withVision as ContentPart[])[0];
	assert.equal(textPart.type, 'text');
	assert.match((textPart as { text: string }).text, /look at this/);
	assert.match((textPart as { text: string }).text, /Attached file notes\.txt:\nhello/);
	assert.match((textPart as { text: string }).text, /Attached image: shot\.png/);
	assert.deepEqual((withVision as ContentPart[])[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } });

	const withoutVision = buildAttachedContent('look at this', files, false);
	assert.equal(typeof withoutVision, 'string');
	assert.match(withoutVision as string, /was not sent because the current model cannot read images/);
});

test('canReadImages trusts the catalog first, then auto routing and known vision families', () => {
	assert.equal(canReadImages('claude-haiku-5-5', true), true);
	assert.equal(canReadImages('claude-haiku-5-5', false), true);
	assert.equal(canReadImages('auto', false), true);
	assert.equal(canReadImages('auto', undefined), true);
	assert.equal(canReadImages('mystery-model-9000', false), false);
	assert.equal(canReadImages('mystery-model-9000', undefined), false);
});

test('truncateAttachmentText caps long text and flags it', () => {
	assert.deepEqual(truncateAttachmentText('short'), { text: 'short', truncated: false });
	const long = truncateAttachmentText('x'.repeat(10), 4);
	assert.deepEqual(long, { text: 'xxxx', truncated: true });
});

test('checkpoints capture pre-edit content once and rewind restores it', async () => {
	const store = new Map<string, string>([['a.ts', 'old a'], ['b.ts', 'old b']]);
	const read = async (abs: string) => store.get(abs);
	const join = (_root: string, rel: string) => rel;
	const cp = new Checkpoints(read, join, '/r');
	await cp.capture('write_file', { path: 'a.ts' });
	await cp.capture('edit_file', { path: 'a.ts' }); // already captured, not overwritten
	await cp.capture('edit_file', { path: 'b.ts' });
	await cp.capture('read_file', { path: 'c.ts' }); // not an edit, ignored
	assert.equal(cp.count, 2);
	// Simulate the agent editing both files.
	store.set('a.ts', 'new a');
	store.set('b.ts', 'new b');
	const written: [string, string | undefined][] = [];
	const restored = await cp.rewind(async (abs, content) => { written.push([abs, content]); if (content === undefined) { store.delete(abs); } else { store.set(abs, content); } });
	assert.deepEqual(restored.sort(), ['a.ts', 'b.ts']);
	assert.equal(store.get('a.ts'), 'old a');
	assert.equal(store.get('b.ts'), 'old b');
	assert.equal(cp.count, 0, 'checkpoint cleared after rewind');
});

test('a new file captured by a checkpoint rewinds to deletion', async () => {
	const store = new Map<string, string>();
	const cp = new Checkpoints(async abs => store.get(abs), (_r, rel) => rel, '/r');
	await cp.capture('write_file', { path: 'fresh.ts' });
	store.set('fresh.ts', 'made by agent');
	await cp.rewind(async (abs, content) => { if (content === undefined) { store.delete(abs); } else { store.set(abs, content); } });
	assert.equal(store.has('fresh.ts'), false, 'new file removed on rewind');
});

test('checkpoints never read, restore or delete paths outside the workspace', async () => {
	const { root, clean } = workspace();
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'OpenRouter Client-cp-out-'));
	try {
		const target = path.join(outside, 'precious.txt');
		fs.writeFileSync(target, 'outside data');
		fs.symlinkSync(outside, path.join(root, 'escape'));
		fs.writeFileSync(path.join(root, 'inside.txt'), 'before');
		const read = async (abs: string) => fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : undefined;
		const cp = new Checkpoints(read, (r, rel) => path.join(r, rel), root);
		for (const bad of ['../outside/precious.txt', target, 'escape/precious.txt', 'escape/missing.txt', '.', '']) {
			await cp.capture('write_file', { path: bad });
		}
		assert.equal(cp.count, 0, 'escaping paths are ignored at capture time');

		await cp.capture('write_file', { path: 'inside.txt' });
		await cp.capture('edit_file', { path: './inside.txt' });
		assert.equal(cp.count, 1, 'equivalent paths collapse to one entry');
		// If the agent later swaps a captured file for a symlink outside, rewind skips it.
		fs.unlinkSync(path.join(root, 'inside.txt'));
		fs.symlinkSync(target, path.join(root, 'inside.txt'));
		const restored = await cp.rewind(async (abs, content) => {
			if (content === undefined) { fs.rmSync(abs, { force: true }); } else { fs.writeFileSync(abs, content); }
		});
		assert.deepEqual(restored, []);
		assert.equal(fs.readFileSync(target, 'utf8'), 'outside data');
	} finally {
		clean();
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test('beforeToolRun runs only after approval, so denied or escaped calls are not snapshotted', async () => {
	const { root, clean } = workspace();
	try {
		const captured: string[] = [];
		const stream = scripted([
			[call('1', 'write_file', { path: 'denied.txt', content: 'x' })],
			[call('2', 'write_file', { path: 'allowed.txt', content: 'x' })],
			[say('done')],
		]);
		await runAgent({
			...agentOptions(stream, root, 'default', 'deny', []),
			requestPermission: async r => r.args.path === 'allowed.txt' ? 'allow' : 'deny',
			beforeToolRun: async (_tool, args) => { captured.push(String(args.path)); },
		});
		assert.deepEqual(captured, ['allowed.txt']);
	} finally { clean(); }
});

test('key masking shows just enough to tell keys apart', () => {
	assert.equal(maskKey('sk-or-v1-1b8260744efa9a734dae8c78aada785d'), 'sk-or-v1-…785d');
	assert.equal(maskKey('short'), '••••');
	assert.equal(defaultKeyLabel('sk-or-v1-209d7b92e43c4a8ea77964fd0e6d3d28'), 'sk-or-v1-…3d28');
});

test('oversized requests give up old images first and keep the newest that fit', () => {
	const image = (kb: number): ChatMessage => ({ role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'd'.repeat(kb * 1000) } }] });
	const history: ChatMessage[] = [{ role: 'system', content: 'sys' }, image(600), { role: 'assistant', content: 'ok' }, image(500), { role: 'user', content: '?' }];
	const small: ChatMessage[] = [{ role: 'user', content: 'hi' }];
	assert.equal(fitRequestSize(small), small, 'small requests pass through');
	const fitted = fitRequestSize(history);
	assert.ok(byteSize(fitted) <= MAX_REQUEST_BYTES);
	assert.match(JSON.stringify(fitted[1]), /removed/);
	assert.ok(JSON.stringify(fitted[3]).includes('ddd'), 'the newer image still fits');
	assert.ok(JSON.stringify(history[1]).includes('ddd'), 'the stored chat is untouched');
});

test('oversized requests drop whole old turns so tool results keep their calls', () => {
	const call = { id: 'c', type: 'function' as const, function: { name: 'x', arguments: '{}' } };
	const big = 'y'.repeat(300_000);
	const history: ChatMessage[] = [{ role: 'system', content: 'sys' }];
	for (let i = 0; i < 6; i++) {
		history.push({ role: 'user', content: big }, { role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: 'c', content: 'r' });
	}
	history.push({ role: 'user', content: 'latest' });
	const fitted = fitRequestSize(history);
	assert.ok(byteSize(fitted) <= MAX_REQUEST_BYTES);
	assert.equal(fitted[0].role, 'system');
	assert.equal(fitted[1].role, 'user');
	assert.equal(fitted.at(-1)?.content, 'latest');
});

test('a retry refused for a reused idempotency key is sent once more with a fresh key', async () => {
	const keys: string[] = [];
	const replies = [503, 401, 200];
	const fetchImpl = (async (_url: string, init: RequestInit) => {
		keys.push((init.headers as Record<string, string>)['Idempotency-Key']);
		const status = replies.shift() ?? 401;
		return new Response(status === 200 ? 'data: [DONE]\n\n' : '{}', { status });
	}) as unknown as typeof fetch;
	for await (const event of client({ fetchImpl }).streamChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })) { assert.ok(event); }
	assert.equal(keys.length, 3);
	assert.equal(keys[0], keys[1], 'a normal retry keeps its key so it is not billed twice');
	assert.notEqual(keys[1], keys[2]);
});

test('the gateway never receives a request over the size limit', async () => {
	const bodies: string[] = [];
	const fetchImpl = (async (_url: string, init: RequestInit) => {
		bodies.push(String(init.body));
		return new Response('data: [DONE]\n\n', { status: 200 });
	}) as unknown as typeof fetch;
	const client = new GatewayClient({ baseUrl: 'https://openrouter.ai/api', apiKey: KEY, fetchImpl });
	const old: ChatMessage = { role: 'user', content: 'z'.repeat(800_000) };
	for await (const event of client.streamChat({ model: 'm', messages: [old, { role: 'assistant', content: 'a' }, { ...old }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'now' }] })) { assert.ok(event); }
	assert.ok(Buffer.byteLength(bodies[0]) <= MAX_REQUEST_BYTES);
	assert.ok(bodies[0].includes('"now"'));
	const consume = async () => { for await (const event of client.streamChat({ model: 'm', messages: [{ role: 'user', content: 'z'.repeat(2_000_000) }] })) { assert.ok(event); } };
	await assert.rejects(consume, /too large to send/);
	assert.equal(bodies.length, 1, 'an impossible request is not sent');
});

test('key states for the chat view never carry the key itself', () => {
	const key = 'sk-or-v1-0000000000000000000000000000abcd';
	const states = keyStates([{ id: '1', label: 'Work', gateway: 'https://openrouter.ai/api', key }], key);
	assert.deepEqual(states, [{ id: '1', label: 'Work', masked: 'sk-or-v1-…abcd', gateway: 'https://openrouter.ai/api', active: true }]);
	assert.ok(!JSON.stringify(states).includes(key));
	assert.equal(keyStates([{ id: '1', label: 'W', gateway: 'g', key }], 'other')[0].active, false);
});

test('a session exports as Markdown with tool calls, hiding editor context and attachments', () => {
	const messages: ChatMessage[] = [
		{ role: 'user', content: 'fix the bug\n\n<editor_context>\nSelected from a.ts:1\nx\n</editor_context>' },
		{ role: 'assistant', content: 'Done.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'edit_file', arguments: '{"path":"a.ts"}' } }] },
		{ role: 'tool', tool_call_id: 'c1', content: 'Edited a.ts.' },
	];
	const md = sessionToMarkdown('Fix bug', 1730000000000, messages);
	assert.match(md, /^# Fix bug/);
	assert.match(md, /## User\n\nfix the bug\n/);
	assert.ok(!md.includes('editor_context'));
	assert.match(md, /## OpenRouter Client\n\nDone\./);
	assert.match(md, /`edit_file`/);
	assert.match(md, /Edited a\.ts\./);
});

test('modality lists pass through from the catalog', async () => {
	handler = (_req, res) => res.end(JSON.stringify({ data: [
		{ id: 'vendor/omni', name: 'Omni', architecture: { input_modalities: ['text', 'image', 'audio'], output_modalities: ['text'] } },
	] }));
	const models = await client().listModels();
	// OpenRouter sends these lower case; the picker expects upper case.
	assert.deepEqual(models[0].inputModalities, ['TEXT', 'IMAGE', 'AUDIO']);
	assert.deepEqual(models[0].outputModalities, ['TEXT']);
});

test('summaries shorten tool output', () => {
	const text = flattenForSummary(toolTurn('1', 'run_command', { command: 'x' }, 'q'.repeat(9_000)));
	assert.ok(text.length < 3_000);
	assert.match(text, /called run_command/);
});

test('cache markers cover the system prompt, and the latest message only on verified models', () => {
	const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
	const claude = withCacheMarkers('s', messages, 'claude-haiku-5-5');
	assert.deepEqual(claude[0].content, [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }]);
	assert.deepEqual(claude[1].content, [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }]);
	assert.equal(withCacheMarkers('s', messages, 'gpt-5')[1].content, 'hi');
	assert.equal(messages[0].content, 'hi');
});

test('overflow detection uses clear errors, or the generic rejection on a large request', () => {
	const generic = new GatewayError('Gateway error 400: The model provider rejected this request.', 400);
	assert.ok(looksLikeOverflow(new GatewayError('context_length_exceeded', 400), 1, 100));
	assert.ok(looksLikeOverflow(generic, 50, 100));
	assert.ok(!looksLikeOverflow(generic, 10, 100));
	assert.ok(!looksLikeOverflow(new GatewayError('bad model', 400), 90, 100));
});

test('a too-large request is summarized and retried once', async () => {
	const { root, clean } = workspace();
	try {
		const messages: ChatMessage[] = [{ role: 'user', content: 'old' }, ...toolTurn('1', 'run_command', { command: 'x' }, 'z'.repeat(200_000)), { role: 'user', content: 'now' }];
		let calls = 0;
		const stream: ChatStreamer = {
			async *streamChat() {
				calls++;
				if (calls === 1 || calls === 3) { if (calls === 1) { throw new GatewayError('context_length_exceeded', 400); } }
				yield say(calls === 2 ? 'the summary' : 'answered');
			},
		};
		const events: AgentEvent[] = [];
		await runAgent(agentOptions(stream, root, 'default', 'allow', events, messages));
		assert.equal(calls, 3);
		assert.equal(messages.at(-1)?.content, 'answered');
		assert.ok(events.some(e => e.type === 'compacted'));

		let failures = 0;
		const always: ChatStreamer = { async *streamChat() { failures++; if (failures !== 2) { throw new GatewayError('context_length_exceeded', 400); } yield say('s'); } };
		const again: ChatMessage[] = [{ role: 'user', content: 'old' }, ...toolTurn('1', 'run_command', { command: 'x' }, 'z'.repeat(200_000)), { role: 'user', content: 'now' }];
		await assert.rejects(runAgent(agentOptions(always, root, 'default', 'allow', [], again)), /context_length/);
		assert.equal(failures, 3);
	} finally { clean(); }
});

test('memory saves, avoids duplicates, removes and survives across chats', async () => {
	const { root, ctx, clean } = workspace();
	try {
		const file = path.join(root, 'nested', 'memory.md');
		const withMemory = { ...ctx, memoryFile: file };
		assert.equal(await tool('remember').run({ note: 'Uses  pnpm\nnot npm' }, withMemory), 'Saved to memory.');
		assert.equal(await tool('remember').run({ note: 'Uses pnpm not npm' }, withMemory), 'That note was already saved.');
		await addMemory(file, 'Deploys to Coolify');
		assert.equal(await readMemory(file), '- Uses pnpm not npm\n- Deploys to Coolify');
		assert.match(buildSystemPrompt({ root, mode: 'default', memory: await readMemory(file) }), /Saved memory[\s\S]*Deploys to Coolify/);
		assert.equal(await tool('forget').run({ text: 'PNPM' }, withMemory), 'Removed 1 notes.');
		assert.equal(await readMemory(file), '- Deploys to Coolify');
		await assert.rejects(tool('remember').run({ note: 'x' }, ctx), /not available/);
		assert.equal(await tool('remember').kind({}, ctx), 'edit');
		assert.equal(decide('plan', await tool('remember').kind({}, ctx)), 'deny');
	} finally { clean(); }
});

test('recent work kept after a summary scales with the model', () => {
	assert.equal(keepTokensFor(undefined), 40_000);
	assert.equal(keepTokensFor(128_000), 40_000);
	assert.equal(keepTokensFor(1_000_000), 150_000);
	assert.equal(keepTokensFor(10_000), 4_000);
	assert.equal(compactLimit(1_000_000), 850_000);
});

test('large files are readable', async () => {
	const { root, ctx, clean } = workspace();
	try {
		fs.writeFileSync(path.join(root, 'big.txt'), Array.from({ length: 1500 }, (_, i) => `line ${i} ${'a'.repeat(100)}`).join('\n'));
		const out = await tool('read_file').run({ path: 'big.txt' }, ctx);
		assert.ok(!out.includes('omitted'));
		assert.match(out, /1500\tline 1499/);
	} finally { clean(); }
});

test('an empty reply is retried, then nudged, without changing the saved chat', async () => {
	const { root, clean } = workspace();
	try {
		const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
		const stream = scripted([[{ type: 'finish', reason: 'stop' }], [{ type: 'finish', reason: 'stop' }], [say('recovered')]]);
		const events: AgentEvent[] = [];
		await runAgent(agentOptions(stream, root, 'default', 'allow', events, messages));
		assert.equal(stream.requests.length, 3);
		assert.equal(stream.requests[1].at(-1)?.content, 'go');
		assert.match(JSON.stringify(stream.requests[2].at(-1)?.content), /Continue with the task/);
		assert.deepEqual(messages.map(m => m.content), ['go', 'recovered']);
		assert.equal(events.filter(e => e.type === 'notice').length, 1);
	} finally { clean(); }
});

test('repeated empty replies stop with a clear message and do not use up turns', async () => {
	const { root, clean } = workspace();
	try {
		const events: AgentEvent[] = [];
		const stream = scripted([[{ type: 'finish', reason: 'length' }], [{ type: 'finish', reason: 'length' }], [{ type: 'finish', reason: 'length' }]]);
		await runAgent(agentOptions(stream, root, 'default', 'allow', events));
		assert.equal(stream.requests.length, 3);
		assert.ok(events.some(e => e.type === 'notice' && /3 times \(finish reason: length\)/.test(e.message)));
	} finally { clean(); }
});

test('the empty reply allowance resets after a successful turn', async () => {
	const { root, clean } = workspace();
	try {
		const empty: StreamEvent[] = [{ type: 'finish', reason: 'stop' }];
		const stream = scripted([empty, empty, [call('1', 'list_files', {})], empty, empty, [say('done')]]);
		const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
		await runAgent(agentOptions(stream, root, 'default', 'allow', [], messages));
		assert.equal(messages.at(-1)?.content, 'done');
	} finally { clean(); }
});

test('output limits avoid the small gateway default without exceeding the model', () => {
	assert.equal(outputTokenLimit('claude', 128_000, 0), 32_000);
	assert.equal(outputTokenLimit('small', 8_000, undefined), 8_000);
	assert.equal(outputTokenLimit('claude', 128_000, 500), 500);
	assert.equal(outputTokenLimit('small', 8_000, 50_000), 8_000);
	assert.equal(outputTokenLimit('auto', 128_000, 0), undefined);
	assert.equal(outputTokenLimit('auto', 128_000, 700), 700);
});

test('a reply cut off with no output retries with more room, up to the model limit', async () => {
	const { root, clean } = workspace();
	try {
		const sizes: (number | undefined)[] = [];
		let calls = 0;
		const stream: ChatStreamer = {
			async *streamChat(request) {
				sizes.push(request.maxTokens);
				calls++;
				if (calls < 3) { yield { type: 'finish', reason: 'length' }; return; }
				yield say('answer');
			},
		};
		await runAgent({ ...agentOptions(stream, root, 'default', 'allow', []), maxTokens: 1000, modelMaxOutput: 3000 });
		assert.deepEqual(sizes, [1000, 2000, 3000]);
	} finally { clean(); }
});

test('a truncated empty reply with no output limit set (auto model) still grows on retry', async () => {
	const { root, clean } = workspace();
	try {
		const sizes: (number | undefined)[] = [];
		let calls = 0;
		const stream: ChatStreamer = {
			async *streamChat(request) {
				sizes.push(request.maxTokens);
				calls++;
				if (calls < 2) { yield { type: 'finish', reason: 'length' }; return; }
				yield say('answer');
			},
		};
		await runAgent(agentOptions(stream, root, 'default', 'allow', []));
		assert.deepEqual(sizes, [undefined, DEFAULT_OUTPUT_TOKENS]);
	} finally { clean(); }
});

test('a silent stream is reported instead of hanging forever', async () => {
	handler = (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': hello\n\n'); };
	await assert.rejects(collect(client({ idleTimeoutMs: 60 }).streamChat({ model: 'm', messages: [] })), /stopped responding/);
});

test('aborting unblocks a hung stream read quickly', async () => {
	// The connection sends a heartbeat then stalls; Stop must end the read promptly,
	// not wait for the idle watchdog.
	handler = (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': hello\n\n'); };
	const abort = new AbortController();
	const started = Date.now();
	setTimeout(() => abort.abort(), 60);
	await assert.rejects(collect(client({ idleTimeoutMs: 30_000 }).streamChat({ model: 'm', messages: [] }, abort.signal)));
	assert.ok(Date.now() - started < 5_000, 'abort should not wait for the 30s idle watchdog');
});

test('stopping a request is not reported as a hang', async () => {
	handler = (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': hello\n\n'); };
	const abort = new AbortController();
	setTimeout(() => abort.abort(), 40);
	await assert.rejects(collect(client({ idleTimeoutMs: 5_000 }).streamChat({ model: 'm', messages: [] }, abort.signal)), (e: Error) => !/stopped responding/.test(e.message));
});

test('sessions persist and reject unsafe ids', async () => {
	const { root, clean } = workspace();
	try {
		const store = new SessionStore(root);
		const session = newSession();
		session.title = 'Hello';
		await store.save(session);
		assert.equal((await store.list())[0].title, 'Hello');
		assert.equal((await store.load(session.id))?.title, 'Hello');
		await assert.rejects(store.delete('../../etc/passwd'), /Invalid/);
	} finally { clean(); }
});

function model(id: string, extra: Partial<ModelInfo> = {}): ModelInfo {
	return {
		id,
		name: id,
		family: id.includes('/') ? id.split('/')[0] : id,
		contextWindow: 128_000,
		maxOutputTokens: 8_192,
		supportsTools: true,
		supportsImages: false,
		reasoningEfforts: [],
		inputModalities: ['TEXT'],
		outputModalities: ['TEXT'],
		...extra,
	};
}

test('prices are blended so input-heavy chat ranks realistically', () => {
	// Cheap input with costly output must not look cheaper than a flat mid-price model.
	const spiky = model('a/spiky', { promptPricePerMillion: 0.1, completionPricePerMillion: 40 });
	const flat = model('a/flat', { promptPricePerMillion: 3, completionPricePerMillion: 3 });
	assert.ok(blendedPrice(spiky)! > blendedPrice(flat)!);
	assert.equal(blendedPrice(flat), 3);
	assert.equal(isFree(model('a/free', { promptPricePerMillion: 0, completionPricePerMillion: 0 })), true);
	// Routers publish no fixed price, which is not the same as being free.
	assert.equal(priceVaries(model('openrouter/auto')), true);
	assert.equal(isFree(model('openrouter/auto')), false);
});

test('cheapest sorts free first and parks models with no fixed price last', () => {
	const models = [
		model('a/mid', { promptPricePerMillion: 3, completionPricePerMillion: 3 }),
		model('openrouter/auto'),
		model('a/free', { promptPricePerMillion: 0, completionPricePerMillion: 0 }),
		model('a/cheap', { promptPricePerMillion: 0.02, completionPricePerMillion: 0.02 }),
	];
	assert.deepEqual(sortModels(models, 'cheapest').map(m => m.id), ['a/free', 'a/cheap', 'a/mid', 'openrouter/auto']);
});

test('recommended puts capable models first and demotes tool-less and billing variants', () => {
	const models = [
		model('a/no-tools', { supportsTools: false, intelligence: 60 }),
		model('a/strong', { intelligence: 50, agenticScore: 55 }),
		model('a/strong:batch', { intelligence: 50, agenticScore: 55 }),
		model('a/weak', { intelligence: 10 }),
		model('a/old', { intelligence: 58, deprecatedAt: '2026-01-01' }),
	];
	const order = sortModels(models, 'recommended').map(m => m.id);
	assert.equal(order[0], 'a/strong');
	// The duplicate billing variant must rank below the plain model.
	assert.ok(order.indexOf('a/strong') < order.indexOf('a/strong:batch'));
	// Tool-less and deprecated models are never a good default for an agent.
	assert.ok(order.indexOf('a/no-tools') > order.indexOf('a/weak'));
	assert.equal(order.at(-1), 'a/no-tools');
});

test('strongest sort prefers agentic and coding scores over raw intelligence', () => {
	const a = model('a/one', { intelligence: 70 });
	const b = model('a/two', { intelligence: 40, codingScore: 80 });
	const c = model('a/three', { intelligence: 40, codingScore: 60, agenticScore: 90 });
	assert.equal(bestScore(c), 90);
	assert.equal(bestScore(b), 80);
	assert.deepEqual(sortModels([a, b, c], 'smartest').map(m => m.id), ['a/three', 'a/two', 'a/one']);
	// A billing variant scores the same as its base model and must not jump ahead of it.
	assert.deepEqual(sortModels([model('a/one:batch', { intelligence: 70 }), a], 'smartest').map(m => m.id), ['a/one', 'a/one:batch']);
	// Unscored models fall to the end rather than being treated as zero-strength ties.
	assert.equal(sortModels([model('a/none'), a], 'smartest')[0].id, 'a/one');
});

test('filters combine and can be cleared', () => {
	const models = [
		model('a/plain'),
		model('a/vision', { supportsImages: true }),
		model('b/free-vision', { supportsImages: true, promptPricePerMillion: 0, completionPricePerMillion: 0 }),
		model('b/chat-only', { supportsTools: false }),
	];
	assert.deepEqual(filterModels(models, { toolsOnly: true }).map(m => m.id), ['a/plain', 'a/vision', 'b/free-vision']);
	assert.deepEqual(filterModels(models, { visionOnly: true, freeOnly: true }).map(m => m.id), ['b/free-vision']);
	assert.deepEqual(filterModels(models, { family: 'b' }).map(m => m.id), ['b/free-vision', 'b/chat-only']);
	assert.deepEqual(filterModels(models, {}).length, 4);
});

test('ranked sorts stay in one list while named sorts group by vendor', () => {
	const models = [model('anthropic/x'), model('openai/y'), model('anthropic/z')];
	assert.deepEqual(groupModels(models, 'cheapest').map(g => g.label), ['']);
	assert.deepEqual(groupModels(models, 'name').map(g => g.label), ['anthropic', 'openai']);
	assert.deepEqual(families(models).map(f => `${f.id}:${f.count}`), ['anthropic:2', 'openai:1']);
});

test('prices and context windows read clearly', () => {
	assert.equal(formatPrice(model('a/b', { promptPricePerMillion: 0, completionPricePerMillion: 0 })), 'free');
	assert.equal(formatPrice(model('openrouter/auto')), 'price varies');
	// Image and audio models publish zero per-token prices but bill per output.
	const painter = model('g/painter', { promptPricePerMillion: 0, completionPricePerMillion: 0, outputModalities: ['IMAGE', 'TEXT'] });
	assert.equal(formatPrice(painter), 'priced per output');
	assert.equal(isFree(painter), false);
	assert.equal(sortModels([painter, model('a/free', { promptPricePerMillion: 0, completionPricePerMillion: 0 })], 'cheapest')[0].id, 'a/free');
	assert.equal(formatPrice(model('a/b', { promptPricePerMillion: 0.006, completionPricePerMillion: 0.024 })), '$0.006/$0.024 per M');
	assert.equal(formatPrice(model('a/b', { promptPricePerMillion: 3, completionPricePerMillion: 15 })), '$3/$15 per M');
	assert.equal(formatContext(model('a/b', { contextWindow: 1_000_000 })), '1M context');
	assert.equal(formatContext(model('a/b', { contextWindow: 200_000 })), '200K context');
});
