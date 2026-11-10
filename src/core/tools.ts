import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { addMemory, removeMemory } from './memory';
import { ToolKind } from './permissions';
import { ToolSchema } from './types';

export interface ToolContext {
	root: string;
	/** Only true in bypass mode. */
	allowOutsideWorkspace: boolean;
	commandTimeoutSeconds: number;
	signal?: AbortSignal;
	/** Private per-project notes that carry across chats. */
	memoryFile?: string;
}

type Args = Record<string, unknown>;

export interface Tool {
	schema: ToolSchema;
	/** Sensitivity of a call. May resolve symlinks, so it can be async. */
	kind(args: Args, ctx: ToolContext): ToolKind | Promise<ToolKind>;
	summary(args: Args): string;
	run(args: Args, ctx: ToolContext): Promise<string>;
	/** Before and after content for edit tools, used for diffs. */
	preview?(args: Args, ctx: ToolContext): Promise<{ path: string; before: string; after: string }>;
}

export class ToolError extends Error {}

const MAX_OUTPUT = 50_000;
const MAX_READ_OUTPUT = 200_000;
const MAX_READ_LINES = 2_000;
const MAX_SEARCH_FILE = 1_048_576;
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'target', 'vendor', '__pycache__', '.venv', '.vscode-test']);

const SENSITIVE_NAME = /^(\.env(\..+)?|\.npmrc|\.netrc|\.pypirc|credentials(\.json)?|id_(rsa|dsa|ecdsa|ed25519)|.+\.(pem|key|p12|pfx))$/i;
const SAFE_ENV_TEMPLATE = /^\.env\.(example|sample|template)$/i;
const SENSITIVE_DIR = /(^|[\\/])\.(ssh|aws|gnupg)([\\/]|$)/i;
/** Writing here can run code without a separate command approval. */
const EXECUTION_PATH = /(^|[\\/])(\.git|\.vscode|\.husky|\.devcontainer)([\\/]|$)/i;

export function isSensitivePath(p: string): boolean {
	const name = path.basename(p);
	return SENSITIVE_DIR.test(p) || (!SAFE_ENV_TEMPLATE.test(name) && SENSITIVE_NAME.test(name));
}

function isExecutionPath(p: string): boolean {
	return EXECUTION_PATH.test(p);
}

export function truncate(text: string, max = MAX_OUTPUT): string {
	if (text.length <= max) { return text; }
	const half = Math.floor(max / 2);
	return `${text.slice(0, half)}\n\n[... ${text.length - max} characters omitted ...]\n\n${text.slice(-half)}`;
}

/** Resolves existing ancestors and dangling links before appending missing filenames. */
async function realpathOfExisting(target: string, links = 0): Promise<string> {
	if (links > 40) { throw new ToolError('Too many symbolic links in path.'); }
	try {
		return await fs.realpath(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
		let stat;
		try {
			stat = await fs.lstat(target);
		} catch (statError) {
			if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') { throw statError; }
		}
		if (stat?.isSymbolicLink()) {
			const link = await fs.readlink(target);
			return realpathOfExisting(path.resolve(path.dirname(target), link), links + 1);
		}
		// An existing non-link that failed realpath is not a safe missing filename.
		if (stat) { throw error; }
		const parent = path.dirname(target);
		if (parent === target) { throw error; }
		return path.join(await realpathOfExisting(parent, links), path.basename(target));
	}
}

export async function resolvePath(p: unknown, ctx: ToolContext): Promise<string> {
	if (typeof p !== 'string' || !p) { throw new ToolError('A path is required.'); }
	const absolute = path.resolve(ctx.root, p);
	if (ctx.allowOutsideWorkspace) { return absolute; }
	const real = await realpathOfExisting(absolute);
	const root = await realpathOfExisting(ctx.root);
	if (real !== root && !real.startsWith(root + path.sep)) {
		throw new ToolError(`${p} is outside the workspace. Only bypass mode can reach it.`);
	}
	return absolute;
}

function relative(ctx: ToolContext, absolute: string): string {
	return path.relative(ctx.root, absolute) || '.';
}

/**
 * Every spelling a call really touches, so a symlink such as `notes.md -> .env`
 * or `hooks -> .git` is classified by its target and not by its alias. The raw
 * argument is included because a file that does not exist yet cannot be resolved.
 */
async function inspectPaths(p: string, ctx: ToolContext): Promise<string[]> {
	const absolute = path.resolve(ctx.root, p);
	const spellings = [p, path.relative(ctx.root, absolute) || p];
	if (!ctx.allowOutsideWorkspace) {
		const real = await realpathOfExisting(absolute);
		spellings.push(path.relative(await realpathOfExisting(ctx.root), real) || real, real);
	}
	return spellings;
}

async function readKind(args: Args, ctx: ToolContext): Promise<ToolKind> {
	const paths = await inspectPaths(String(args.path ?? ''), ctx);
	return paths.some(isSensitivePath) ? 'sensitiveRead' : 'read';
}

async function editKind(args: Args, ctx: ToolContext): Promise<ToolKind> {
	const paths = await inspectPaths(String(args.path ?? ''), ctx);
	return paths.some(p => isSensitivePath(p) || isExecutionPath(p)) ? 'sensitiveEdit' : 'edit';
}

function schema(name: string, description: string, properties: object, required: string[]): ToolSchema {
	return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

/** Converts a glob with `**`, `*`, `?` and `{a,b}` into a RegExp. */
export function globToRegExp(glob: string): RegExp {
	let out = '';
	let braces = 0;
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*') {
			if (glob[i + 1] === '*') {
				i++;
				if (glob[i + 1] === '/') { i++; out += '(?:.*/)?'; } else { out += '.*'; }
			} else {
				out += '[^/]*';
			}
		} else if (c === '?') {
			out += '[^/]';
		} else if (c === '{') {
			braces++; out += '(?:';
		} else if (c === '}' && braces) {
			braces--; out += ')';
		} else if (c === ',' && braces) {
			out += '|';
		} else {
			out += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
		}
	}
	return new RegExp(`^${out}$`);
}

async function* walk(dir: string, signal?: AbortSignal): AsyncGenerator<string> {
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (signal?.aborted) { return; }
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!IGNORED_DIRS.has(entry.name)) { yield* walk(full, signal); }
		} else if (entry.isFile()) {
			yield full;
		}
	}
}

function replaceExact(content: string, oldString: string, newString: string, all: boolean): string {
	if (!oldString) { throw new ToolError('old_string must not be empty.'); }
	const count = content.split(oldString).length - 1;
	if (count === 0) { throw new ToolError('old_string was not found. Read the file again and match it exactly.'); }
	if (count > 1 && !all) { throw new ToolError(`old_string appears ${count} times. Add surrounding text or set replace_all.`); }
	return content.split(oldString).join(newString);
}

const readFile: Tool = {
	schema: schema('read_file', 'Read a text file. Returns numbered lines.', {
		path: { type: 'string', description: 'File path, relative to the workspace' },
		offset: { type: 'number', description: 'First line to read, starting at 1' },
		limit: { type: 'number', description: 'Number of lines to read' },
	}, ['path']),
	kind: readKind,
	summary: a => `Read ${a.path}`,
	async run(args, ctx) {
		const file = await resolvePath(args.path, ctx);
		const buffer = await fs.readFile(file);
		if (buffer.subarray(0, 8000).includes(0)) { throw new ToolError(`${args.path} is a binary file.`); }
		const lines = buffer.toString('utf8').split('\n');
		const start = Math.max(Number(args.offset ?? 1), 1) - 1;
		const count = Math.min(Number(args.limit ?? MAX_READ_LINES), MAX_READ_LINES);
		const shown = lines.slice(start, start + count).map((line, i) => `${start + i + 1}\t${line}`).join('\n');
		const more = start + count < lines.length ? `\n[${lines.length - start - count} more lines. Use offset to continue.]` : '';
		return truncate(shown, MAX_READ_OUTPUT) + more;
	},
};

const listFiles: Tool = {
	schema: schema('list_files', 'List files matching a glob such as src/**/*.ts. Skips dependency and build folders.', {
		pattern: { type: 'string', description: 'Glob, default **/*' },
		path: { type: 'string', description: 'Folder to search, default the workspace' },
	}, []),
	kind: () => 'read',
	summary: a => `List ${a.pattern ?? 'files'}`,
	async run(args, ctx) {
		const base = await resolvePath(args.path ?? '.', ctx);
		const matcher = globToRegExp(String(args.pattern ?? '**/*'));
		const found: string[] = [];
		for await (const file of walk(base, ctx.signal)) {
			if (matcher.test(path.relative(base, file).split(path.sep).join('/'))) {
				found.push(relative(ctx, file));
				if (found.length >= 500) { found.push('[Stopped at 500 files.]'); break; }
			}
		}
		return found.join('\n') || 'No files matched.';
	},
};

const searchText: Tool = {
	schema: schema('search_text', 'Search file contents with a regular expression. Returns file:line:text.', {
		pattern: { type: 'string', description: 'Regular expression' },
		path: { type: 'string', description: 'Folder to search, default the workspace' },
		glob: { type: 'string', description: 'Limit to files matching this glob' },
		case_insensitive: { type: 'boolean' },
	}, ['pattern']),
	kind: () => 'read',
	summary: a => `Search for ${a.pattern}`,
	async run(args, ctx) {
		let regex: RegExp;
		try {
			regex = new RegExp(String(args.pattern), args.case_insensitive ? 'i' : '');
		} catch (error) {
			throw new ToolError(`Invalid regular expression: ${(error as Error).message}`);
		}
		const base = await resolvePath(args.path ?? '.', ctx);
		const filter = args.glob ? globToRegExp(String(args.glob)) : undefined;
		const results: string[] = [];
		outer: for await (const file of walk(base, ctx.signal)) {
			// Secrets are skipped here because a search would bypass their read approval.
			if (!ctx.allowOutsideWorkspace) {
				await resolvePath(file, ctx);
				if (await readKind({ path: file }, ctx) === 'sensitiveRead') { continue; }
			}
			if (filter && !filter.test(path.relative(base, file).split(path.sep).join('/'))) { continue; }
			const stat = await fs.stat(file);
			if (stat.size > MAX_SEARCH_FILE) { continue; }
			const buffer = await fs.readFile(file);
			if (buffer.subarray(0, 8000).includes(0)) { continue; }
			const lines = buffer.toString('utf8').split('\n');
			for (let i = 0; i < lines.length; i++) {
				if (regex.test(lines[i])) {
					results.push(`${relative(ctx, file)}:${i + 1}:${lines[i].slice(0, 300)}`);
					if (results.length >= 200) { results.push('[Stopped at 200 matches.]'); break outer; }
				}
			}
		}
		return truncate(results.join('\n')) || 'No matches.';
	},
};

async function readIfExists(file: string): Promise<string> {
	try {
		return await fs.readFile(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return ''; }
		throw error;
	}
}

const writeFile: Tool = {
	schema: schema('write_file', 'Create a file or replace its whole content. Prefer edit_file for existing files.', {
		path: { type: 'string' },
		content: { type: 'string' },
	}, ['path', 'content']),
	kind: (args, ctx) => editKind(args, ctx),
	summary: a => `Write ${a.path}`,
	async preview(args, ctx) {
		const file = await resolvePath(args.path, ctx);
		return { path: file, before: await readIfExists(file), after: String(args.content ?? '') };
	},
	async run(args, ctx) {
		const file = await resolvePath(args.path, ctx);
		await fs.mkdir(path.dirname(file), { recursive: true });
		const content = String(args.content ?? '');
		await fs.writeFile(file, content, 'utf8');
		return `Wrote ${relative(ctx, file)} (${content.length} characters).`;
	},
};

const editFile: Tool = {
	schema: schema('edit_file', 'Replace exact text in a file. old_string must be unique unless replace_all is true.', {
		path: { type: 'string' },
		old_string: { type: 'string' },
		new_string: { type: 'string' },
		replace_all: { type: 'boolean' },
	}, ['path', 'old_string', 'new_string']),
	kind: (args, ctx) => editKind(args, ctx),
	summary: a => `Edit ${a.path}`,
	async preview(args, ctx) {
		const file = await resolvePath(args.path, ctx);
		const before = await fs.readFile(file, 'utf8');
		return { path: file, before, after: replaceExact(before, String(args.old_string ?? ''), String(args.new_string ?? ''), args.replace_all === true) };
	},
	async run(args, ctx) {
		const file = await resolvePath(args.path, ctx);
		const before = await fs.readFile(file, 'utf8');
		await fs.writeFile(file, replaceExact(before, String(args.old_string ?? ''), String(args.new_string ?? ''), args.replace_all === true), 'utf8');
		return `Edited ${relative(ctx, file)}.`;
	},
};

const runCommand: Tool = {
	schema: schema('run_command', 'Run a shell command in the workspace and return its output and exit code.', {
		command: { type: 'string' },
		timeout_seconds: { type: 'number' },
	}, ['command']),
	kind: () => 'execute',
	summary: a => `Run ${a.command}`,
	run(args, ctx) {
		const command = String(args.command ?? '');
		if (!command.trim()) { return Promise.reject(new ToolError('A command is required.')); }
		const seconds = Math.min(Number(args.timeout_seconds ?? ctx.commandTimeoutSeconds), 3600);
		const env = { ...process.env };
		delete env.OPENROUTER_API_KEY;
		delete env.OPENROUTER_API_KEY_ALT;
		delete env.ELECTRON_RUN_AS_NODE;
		return new Promise((resolve, reject) => {
			const child = spawn(command, { shell: true, cwd: ctx.root, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
			let output = '';
			let timedOut = false;
			const collect = (chunk: Buffer) => {
				output += chunk.toString('utf8');
				if (output.length > MAX_OUTPUT * 4) { output = output.slice(-MAX_OUTPUT * 2); }
			};
			const kill = () => {
				try {
					if (child.pid && process.platform !== 'win32') { process.kill(-child.pid, 'SIGTERM'); } else { child.kill(); }
				} catch { /* already exited */ }
			};
			const timer = setTimeout(() => { timedOut = true; kill(); }, seconds * 1000);
			ctx.signal?.addEventListener('abort', kill, { once: true });
			child.stdout.on('data', collect);
			child.stderr.on('data', collect);
			child.on('error', error => { clearTimeout(timer); reject(new ToolError(error.message)); });
			child.on('close', code => {
				clearTimeout(timer);
				ctx.signal?.removeEventListener('abort', kill);
				const status = timedOut ? `Timed out after ${seconds}s.` : ctx.signal?.aborted ? 'Stopped by the user.' : `Exit code ${code}.`;
				resolve(`${truncate(output)}\n${status}`.trim());
			});
		});
	},
};

const remember: Tool = {
	schema: schema('remember', 'Save a lasting fact about this project or the user\'s preferences so future chats know it. Never save secrets.', {
		note: { type: 'string', description: 'One short, self-contained fact' },
	}, ['note']),
	kind: () => 'edit',
	summary: a => `Remember: ${a.note}`,
	async run(args, ctx) {
		if (!ctx.memoryFile) { throw new ToolError('Memory is not available here.'); }
		return await addMemory(ctx.memoryFile, String(args.note ?? '')) ? 'Saved to memory.' : 'That note was already saved.';
	},
};

const forget: Tool = {
	schema: schema('forget', 'Remove saved memory notes containing the given text, for example when a fact is out of date.', {
		text: { type: 'string', description: 'Text that appears in the notes to remove' },
	}, ['text']),
	kind: () => 'edit',
	summary: a => `Forget notes about: ${a.text}`,
	async run(args, ctx) {
		if (!ctx.memoryFile) { throw new ToolError('Memory is not available here.'); }
		return `Removed ${await removeMemory(ctx.memoryFile, String(args.text ?? ''))} notes.`;
	},
};

export const TOOLS: Tool[] = [readFile, listFiles, searchText, writeFile, editFile, runCommand, remember, forget];

/** Tools that only look at the workspace, so they can be given to a restricted run. */
const READ_ONLY_TOOLS = new Set([readFile, listFiles, searchText].map(t => t.schema.function.name));

export function isReadOnlyTool(name: string): boolean {
	return READ_ONLY_TOOLS.has(name);
}

export function findTool(name: string): Tool | undefined {
	return TOOLS.find(t => t.schema.function.name === name);
}
