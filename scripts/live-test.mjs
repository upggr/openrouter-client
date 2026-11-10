// Runs the real agent loop against the real gateway in a temporary folder.
// Needs OPENROUTER_API_KEY in .env. Each run uses a small amount of gateway credit.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { GatewayClient } = require('../out/core/gateway.js');
const { runAgent } = require('../out/core/agent.js');

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8')
	.split('\n').filter(l => /^\w+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

const client = new GatewayClient({ baseUrl: env.OPENROUTER_BASE_URL, apiKey: env.OPENROUTER_API_KEY });
const model = process.argv[2] ?? 'claude-haiku-5-5';
const models = await client.listModels();
assert.ok(models.some(m => m.id === model), `${model} is not available`);
console.log(`models available: ${models.length}`);

const root = mkdtempSync(join(tmpdir(), 'OpenRouter Client-live-'));
writeFileSync(join(root, 'greeting.txt'), 'hello world\n');
const messages = [{ role: 'user', content: 'Change "world" to "OpenRouter Client" in greeting.txt, then run: cat greeting.txt. Then say done.' }];
const events = [];
const asked = [];
let total = 0;

await runAgent({
	client, model, messages, root, systemPrompt: 'You are a coding agent. Use the tools.',
	commandTimeoutSeconds: 30, maxTurns: 8, maxTokens: 400,
	getMode: () => 'default',
	requestPermission: async r => { asked.push(r.tool); return 'allow'; },
	onEvent: e => { events.push(e); if (e.type === 'usage') { total += e.usage.cost ?? 0; } },
});

try {
	assert.equal(readFileSync(join(root, 'greeting.txt'), 'utf8'), 'hello OpenRouter Client\n');
	assert.ok(asked.includes('edit_file') || asked.includes('write_file'), 'edit was not approved through the prompt');
	assert.ok(asked.includes('run_command'), 'command was not approved through the prompt');
	assert.ok(events.some(e => e.type === 'toolEnd' && e.ok && e.output.includes('hello OpenRouter Client')), 'command output missing');
	console.log(`PASS with ${model}: tools asked ${asked.join(', ')}; reported cost $${total.toFixed(6)}`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
