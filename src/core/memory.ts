import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const MAX_MEMORY_CHARS = 20_000;

export async function readMemory(file: string | undefined): Promise<string> {
	if (!file) { return ''; }
	try {
		return (await fs.readFile(file, 'utf8')).trim().slice(-MAX_MEMORY_CHARS);
	} catch {
		return '';
	}
}

async function write(file: string, text: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, text, { encoding: 'utf8', mode: 0o600 });
}

/** Adds a note. Returns false if the same note is already saved. */
export async function addMemory(file: string, note: string): Promise<boolean> {
	const clean = note.replace(/\s+/g, ' ').trim();
	if (!clean) { throw new Error('A note is required.'); }
	const current = await readMemory(file);
	const line = `- ${clean}`;
	if (current.split('\n').includes(line)) { return false; }
	await write(file, `${current ? `${current}\n` : ''}${line}\n`);
	return true;
}

/** Removes notes containing the text and returns how many were removed. */
export async function removeMemory(file: string, text: string): Promise<number> {
	const needle = text.trim().toLowerCase();
	if (!needle) { throw new Error('Text to match is required.'); }
	const lines = (await readMemory(file)).split('\n').filter(Boolean);
	const kept = lines.filter(line => !line.toLowerCase().includes(needle));
	if (kept.length !== lines.length) { await write(file, kept.length ? `${kept.join('\n')}\n` : ''); }
	return lines.length - kept.length;
}
