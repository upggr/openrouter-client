import * as vscode from 'vscode';
import { outputTokenLimit } from '../core/context';
import { ChatMessage, ContentPart, ToolCall, ToolSchema } from '../core/types';
import { Services } from './services';

export const VENDOR = 'openrouter';

/** Adds gateway models to the VS Code Chat model picker, including built-in Agent mode. */
export class GatewayModelProvider implements vscode.LanguageModelChatProvider {
	readonly onDidChangeLanguageModelChatInformation: vscode.Event<void>;

	constructor(private readonly services: Services) {
		this.onDidChangeLanguageModelChatInformation = services.onDidChangeModels;
	}

	async provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions): Promise<vscode.LanguageModelChatInformation[]> {
		if (!await this.services.getApiKey()) {
			if (!options.silent) { await this.services.promptForKey(); }
			return [];
		}
		try {
			const models = await this.services.models();
			return models.map(m => ({
				id: m.id,
				name: m.deprecatedAt ? `${m.name} (deprecated)` : m.name,
				family: m.family,
				version: '1',
				detail: 'OpenRouter',
				tooltip: m.deprecatedAt ? `Deprecated by the provider. ${m.description ?? ''}`.trim() : m.description,
				maxInputTokens: m.contextWindow,
				maxOutputTokens: m.maxOutputTokens,
				capabilities: { toolCalling: m.supportsTools, imageInput: m.supportsImages },
			}));
		} catch (error) {
			if (!options.silent) { void vscode.window.showErrorMessage((error as Error).message); }
			return [];
		}
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const client = await this.services.client('model-provider');
		if (!client) { throw new Error('Add an OpenRouter API key to use this model.'); }
		const abort = new AbortController();
		const cancel = token.onCancellationRequested(() => abort.abort());
		try {
			const tools: ToolSchema[] | undefined = options.tools?.map(tool => ({
				type: 'function',
				function: { name: tool.name, description: tool.description, parameters: tool.inputSchema ?? { type: 'object', properties: {} } },
			}));
			// The same reasoning effort the sidebar and @openrouter use, so native Chat agent mode matches.
			const info = await this.services.modelInfo(model.id);
			const effort = this.services.config.get<string>('reasoningEffort', '');
			const stream = client.streamChat({
				model: model.id,
				messages: toGatewayMessages(messages),
				tools,
				toolChoice: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto',
				maxTokens: outputTokenLimit(model.id, model.maxOutputTokens, this.services.config.get<number>('maxOutputTokens')),
				reasoningEffort: effort && info?.reasoningEfforts.includes(effort) ? effort : undefined,
			}, abort.signal);
			for await (const event of stream) {
				if (event.type === 'text') {
					progress.report(new vscode.LanguageModelTextPart(event.text));
				} else if (event.type === 'tool_call') {
					progress.report(new vscode.LanguageModelToolCallPart(event.call.id, event.call.function.name, parseArguments(event.call.function.arguments)));
				}
			}
		} finally {
			cancel.dispose();
		}
	}

	async provideTokenCount(_model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage): Promise<number> {
		if (typeof text === 'string') { return Math.ceil(text.length / 4); }
		let chars = 0;
		for (const part of text.content) {
			if (part instanceof vscode.LanguageModelTextPart) { chars += part.value.length; }
			else if (part instanceof vscode.LanguageModelToolCallPart) { chars += part.name.length + JSON.stringify(part.input ?? {}).length; }
			else if (part instanceof vscode.LanguageModelDataPart) { chars += part.data.byteLength; }
			else { chars += JSON.stringify(part).length; }
		}
		return Math.ceil(chars / 4);
	}
}

function parseArguments(text: string): object {
	try {
		return text.trim() ? JSON.parse(text) as object : {};
	} catch {
		return {};
	}
}

function resultText(part: vscode.LanguageModelToolResultPart): string {
	return part.content.map(item => item instanceof vscode.LanguageModelTextPart ? item.value : JSON.stringify(item)).join('');
}

/** Converts VS Code chat messages to the gateway's OpenAI-compatible format. */
export function toGatewayMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (const message of messages) {
		const parts: ContentPart[] = [];
		const calls: ToolCall[] = [];
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				parts.push({ type: 'text', text: part.value });
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				calls.push({ id: part.callId, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) } });
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				// Tool results must directly follow the assistant turn that requested them.
				out.push({ role: 'tool', tool_call_id: part.callId, content: resultText(part) });
			} else if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
				parts.push({ type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}` } });
			}
		}
		if (parts.length === 0 && calls.length === 0) { continue; }
		const onlyText = parts.every(p => p.type === 'text');
		const content = parts.length === 0 ? null : onlyText ? parts.map(p => (p as { text: string }).text).join('') : parts;
		if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			out.push(calls.length ? { role: 'assistant', content, tool_calls: calls } : { role: 'assistant', content });
		} else if (message.role === vscode.LanguageModelChatMessageRole.User) {
			out.push({ role: 'user', content });
		} else {
			out.push({ role: 'system', content });
		}
	}
	return out;
}
