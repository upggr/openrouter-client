import { ChatMessage } from './types';

const MARKERS = ['<editor_context>', '<attachments>'];

function userText(content: ChatMessage['content']): string {
	const raw = typeof content === 'string' ? content : (content ?? []).filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('');
	let cut = raw.length;
	for (const marker of MARKERS) {
		const i = raw.indexOf(`\n\n${marker}`);
		if (i >= 0 && i < cut) { cut = i; }
	}
	return raw.slice(0, cut);
}

/** Renders a session as a Markdown document, for sharing or archiving agent sessions. */
export function sessionToMarkdown(title: string, updatedAt: number, messages: ChatMessage[]): string {
	const lines = [`# ${title}`, '', `_${new Date(updatedAt).toLocaleString()}_`, ''];
	for (const message of messages) {
		if (message.role === 'user') {
			const text = userText(message.content);
			lines.push('## User', '', text || '_(attachments only)_');
			if (Array.isArray(message.content) && message.content.some(p => p.type === 'image_url')) { lines.push('', '_[image attached]_'); }
			lines.push('');
		} else if (message.role === 'assistant') {
			const text = typeof message.content === 'string' ? message.content : '';
			if (text) { lines.push('## OpenRouter Client', '', text, ''); }
			for (const call of message.tool_calls ?? []) {
				let detail = call.function.arguments;
				try { detail = JSON.stringify(JSON.parse(call.function.arguments), null, 2); } catch { /* keep raw */ }
				lines.push(`> **Tool:** \`${call.function.name}\``, '', '```json', detail, '```', '');
			}
		} else if (message.role === 'tool') {
			const text = String(message.content ?? '');
			const short = text.length > 2_000 ? `${text.slice(0, 2_000)}\n_[truncated]_` : text;
			lines.push('> **Result:**', '', '```', short, '```', '');
		}
	}
	return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}
