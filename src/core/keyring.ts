/** Helpers for the saved-key ring. Storage lives in the VS Code layer. */

export interface StoredKey {
	id: string;
	label: string;
	gateway: string;
	key: string;
}

/** What the chat view may know about a saved key. Never carries the key itself. */
export interface KeyState {
	id: string;
	label: string;
	masked: string;
	gateway: string;
	active: boolean;
}

export function keyStates(ring: StoredKey[], active: string | undefined): KeyState[] {
	return ring.map(k => ({ id: k.id, label: k.label, masked: maskKey(k.key), gateway: k.gateway, active: k.key === active }));
}

/** Shows the vendor prefix and the last four characters, e.g. sk-or-v1-…785d. */
export function maskKey(key: string): string {
	// OpenRouter keys look like sk-or-v1-<hex>; keep the whole prefix so keys stay recognisable.
	const prefix = /^sk-[a-z0-9]+-v\d+-/i.exec(key)?.[0] ?? key.slice(0, 8);
	if (key.length <= prefix.length + 4) { return '••••'; }
	return `${prefix}…${key.slice(-4)}`;
}

/** Fallback label when a key is saved without a name. */
export function defaultKeyLabel(key: string): string {
	return maskKey(key);
}
