import { ChatMessage } from './types';

/** The gateway answers 401 to any request over about 1 MB, so requests stay safely under that. */
export const MAX_REQUEST_BYTES = 900_000;
/** Past this size the chat is summarized, so context is condensed instead of dropped. */
export const COMPACT_REQUEST_BYTES = 750_000;

const KEEP_RECENT_TOOL_RESULTS = 8;
const MIN_SHORTENED_CHARS = 400;
const IMAGE_REMOVED = '[An earlier image was removed so this request fits the gateway size limit.]';
const OUTPUT_REMOVED = '[Older output removed so this request fits the gateway size limit. Run the tool again if you need it.]';

export function byteSize(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}

/**
 * Shrinks a request to fit, leaving the stored conversation untouched. Gives up
 * old images first, then old tool output, then the oldest whole turns. The
 * latest message is never changed, so an oversized one is left for the caller.
 */
export function fitRequestSize(messages: ChatMessage[], reservedBytes = 0, limit = MAX_REQUEST_BYTES): ChatMessage[] {
	const out = [...messages];
	const sizes = out.map(byteSize);
	let total = sizes.reduce((sum, size) => sum + size + 1, reservedBytes);
	if (total <= limit) { return messages; }

	const replace = (index: number, next: ChatMessage) => {
		const size = byteSize(next);
		total += size - sizes[index];
		sizes[index] = size;
		out[index] = next;
	};

	for (let index = 0; index < out.length - 1 && total > limit; index++) {
		const content = out[index].content;
		if (!Array.isArray(content) || !content.some(part => part.type === 'image_url')) { continue; }
		replace(index, { ...out[index], content: content.map(part => part.type === 'image_url' ? { type: 'text' as const, text: IMAGE_REMOVED } : part) });
	}

	const toolIndexes = out.flatMap((message, index) => message.role === 'tool' ? [index] : []);
	for (const index of toolIndexes.slice(0, -KEEP_RECENT_TOOL_RESULTS)) {
		if (total <= limit) { break; }
		const text = out[index].content;
		if (typeof text === 'string' && text.length >= MIN_SHORTENED_CHARS) {
			replace(index, { ...out[index], content: `${text.slice(0, 200)}\n${OUTPUT_REMOVED}` });
		}
	}

	// Cutting only at user messages keeps every tool result right after its call.
	const first = out[0]?.role === 'system' ? 1 : 0;
	let start = first;
	while (total > limit) {
		let next = start + 1;
		while (next < out.length && out[next].role !== 'user') { next++; }
		if (next >= out.length) { break; }
		for (let index = start; index < next; index++) { total -= sizes[index] + 1; }
		start = next;
	}
	return [...out.slice(0, first), ...out.slice(start)];
}
