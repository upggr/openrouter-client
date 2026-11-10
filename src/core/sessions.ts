import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ChatMessage } from './types';

export interface Session {
	id: string;
	title: string;
	updatedAt: number;
	messages: ChatMessage[];
	/** Older messages replaced by a summary, kept only so the chat stays readable. */
	archive?: ChatMessage[];
}

export interface SessionSummary {
	id: string;
	title: string;
	updatedAt: number;
}

const MAX_SESSIONS = 50;
const SAFE_ID = /^[a-f0-9-]{36}$/;

export function newSession(): Session {
	return { id: randomUUID(), title: 'New chat', updatedAt: Date.now(), messages: [] };
}

export class SessionStore {
	constructor(private readonly dir: string) {}

	async save(session: Session): Promise<void> {
		await fs.mkdir(this.dir, { recursive: true });
		const target = this.file(session.id);
		const temp = `${target}.${process.pid}.tmp`;
		await fs.writeFile(temp, JSON.stringify(session), { encoding: 'utf8', mode: 0o600 });
		await fs.rename(temp, target);
		await this.prune();
	}

	async load(id: string): Promise<Session | undefined> {
		try {
			return JSON.parse(await fs.readFile(this.file(id), 'utf8')) as Session;
		} catch {
			return undefined;
		}
	}

	async delete(id: string): Promise<void> {
		await fs.rm(this.file(id), { force: true });
	}

	async list(): Promise<SessionSummary[]> {
		let names: string[];
		try {
			names = await fs.readdir(this.dir);
		} catch {
			return [];
		}
		const sessions = await Promise.all(names.filter(n => n.endsWith('.json')).map(n => this.load(n.slice(0, -5))));
		return sessions
			.filter((s): s is Session => s !== undefined)
			.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	private async prune(): Promise<void> {
		const all = await this.list();
		await Promise.all(all.slice(MAX_SESSIONS).map(s => this.delete(s.id)));
	}

	private file(id: string): string {
		if (!SAFE_ID.test(id)) { throw new Error('Invalid session id.'); }
		return path.join(this.dir, `${id}.json`);
	}
}
