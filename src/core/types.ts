export interface ToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

export type ContentPart =
	| { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
	| { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | ContentPart[] | null;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
}

export interface ToolSchema {
	type: 'function';
	function: { name: string; description: string; parameters: object };
}

export interface Usage {
	promptTokens: number;
	completionTokens: number;
	cost?: number;
	/** Input tokens served from the prompt cache. */
	cachedTokens?: number;
	/** Output tokens the model spent on hidden reasoning, when the gateway reports it. */
	reasoningTokens?: number;
	/** Input tokens written into the prompt cache on this request. */
	cacheWriteTokens?: number;
	/** The model that actually answered, which matters when routing with `auto`. */
	model?: string;
	/** The upstream provider that served the request, when OpenRouter reports it. */
	provider?: string;
}

export interface ModelInfo {
	id: string;
	name: string;
	family: string;
	description?: string;
	contextWindow: number;
	maxOutputTokens: number;
	supportsTools: boolean;
	supportsImages: boolean;
	reasoningEfforts: string[];
	/** Set when the provider has deprecated this model, from `deprecationInfo.deprecatedAt`. */
	deprecatedAt?: string;
	/** Raw modality lists, so non-chat models (audio, image) are visible the day they appear. */
	inputModalities: string[];
	outputModalities: string[];
	/** USD per million prompt tokens, when OpenRouter publishes a price. */
	promptPricePerMillion?: number;
	/** USD per million completion tokens, when OpenRouter publishes a price. */
	completionPricePerMillion?: number;
	/** Artificial Analysis intelligence index, when published. Higher is stronger. */
	intelligence?: number;
	/** Artificial Analysis coding index, when published. */
	codingScore?: number;
	/** Artificial Analysis agentic index, when published. */
	agenticScore?: number;
}

export type StreamEvent =
	| { type: 'routedModel'; model: string }
	| { type: 'text'; text: string }
	| { type: 'reasoning'; text: string }
	| { type: 'tool_call'; call: ToolCall }
	| { type: 'usage'; usage: Usage }
	| { type: 'failover'; model: string; name: string; contextWindow: number }
	| { type: 'finish'; reason: string };

export interface ChatRequest {
	model: string;
	messages: ChatMessage[];
	tools?: ToolSchema[];
	toolChoice?: 'auto' | 'required';
	maxTokens?: number;
	reasoningEffort?: string;
}

export interface ChatStreamer {
	streamChat(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent>;
}
