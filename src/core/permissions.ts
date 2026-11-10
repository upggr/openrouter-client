export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export type ToolKind = 'read' | 'sensitiveRead' | 'edit' | 'sensitiveEdit' | 'execute';

export type Decision = 'allow' | 'ask' | 'deny';

export const PERMISSION_MODES: { id: PermissionMode; label: string; short: string; detail: string }[] = [
	{ id: 'default', label: 'Ask first', short: 'Ask', detail: 'Ask before edits and commands' },
	{ id: 'acceptEdits', label: 'Accept edits', short: 'Edits', detail: 'Apply edits automatically, ask before commands' },
	{ id: 'plan', label: 'Plan only', short: 'Plan', detail: 'Read only: edits and commands are blocked' },
	{ id: 'bypassPermissions', label: 'Bypass permissions', short: 'Bypass', detail: 'Run everything with no prompts' },
];

const POLICY: Record<PermissionMode, Record<ToolKind, Decision>> = {
	default: { read: 'allow', sensitiveRead: 'ask', edit: 'ask', sensitiveEdit: 'ask', execute: 'ask' },
	acceptEdits: { read: 'allow', sensitiveRead: 'ask', edit: 'allow', sensitiveEdit: 'ask', execute: 'ask' },
	plan: { read: 'allow', sensitiveRead: 'ask', edit: 'deny', sensitiveEdit: 'deny', execute: 'deny' },
	bypassPermissions: { read: 'allow', sensitiveRead: 'allow', edit: 'allow', sensitiveEdit: 'allow', execute: 'allow' },
};

export function decide(mode: PermissionMode, kind: ToolKind): Decision {
	return POLICY[mode][kind];
}

export function isPermissionMode(value: unknown): value is PermissionMode {
	return typeof value === 'string' && Object.hasOwn(POLICY, value);
}

/** Restore a user's choice without letting a saved/configured value skip bypass consent. */
export function restorePermissionMode(saved: unknown, configured: unknown, bypassAcknowledged: boolean): PermissionMode {
	const mode = isPermissionMode(saved) ? saved : isPermissionMode(configured) ? configured : 'default';
	return mode === 'bypassPermissions' && !bypassAcknowledged ? 'default' : mode;
}

/**
 * Key for an "always allow" answer. Commands are remembered exactly, because a
 * prefix such as `git` would also approve `git status; rm -rf .`.
 */
export function rememberKey(tool: string, args: Record<string, unknown>): string {
	return tool === 'run_command' ? `run_command:${String(args.command)}` : tool;
}
