import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ChatMessage } from './types';
import { flattenForSummary } from './context';

/**
 * A handover is a short, model-written state document for a project, written to
 * the workspace so a human or a different AI can pick the work up. It is not a
 * transcript: a raw session is tens of thousands of tokens of file contents and
 * command output, which costs a fortune to resume from and means nothing to
 * another tool. A page of prose is cheap to read and portable.
 */

/** Folder in the workspace. Dot-prefixed so it stays out of the way, but it is not a secret. */
export const HANDOVER_DIR = '.openrouterclient';
export const HANDOVER_FILE = 'handover.md';
/** Kept small on purpose: a handover that grows into a transcript defeats the point. */
export const MAX_HANDOVER_CHARS = 12_000;
const MAX_SOURCE_CHARS = 300_000;

export function handoverPath(root: string): string {
	return path.join(root, HANDOVER_DIR, HANDOVER_FILE);
}

/**
 * The folder holds working notes about a project, not credentials, but it is
 * written inside the repository where a commit would publish it. Ignoring it by
 * default keeps that an explicit choice rather than an accident.
 */
export const GITIGNORE_LINE = `${HANDOVER_DIR}/`;

/**
 * Adds the handover folder to the workspace .gitignore unless it is already
 * covered. Returns true when the file was changed.
 */
export async function ignoreHandoverFolder(root: string): Promise<boolean> {
	const file = path.join(root, '.gitignore');
	let current = '';
	try {
		current = await fs.readFile(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
	}
	const lines = current.split('\n').map(l => l.trim());
	if (lines.includes(GITIGNORE_LINE) || lines.includes(HANDOVER_DIR) || lines.includes(`/${GITIGNORE_LINE}`)) { return false; }
	const prefix = current && !current.endsWith('\n') ? '\n' : '';
	await fs.writeFile(file, `${current}${prefix}${GITIGNORE_LINE}\n`, 'utf8');
	return true;
}

/**
 * Asks for a handover document rather than a summary: the point is that someone
 * with no history can continue, so unfinished work and the next step matter more
 * than a narrative of what happened.
 */
export const HANDOVER_PROMPT = [
	'Write a handover document so another engineer, or another AI assistant, can continue this work without seeing the conversation.',
	'',
	'Use this structure, in Markdown, and leave out any section you have nothing real to say about:',
	'## Goal — what the user is trying to achieve, in their own terms.',
	'## State — what is done and verified, and what is still broken or unfinished.',
	'## Key files — the paths that matter, each with one line on why, as `path:line` where useful.',
	'## Decisions — choices made and the reason, especially anything that looks odd without the reason.',
	'## Pitfalls — what was tried and did not work, so it is not retried.',
	'## Next step — the single most useful thing to do next, concretely.',
	'',
	'Rules:',
	'- Be specific: real paths, real commands, real error messages.',
	'- Do not copy file contents, diffs or command output; refer to paths instead.',
	'- Never include API keys, tokens, passwords or anything from a .env file.',
	'- No preamble and no closing remarks. Output only the document.',
].join('\n');

export function buildHandoverRequest(messages: ChatMessage[]): ChatMessage[] {
	const conversation = flattenForSummary(messages).slice(-MAX_SOURCE_CHARS);
	return [{ role: 'user', content: `${HANDOVER_PROMPT}\n\n<conversation>\n${conversation}\n</conversation>` }];
}

/** Secrets that must never reach a file in the user's repository. */
const SECRET_PATTERNS: RegExp[] = [
	// OpenRouter, OpenAI and similar bearer keys.
	/\bsk-[a-z0-9-]{8,}/gi,
	/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{10,}/g,
	/\bxox[abposr]-[A-Za-z0-9-]{10,}/gi,
	/\bAKIA[0-9A-Z]{12,}/g,
	/\bAIza[0-9A-Za-z_-]{20,}/g,
	/**
	 * KEY=value, key: value and "token": "value" shapes, whatever the secret itself
	 * looks like. The name must be an identifier rather than a word in a sentence,
	 * and the value must be quoted or unspaced, so prose such as
	 * "this costs 500 tokens: cheap" is left alone.
	 */
	/(["'`]?)(?:[A-Za-z0-9_-]*[_-])?(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?)(?:[_-][A-Za-z0-9_-]*)?\1\s*[:=]\s*(?:["'`][^"'`\n]*["'`]|[^\s"'`]+)/gi,
	/\b(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?)\s*=\s*[^\s]+/gi,
];

const REDACTED = '[redacted]';

/**
 * Removes anything that looks like a credential. The prompt already tells the
 * model not to include secrets, but a document written into the user's repository
 * must not depend on the model having obeyed.
 */
export function redactSecrets(text: string): string {
	return SECRET_PATTERNS.reduce((out, pattern) => out.replace(pattern, REDACTED), text);
}

export interface HandoverDocument {
	title: string;
	body: string;
	savedAt: Date;
}

/** Renders the document with a header saying what it is and when it was written. */
export function renderHandover(document: HandoverDocument): string {
	const when = document.savedAt.toISOString().slice(0, 16).replace('T', ' ');
	const body = redactSecrets(document.body.trim()).slice(0, MAX_HANDOVER_CHARS);
	return [
		`# Handover: ${document.title}`,
		'',
		`_Written by OpenRouter Client on ${when} UTC. Hand this to a human or another AI assistant to continue the work._`,
		'',
		body,
		'',
	].join('\n');
}

export async function writeHandover(root: string, document: HandoverDocument): Promise<string> {
	const file = handoverPath(root);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, renderHandover(document), 'utf8');
	return file;
}

export async function readHandover(root: string): Promise<string | undefined> {
	try {
		return await fs.readFile(handoverPath(root), 'utf8');
	} catch {
		return undefined;
	}
}
