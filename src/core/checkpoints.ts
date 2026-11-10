import * as path from 'node:path';
import { resolvePath } from './tools';

/** Validates both traversal and symlinks, including when replaying an old snapshot. */
export async function checkpointPath(root: string, rel: string): Promise<string> {
	if (!isContained(rel)) { throw new Error('Checkpoint path is outside the workspace.'); }
	return resolvePath(rel, { root, allowOutsideWorkspace: false, commandTimeoutSeconds: 1 });
}

export interface CheckpointEntry {
	/** Workspace-relative path. */
	path: string;
	/** Previous content, or undefined when the file did not exist before. */
	before: string | undefined;
}

export type EditLikeArgs = Record<string, unknown> & { path?: unknown };

/** Tools that modify files, and the arg that holds the target path. */
const EDIT_PATH_ARG: Record<string, string> = {
	write_file: 'path',
	edit_file: 'path',
};

/** The relative path an edit tool will touch, or undefined for non-edit tools. */
export function editedPath(tool: string, args: Record<string, unknown>): string | undefined {
	const key = EDIT_PATH_ARG[tool];
	if (!key) { return undefined; }
	const value = args[key];
	return typeof value === 'string' && value ? value : undefined;
}

/**
 * True when a workspace-relative path stays inside the workspace. Checkpoints are
 * replayed later with no permission prompt, so an escaping path must never be stored.
 */
function isContained(rel: string): boolean {
	if (!rel || path.isAbsolute(rel)) { return false; }
	let normalized = rel.split(/[\\/]+/).filter(p => p && p !== '.').join(path.sep);
	if (!normalized) { return false; }
	normalized = path.normalize(normalized);
	return normalized !== '..' && !normalized.startsWith(`..${path.sep}`) && !path.isAbsolute(normalized);
}

/** Snapshot of files about to be changed, so a whole turn can be rewound. */
export class Checkpoints {
	private entries: CheckpointEntry[] = [];
	private seen = new Set<string>();

	constructor(private readonly read: (absPath: string) => Promise<string | undefined>, private readonly join: (root: string, rel: string) => string, private readonly root: string) {}

	/** Records a file's pre-edit content once, so rewinding restores the original. */
	async capture(tool: string, args: Record<string, unknown>): Promise<void> {
		const rel = editedPath(tool, args);
		// The tool itself refuses paths outside the workspace; capture must not read them either.
		if (!rel || !isContained(rel)) { return; }
		let abs: string;
		try {
			abs = await checkpointPath(this.root, rel);
		} catch {
			return;
		}
		const canonical = path.relative(path.resolve(this.root), abs);
		if (!isContained(canonical) || this.seen.has(canonical)) { return; }
		this.seen.add(canonical);
		try {
			const before = await this.read(this.join(this.root, canonical));
			this.entries.push({ path: canonical, before });
		} catch { /* Unreadable is not the same as nonexistent: never rewind it to deletion. */ }
	}

	get count(): number { return this.entries.length; }
	get paths(): string[] { return this.entries.map(e => e.path); }
	/** The captured pre-edit contents, kept after the run so it can be rewound later. */
	get snapshot(): CheckpointEntry[] { return [...this.entries]; }

	/** Restores every captured file to its pre-turn content. Returns the restored paths. */
	async rewind(write: (absPath: string, content: string | undefined) => Promise<void>): Promise<string[]> {
		const restored: string[] = [];
		for (const entry of [...this.entries].reverse()) {
			try {
				await checkpointPath(this.root, entry.path);
				await write(this.join(this.root, entry.path), entry.before);
				restored.push(entry.path);
			} catch { /* The path may now be a symlink outside the workspace. */ }
		}
		this.entries = [];
		this.seen.clear();
		return restored;
	}
}
