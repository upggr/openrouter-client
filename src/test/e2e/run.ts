import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

/** Newer macOS builds no longer name the binary Electron, which the test runner assumes. */
async function executable(): Promise<string> {
	const reported = await downloadAndUnzipVSCode('stable');
	if (fs.existsSync(reported)) { return reported; }
	const dir = path.dirname(reported);
	const found = fs.readdirSync(dir).find(name => !name.startsWith('.'));
	if (!found) { throw new Error(`No VS Code binary in ${dir}`); }
	return path.join(dir, found);
}

async function main(): Promise<void> {
	// Set when this runs from a VS Code terminal, and it would start the test copy as plain Node.
	delete process.env.ELECTRON_RUN_AS_NODE;
	const root = path.resolve(__dirname, '..', '..', '..');
	const envFile = path.join(root, '.env');
	if (fs.existsSync(envFile)) {
		for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
			const match = line.match(/^(OPENROUTER_API_KEY)=(.+)$/);
			if (match) { process.env[match[1]] = match[2]; }
		}
	}
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'OpenRouter Client-e2e-'));
	const code = await runTests({
		vscodeExecutablePath: await executable(),
		extensionDevelopmentPath: root,
		extensionTestsPath: path.join(__dirname, 'suite.js'),
		launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust'],
	}).then(() => 0, (error: unknown) => { console.error(error); return 1; });
	fs.rmSync(workspace, { recursive: true, force: true });
	process.exit(code);
}

void main();
