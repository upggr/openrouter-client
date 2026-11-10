import assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'IoannisKokkinis.openrouter-client';
const CHEAP_MODEL = 'nova-micro-v1';

async function step(name: string, body: () => Promise<void>): Promise<void> {
	await body();
	console.log(`ok - ${name}`);
}

function withTimeout<T>(promise: Thenable<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		Promise.resolve(promise),
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms)),
	]);
}

/** Runs inside a real VS Code window. */
export async function run(): Promise<void> {
	const extension = vscode.extensions.getExtension(EXTENSION_ID);
	if (!extension) { throw new Error('extension not found'); }

	await step('activates', async () => {
		await extension.activate();
		assert.equal(extension.isActive, true);
	});

	await step('registers every command in the manifest', async () => {
		const all = await vscode.commands.getCommands(true);
		const declared = (extension.packageJSON.contributes.commands as { command: string }[]).map(c => c.command);
		assert.ok(declared.length >= 10);
		for (const command of declared) { assert.ok(all.includes(command), command); }
	});

	await step('opens the sidebar chat', async () => {
		await withTimeout(vscode.commands.executeCommand('openrouter.chatView.focus'), 20_000, 'view focus');
	});

	if (!process.env.OPENROUTER_API_KEY) {
		console.log('skip - no key, so model picker tests did not run');
		return;
	}

	let models: vscode.LanguageModelChat[] = [];
	await step('adds gateway models to the VS Code model picker', async () => {
		for (let i = 0; i < 30 && models.length === 0; i++) {
			models = await vscode.lm.selectChatModels({ vendor: 'eightos' });
			if (models.length === 0) { await new Promise(resolve => setTimeout(resolve, 1000)); }
		}
		assert.ok(models.length > 5, `only ${models.length} models`);
		console.log(`    ${models.length} models`);
	});

	await step('streams a reply through the model provider', async () => {
		const model = models.find(m => m.id === CHEAP_MODEL);
		if (!model) { throw new Error(`${CHEAP_MODEL} missing`); }
		const response = await withTimeout(model.sendRequest([vscode.LanguageModelChatMessage.User('Reply with the single word: pong')], {}), 60_000, 'sendRequest');
		let text = '';
		for await (const chunk of response.text) { text += chunk; }
		assert.match(text.toLowerCase(), /pong/);
	});
}
