/** Snapshot of files about to be changed, so a whole turn can be rewound. */

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

export class Checkpoints {
	private entries: CheckpointEntry[] = [];
	private seen = new Set<string>();

	constructor(private readonly read: (absPath: string) => Promise<string | undefined>, private readonly join: (root: string, rel: string) => string, private readonly root: string) {}

	/** Records a file's pre-edit content once, so rewinding restores the original. */
	async capture(tool: string, args: Record<string, unknown>): Promise<void> {
		const rel = editedPath(tool, args);
		if (!rel || this.seen.has(rel)) { return; }
		this.seen.add(rel);
		const before = await this.read(this.join(this.root, rel)).catch(() => undefined);
		this.entries.push({ path: rel, before });
	}

	get count(): number { return this.entries.length; }
	get paths(): string[] { return this.entries.map(e => e.path); }
	/** The captured pre-edit contents, kept after the run so it can be rewound later. */
	get snapshot(): CheckpointEntry[] { return [...this.entries]; }

	/** Restores every captured file to its pre-turn content. Returns the restored paths. */
	async rewind(write: (absPath: string, content: string | undefined) => Promise<void>): Promise<string[]> {
		const restored: string[] = [];
		for (const entry of [...this.entries].reverse()) {
			await write(this.join(this.root, entry.path), entry.before);
			restored.push(entry.path);
		}
		this.entries = [];
		this.seen.clear();
		return restored;
	}
}
