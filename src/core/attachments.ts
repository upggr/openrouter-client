import { ChatMessage, ContentPart } from './types';

/** A file the user dropped or pasted into the chat. Read client-side in the webview. */
export interface Attachment {
	name: string;
	mime: string;
	/** Present for images: a data URL, already base64-encoded. */
	dataUrl?: string;
	/** Present for text-like files. May already be truncated. */
	text?: string;
	truncated?: boolean;
}

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_TEXT = 50_000;
/** Kept low because base64 images are billed and counted as context like any other tokens. */
export const MAX_ATTACHMENT_IMAGE_BYTES = 8 * 1024 * 1024;

/** Marks where attachment notes start, so the chat view can hide them from the bubble it draws. */
export const ATTACHMENTS_OPEN = '\n\n<attachments>';

export function truncateAttachmentText(text: string, max = MAX_ATTACHMENT_TEXT): { text: string; truncated: boolean } {
	return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };
}

/**
 * The gateway catalog under-reports vision: every model, including Claude and GPT
 * families that can read images, says vision:false with TEXT-only input modalities.
 * `auto` routing can also land on any of them, so it is treated as capable too.
 * Worst case, a model without vision ignores the image part.
 */
const VISION_CAPABLE = /claude|gpt|gemini|qwen|kimi|glm|llama|nova|deepseek|minimax/i;

export function canReadImages(modelId: string, supportsImages: boolean | undefined): boolean {
	return supportsImages === true || modelId === 'auto' || VISION_CAPABLE.test(modelId);
}

/**
 * Builds the user message content for typed text plus dropped or pasted files.
 * Images are embedded only when the model can read images; otherwise the user is
 * told why one was left out instead of silently dropping it. Text-like files are
 * inlined like an editor selection: clearly labelled data, not instructions.
 */
export function buildAttachedContent(text: string, attachments: Attachment[], supportsImages: boolean): ChatMessage['content'] {
	if (attachments.length === 0) { return text; }
	const notes: string[] = [];
	const images: ContentPart[] = [];
	for (const a of attachments) {
		if (a.dataUrl) {
			if (supportsImages) {
				images.push({ type: 'image_url', image_url: { url: a.dataUrl } });
				notes.push(`Attached image: ${a.name}`);
			} else {
				notes.push(`[Image "${a.name}" was not sent because the current model cannot read images. Switch to a vision-capable model to analyze it.]`);
			}
		} else if (a.text !== undefined) {
			notes.push(`Attached file ${a.name}:\n${a.text}${a.truncated ? '\n[Truncated. Ask to read the file directly if you need more.]' : ''}`);
		}
	}
	const combined = `${text}${ATTACHMENTS_OPEN}\n${notes.join('\n\n')}\n</attachments>`;
	return images.length === 0 ? combined : [{ type: 'text', text: combined }, ...images];
}
