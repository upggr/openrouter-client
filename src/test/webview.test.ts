import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const media = path.join(__dirname, '..', '..', 'media');
const { render } = require(path.join(media, 'markdown.js')) as { render(text: string): string };

const BODY = `
<section id="welcome" hidden><input id="gateway"><input id="apiKey"><input id="keyLabel"><p id="setupError" hidden></p><button id="saveConnection"></button><button id="getSubscription"></button><button id="closeSetup" hidden></button></section>
<main id="app" hidden>
<select id="sessions"></select><button id="newChat"></button><div id="transcript"></div>
<label id="selectionChip" class="chip" hidden><input id="includeSelection" type="checkbox" checked><span id="selectionText"></span></label>
<div id="suggestions" hidden></div><div id="status" hidden></div><div id="queue" hidden></div><div id="mentionMenu" hidden></div><div id="attachments" hidden></div><textarea id="input"></textarea><input id="fileInput" type="file" hidden>
<button id="attach"></button><button id="model"><span id="modelName"></span></button>
<details id="advanced"><summary><span id="modeBadge" class="chip" hidden></span><span id="effortBadge" class="chip" hidden></span><span id="credits" class="chip"></span></summary>
<div id="effortWrap" hidden><div id="effort"></div></div><div id="mode"></div>
<div id="keyPicker"><button id="keyButton" aria-expanded="false"></button><div id="keyMenu" hidden><div id="keyList"></div><button id="addKey"></button><div id="keyForm" hidden><input id="newKey"><input id="newKeyName"><input id="newKeyGateway"><p id="keyError" hidden></p><button id="saveKey"></button><button id="cancelKey"></button></div></div></div>
<button id="creditsDetail"></button><span id="contextUsage"></span>
</details>
<button id="send"></button><button id="stop" hidden></button>
</main>`;

const STATE = {
	type: 'state', hasKey: true, buyUrl: 'x', gateway: 'https://openrouter.ai/api',
	models: [{ id: 'a', name: 'A', efforts: ['low', 'high'], contextWindow: 100 }, { id: 'b', name: 'B', efforts: [], contextWindow: 100 }],
	model: 'a', mode: 'default', effort: 'high',
	modes: [{ id: 'default', label: 'Ask first', detail: '' }, { id: 'bypassPermissions', label: 'Bypass', detail: '' }],
	keyStatus: 'ok',
	keys: [
		{ id: 'k1', label: 'Work', masked: 'sk-or-v1-…aaaa', gateway: 'https://openrouter.ai/api', active: true },
		{ id: 'k2', label: 'sk-or-v1-…bbbb', masked: 'sk-or-v1-…bbbb', gateway: 'https://other.example', active: false },
	],
	sessions: [], sessionId: 's1', busy: false, credits: { label: '$1.00 left', detail: 'd', level: 'low', live: false }, promptTokens: 50,
};

function load() {
	const dom = new JSDOM(`<!DOCTYPE html><body>${BODY}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
	const posted: { type: string; [key: string]: unknown }[] = [];
	const win = dom.window as unknown as { acquireVsCodeApi: () => unknown; eval(code: string): unknown; postMessage: unknown; document: Document; requestAnimationFrame(cb: () => void): number };
	win.acquireVsCodeApi = () => ({ postMessage: (m: { type: string }) => posted.push(JSON.parse(JSON.stringify(m))) });
	win.eval(fs.readFileSync(path.join(media, 'markdown.js'), 'utf8'));
	win.eval(fs.readFileSync(path.join(media, 'chat.js'), 'utf8'));
	const send = (data: object) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
	const $ = (id: string) => win.document.getElementById(id) as HTMLElement & { value: string; hidden: boolean };
	return { dom, posted, send, $, win };
}

test('webview CSP allows data images but not remote images', () => {
	const sidebar = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'vscode', 'sidebar.ts'), 'utf8');
	const csp = sidebar.match(/Content-Security-Policy" content="([^"]+)"/)?.[1];
	assert.ok(csp);
	assert.match(csp, /(?:^|;\s*)default-src 'none'\s*;/);
	assert.match(csp, /(?:^|;\s*)img-src data:\s*;/);
	assert.match(csp, /script-src 'nonce-\$\{nonce\}'/);
});

test('attached image previews use data URLs in the transcript', () => {
	const { send, win } = load();
	const image = 'data:image/png;base64,aGVsbG8=';
	send(STATE);
	send({ type: 'event', event: { type: 'user', text: 'See image', attachments: [{ name: 'image.png', isImage: true, dataUrl: image }] } });
	assert.equal(win.document.querySelector('img.thumb')?.getAttribute('src'), image);
	send({ type: 'transcript', items: [{ kind: 'user', text: 'See image', imageUrl: image }] });
	assert.equal(win.document.querySelector('img.thumb')?.getAttribute('src'), image);
});

test('markdown escapes HTML and blocks unsafe links', () => {
	const html = render('<img src=x onerror=alert(1)> [a](javascript:alert(1)) `<b>` **x**');
	assert.ok(!html.includes('<img'));
	assert.ok(!html.includes('href="javascript'));
	assert.ok(html.includes('<code>&lt;b&gt;</code>'));
	assert.ok(html.includes('<strong>x</strong>'));
	assert.ok(!render('```\n<script>alert(1)</script>\n```').includes('<script'));
	assert.ok(!render('[x](https://a.b/"onmouseover="alert(1))').includes('" onmouseover'));
});

test('markdown handles lists, tables and an unfinished code fence while streaming', () => {
	assert.ok(render('- a\n- b').includes('<ul><li>a</li><li>b</li></ul>'));
	assert.ok(render('| a |\n|---|\n| b |').includes('<td>b</td>'));
	assert.ok(render('```js\nlet a').includes('let a'));
});

test('a user with no key sees the welcome screen and can reach the subscription page', () => {
	const { posted, send, $ } = load();
	assert.equal(posted[0].type, 'ready');
	send({ ...STATE, hasKey: false });
	assert.equal($('welcome').hidden, false);
	assert.equal($('app').hidden, true);
	$('getSubscription').click();
	assert.equal(posted.at(-1)?.type, 'buy');
	assert.equal($('gateway').value, 'https://openrouter.ai/api');
	$('apiKey').value = 'sk-or-v1-abc';
	$('keyLabel').value = 'Work';
	$('saveConnection').click();
	assert.deepEqual(posted.at(-1), { type: 'saveConnection', gateway: 'https://openrouter.ai/api', key: 'sk-or-v1-abc', label: 'Work' });
	send({ type: 'setupResult', error: 'rejected' });
	assert.equal($('setupError').textContent, 'rejected');
	assert.equal($('setupError').hidden, false);
	send({ type: 'setupResult' });
	assert.equal($('apiKey').value, '');
	assert.equal($('setupError').hidden, true);
});

test('state fills pickers, per-model effort, credits and context use', () => {
	const { send, $ } = load();
	send(STATE);
	assert.equal($('app').hidden, false);
	assert.equal($('modelName').textContent, 'A');
	assert.equal($('effortWrap').hidden, false);
	assert.equal($('effort').querySelector('[aria-pressed="true"]')?.textContent, 'high');
	assert.equal($('mode').querySelector('[aria-pressed="true"]')?.textContent, 'Ask first');
	assert.equal($('credits').textContent, '$1.00 left');
	assert.ok($('credits').className.includes('low'));
	assert.equal($('contextUsage').textContent, '50% context');
	send({ ...STATE, model: 'b', mode: 'bypassPermissions' });
	assert.equal($('effortWrap').hidden, true);
	assert.ok($('mode').className.includes('danger'));
	// Non-default choices surface as badges on the collapsed Options row.
	assert.equal($('modeBadge').hidden, false);
	assert.ok($('modeBadge').className.includes('danger'));
});

test('Auto displays routed models as soon as reported and keeps them across state refreshes', () => {
	const { send, $, dom } = load();
	const auto = { ...STATE, model: 'auto', routedModels: [] as string[] };
	send(auto);
	assert.equal($('modelName').textContent, 'Auto');
	send({ type: 'event', event: { type: 'routedModel', model: 'a' } });
	assert.equal($('modelName').textContent, 'Auto · A');
	send({ type: 'event', event: { type: 'usage', usage: { model: 'a', promptTokens: 10 } } });
	send({ type: 'event', event: { type: 'routedModel', model: 'b' } });
	assert.equal($('modelName').textContent, 'Auto · A, B', 'duplicates are omitted');
	assert.match($('model').title, /Routed to: a, b/);
	assert.equal($('model').getAttribute('aria-label'), 'Choose model: Auto · A, B');
	send({ ...auto, routedModels: ['a', 'b'] });
	assert.equal($('modelName').textContent, 'Auto · A, B', 'host state retains routing');
	send({ ...auto, model: 'openrouter/auto', routedModels: ['a', 'b'] });
	assert.equal($('modelName').textContent, 'Auto · A, B', 'canonical auto id works too');
	send({ ...auto, model: 'a', routedModels: ['b'] });
	assert.equal($('modelName').textContent, 'A', 'explicit model selection stays unchanged');
	send(auto);
	send({ type: 'event', event: { type: 'routedModel', model: '<unknown/model>' } });
	assert.equal($('modelName').textContent, 'Auto · <unknown/model>');
	assert.equal($('modelName').children.length, 0, 'unknown names are plain text');
	send({ type: 'event', event: { type: 'user', text: 'Next request' } });
	assert.equal($('modelName').textContent, 'Auto', 'next request clears previous routes');
	send({ type: 'event', event: { type: 'usage', usage: { model: 'b' } } });
	assert.equal($('modelName').textContent, 'Auto · B', 'usage-only gateways still identify the model');
	dom.window.close();
});

test('sending, model changes and Enter post the right messages', () => {
	const { dom, posted, send, $ } = load();
	send(STATE);
	$('input').value = 'hello';
	$('input').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	assert.deepEqual(posted.at(-1), { type: 'send', text: 'hello', includeSelection: false, attachments: [] });
	assert.equal($('input').value, '');
	$('model').click();
	assert.deepEqual(posted.at(-1), { type: 'pickModel' });
	send({ ...STATE, model: 'b' });
	assert.equal($('modelName').textContent, 'B');
	// Reload resilience: the webview re-requests state when it becomes visible again.
	const before = posted.length;
	dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
	assert.equal(posted.length, before + 1);
	assert.equal(posted.at(-1)?.type, 'ready');
});

test('@-mention autocompletes files from the host and inserts the path', () => {
	const { dom, posted, send, $, win } = load();
	send(STATE);
	const input = $('input') as unknown as HTMLTextAreaElement;
	input.value = 'check @app';
	input.setSelectionRange(input.value.length, input.value.length);
	input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	assert.deepEqual(posted.at(-1), { type: 'searchFiles', id: '1', value: 'app' });
	send({ type: 'fileResults', id: '1', results: [{ path: 'src/app.ts' }, { path: 'src/app.test.ts' }] });
	const menu = win.document.getElementById('mentionMenu') as HTMLElement & { hidden: boolean };
	assert.equal(menu.hidden, false);
	assert.equal(menu.querySelectorAll('.mention-item').length, 2);
	// Enter picks the highlighted (first) file and inserts it.
	input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	assert.equal(input.value, 'check @src/app.ts ');
	assert.equal(menu.hidden, true);
});

test('a turn that edited files offers a rewind card', () => {
	const { posted, send, win, dom } = load();
	send(STATE);
	send({ type: 'event', event: { type: 'done', rewind: { count: 2, paths: ['src/a.ts', 'src/b.ts'] } } });
	const card = win.document.querySelector('.rewind-card');
	assert.ok(card);
	assert.match(card.textContent ?? '', /Edited 2 files/);
	(card.querySelector('button') as HTMLButtonElement).click();
	assert.deepEqual(posted.at(-1), { type: 'rewind' });
	assert.equal(win.document.querySelector('.rewind-card'), null, 'card dismisses after rewind');
	dom.window.close();
});

test('follow-up suggestions render as chips that send on click', () => {
	const { posted, send, win, dom } = load();
	send(STATE);
	send({ type: 'suggestions', suggestions: ['Add tests for this', 'Refactor for clarity'] });
	const bar = win.document.getElementById('suggestions') as HTMLElement & { hidden: boolean };
	assert.equal(bar.hidden, false);
	const chips = bar.querySelectorAll('.suggestion-chip');
	assert.equal(chips.length, 2);
	(chips[0] as HTMLButtonElement).click();
	assert.deepEqual(posted.at(-1), { type: 'send', text: 'Add tests for this', includeSelection: false, attachments: [] });
	dom.window.close();
});

test('selection preference restores from host state and changes are persisted', t => {
	const { dom, posted, send, $ } = load();
	t.after(() => dom.window.close());
	send({ ...STATE, includeSelection: false });
	const checkbox = $('includeSelection') as unknown as HTMLInputElement;
	assert.equal(checkbox.checked, false);
	checkbox.click();
	assert.deepEqual(posted.at(-1), { type: 'setIncludeSelection', value: 'true' });
	send({ ...STATE, includeSelection: true });
	assert.equal(checkbox.checked, true);
});

test('model names are rendered as text, including unknown saved selections', t => {
	const { dom, send, $ } = load();
	t.after(() => dom.window.close());
	send({ ...STATE, model: '<b>missing</b>' });
	assert.equal($('modelName').textContent, '<b>missing</b>');
	assert.equal($('modelName').children.length, 0);
});

test('effort and mode toggles post new choices and wait for state before changing', () => {
	const { posted, send, $ } = load();
	send(STATE);
	const before = posted.length;
	($('effort').querySelector('[data-value="high"]') as HTMLElement).click();
	assert.equal(posted.length, before, 'clicking the current choice does nothing');
	($('effort').querySelector('[data-value="low"]') as HTMLElement).click();
	assert.deepEqual(posted.at(-1), { type: 'setEffort', value: 'low' });
	($('mode').querySelector('[data-value="bypassPermissions"]') as HTMLElement).click();
	assert.deepEqual(posted.at(-1), { type: 'setMode', value: 'bypassPermissions' });
	assert.equal($('mode').querySelector('[aria-pressed="true"]')?.textContent, 'Ask first');
});

test('the key picker shows the active key and switches, forgets and adds keys', () => {
	const { dom, posted, send, $, win } = load();
	send(STATE);
	assert.equal($('keyButton').className, 'ok');
	assert.equal($('keyButton').title, 'API key working: Work · sk-or-v1-…aaaa');
	assert.equal($('keyMenu').hidden, true);
	$('keyButton').click();
	assert.equal($('keyMenu').hidden, false);
	assert.equal($('keyButton').getAttribute('aria-expanded'), 'true');
	assert.equal($('keyList').querySelectorAll('.key-item').length, 2);
	assert.equal($('keyList').querySelectorAll('.key-forget').length, 2, 'every key can be forgotten, including the active one');

	const forget = $('keyList').querySelectorAll('.key-forget')[1] as HTMLElement;
	const before = posted.length;
	forget.click();
	assert.equal(posted.length, before, 'first click only asks');
	assert.equal(forget.textContent, 'Forget?');
	forget.click();
	assert.deepEqual(posted.at(-1), { type: 'forgetKey', value: 'k2' });
	const forgetActive = $('keyList').querySelectorAll('.key-forget')[0] as HTMLElement;
	forgetActive.click();
	forgetActive.click();
	assert.deepEqual(posted.at(-1), { type: 'forgetKey', value: 'k1' });

	($('keyList').querySelectorAll('.key-pick')[1] as HTMLElement).click();
	assert.deepEqual(posted.at(-1), { type: 'switchKey', value: 'k2' });
	assert.equal($('keyMenu').hidden, true);

	$('keyButton').click();
	$('addKey').click();
	assert.equal($('keyForm').hidden, false);
	assert.equal($('newKeyGateway').value, 'https://openrouter.ai/api');
	$('newKey').value = ' sk-or-v1-new ';
	$('newKeyName').value = 'Home';
	$('saveKey').click();
	assert.deepEqual(posted.at(-1), { type: 'addKey', gateway: 'https://openrouter.ai/api', key: 'sk-or-v1-new', label: 'Home' });
	send({ type: 'keyResult', error: 'rejected' });
	assert.equal($('keyError').textContent, 'rejected');
	assert.equal($('keyMenu').hidden, false);
	assert.equal($('newKey').value, ' sk-or-v1-new ', 'a failed save keeps what was typed');
	send({ type: 'keyResult' });
	assert.equal($('keyMenu').hidden, true);
	assert.equal($('newKey').value, '', 'a saved key does not linger in the page');

	$('keyButton').click();
	win.document.body.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
	assert.equal($('keyMenu').hidden, true, 'clicking elsewhere closes it');
	$('keyButton').click();
	send({ ...STATE, hasKey: false, keys: [] });
	assert.equal($('keyMenu').hidden, true, 'removing the last key closes the panel for the setup screen');
});

test('permission card answers once and tool output is plain text', () => {
	const { posted, send, $, win } = load();
	send(STATE);
	send({ type: 'event', event: { type: 'toolStart', callId: 'c', tool: 'run_command', summary: '<b>Run</b>' } });
	send({ type: 'event', event: { type: 'permission', callId: 'c', tool: 'run_command', summary: 'Run command', detail: 'rm x', canDiff: true, sensitive: true } });
	const allow = win.document.querySelector('[data-answer="allow"]') as HTMLButtonElement;
	assert.ok(allow);
	assert.ok(win.document.querySelector('.warning'));
	assert.equal(win.document.querySelector('[data-answer="always"]'), null, 'sensitive actions cannot be always-allowed');
	allow.click();
	assert.deepEqual(posted.at(-1), { type: 'permission', id: 'c', answer: 'allow' });
	assert.equal(win.document.querySelector('.permission-card'), null);
	send({ type: 'event', event: { type: 'toolEnd', callId: 'c', ok: true, output: '<img src=x>' } });
	assert.equal(win.document.querySelector('.activity img'), null);
	assert.equal(win.document.querySelector('.activity-item .verb b'), null);
	assert.equal($('transcript').querySelector('.output')?.textContent, '<img src=x>');
});

test('a busy chat shows live progress and approval waits', () => {
	const { send, $, dom } = load();
	send({ ...STATE, busy: true });
	assert.equal($('status').hidden, false);
	assert.match($('status').textContent ?? '', /…/);
	send({ type: 'event', event: { type: 'permission', callId: 'x', summary: 's' } });
	assert.match($('status').textContent ?? '', /blessing/);
	send({ type: 'event', event: { type: 'toolEnd', callId: 'x', ok: true, output: '' } });
	assert.match($('status').textContent ?? '', /…/);
	send({ ...STATE, busy: false });
	assert.equal($('status').hidden, true);
	dom.window.close();
});

test('a busy chat shows a live token estimate while the model streams', () => {
	const { send, $, dom } = load();
	send({ ...STATE, busy: true });
	send({ type: 'event', event: { type: 'reasoning', text: 'x'.repeat(400) } });
	assert.match($('status').textContent ?? '', /~100 tokens out/);
	send({ type: 'event', event: { type: 'usage', usage: { promptTokens: 1000, completionTokens: 1000, cost: 0.002, model: 'a' } } });
	send({ type: 'event', event: { type: 'text', text: 'y'.repeat(400) } });
	assert.match($('status').textContent ?? '', /~\$0\.000200/);
	send({ ...STATE, busy: false });
	dom.window.close();
});

test('tool calls batch into one collapsed activity group instead of many boxes', () => {
	const { send, win, dom } = load();
	send(STATE);
	// Simulate one assistant turn with several tool calls back to back.
	send({ type: 'event', event: { type: 'toolStart', callId: 'a', tool: 'read_file', summary: 'Read src/main.ts' } });
	send({ type: 'event', event: { type: 'toolEnd', callId: 'a', ok: true, output: 'code' } });
	send({ type: 'event', event: { type: 'toolStart', callId: 'b', tool: 'run_command', summary: 'Run npm test' } });
	send({ type: 'event', event: { type: 'toolStart', callId: 'c', tool: 'edit_file', summary: 'Edit src/main.ts' } });
	send({ type: 'event', event: { type: 'toolEnd', callId: 'b', ok: true, output: 'ok' } });
	send({ type: 'event', event: { type: 'toolEnd', callId: 'c', ok: true, output: 'done' } });
	const groups = win.document.querySelectorAll('.activity');
	assert.equal(groups.length, 1, 'all tools share one group');
	assert.equal(groups[0].querySelectorAll('.activity-item').length, 3);
	// When the turn ends the group folds to a quiet summary, not an open list.
	send({ type: 'event', event: { type: 'text', text: 'Done.' } });
	assert.equal((groups[0] as HTMLDetailsElement).open, false);
	assert.match(groups[0].querySelector('summary')?.textContent ?? '', /3 rites performed/);
	dom.window.close();
});

test('messages typed while busy are queued and can be removed', () => {
	const { posted, send, $, win, dom } = load();
	send({ ...STATE, busy: true });
	$('input').value = 'second request';
	$('input').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	assert.deepEqual(posted.at(-1), { type: 'send', text: 'second request', includeSelection: false, attachments: [] });
	send({ ...STATE, busy: true, queue: [{ index: 0, text: 'second request' }] });
	assert.equal($('queue').hidden, false);
	assert.match($('queue').textContent ?? '', /second request/);
	assert.match($('status').textContent ?? '', /1 queued/);
	// The last button in a chip is the remove (×); the ↯ interrupts and sends now.
	const buttons = [...win.document.querySelectorAll('#queue button')] as HTMLButtonElement[];
	(buttons.at(-1) as HTMLButtonElement).click();
	assert.deepEqual(posted.at(-1), { type: 'removeQueued', id: '0' });
	send({ ...STATE, busy: false, queue: [] });
	assert.equal($('queue').hidden, true);
	dom.window.close();
});

test('a queued message can interrupt the current run and send now', () => {
	const { posted, send, $, win, dom } = load();
	send({ ...STATE, busy: true, queue: [{ index: 2, text: 'do this instead' }] });
	(win.document.querySelector('#queue .queue-now') as HTMLButtonElement).click();
	assert.deepEqual(posted.at(-1), { type: 'interruptSend', id: '2', text: 'do this instead', includeSelection: false, attachments: [] });
	// Cmd/Ctrl+Enter in the input also interrupts with whatever is typed.
	$('input').value = 'urgent follow-up';
	$('input').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
	assert.deepEqual(posted.at(-1), { type: 'interruptSend', text: 'urgent follow-up', includeSelection: false, attachments: [] });
	dom.window.close();
});

test('limit errors offer the subscription page and every error offers a retry', () => {
	const { posted, send, win } = load();
	send(STATE);
	send({ type: 'event', event: { type: 'error', message: 'limit', showBuy: true } });
	const buttons = [...win.document.querySelectorAll('.error button')] as HTMLButtonElement[];
	assert.equal(buttons.length, 2);
	assert.equal(buttons[0].textContent, 'Retry');
	assert.match(buttons[1].textContent ?? '', /API key/);
	buttons[0].click();
	assert.equal(posted.at(-1)?.type, 'retry');
	assert.equal(win.document.querySelector('.error'), null);
	send({ type: 'event', event: { type: 'error', message: 'limit', showBuy: true } });
	([...win.document.querySelectorAll('.error button')] as HTMLButtonElement[])[1].click();
	assert.equal(posted.at(-1)?.type, 'buy');
});

test('transcript redraw and streamed text render', async () => {
	const { send, $ } = load();
	send(STATE);
	send({ type: 'transcript', items: [{ kind: 'user', text: 'q' }, { kind: 'assistant', text: '**a**' }, { kind: 'tool', summary: 's', output: 'o', ok: true }] });
	assert.equal($('transcript').querySelectorAll('.message').length, 2);
	assert.ok($('transcript').querySelector('strong'));
	send({ type: 'event', event: { type: 'text', text: 'streamed' } });
	send({ type: 'event', event: { type: 'done' } });
	assert.match($('transcript').textContent ?? '', /streamed/);
	send({ type: 'transcript', items: [{ kind: 'notice', text: 'Older messages above were summarized' }] });
	assert.match($('transcript').querySelector('.notice')?.textContent ?? '', /summarized/);
	send({ type: 'event', event: { type: 'usage', usage: { promptTokens: 40, cachedTokens: 30, cacheWriteTokens: 5, reasoningTokens: 7, cost: 0.00000418 } } });
	assert.match($('contextUsage').title, /40 of 100 prompt tokens, 30 from cache, 5 written to cache, 7 reasoning, cost \$0\.000004/);
});
