# Changelog

## 0.1.0

First release. An AI chat and coding agent for VS Code that talks to OpenRouter.

- Sidebar chat with streaming replies, reasoning, queued messages and stop.
- Agent tools: read and edit files, run terminal commands, search the workspace, with permission modes.
- `@openrouter` in VS Code Chat, plus OpenRouter models in the editor's own model picker.
- Hundreds of models from the live OpenRouter catalogue with a picker that sorts by recommended, cheapest, strongest, largest context or name, and filters by tools, free, vision or vendor.
- Real credit balance read from OpenRouter with your API key, so spend is never guessed.
- `openrouter/auto` routing with automatic failover when a provider rejects a request.
- Sub-agents, checkpoints and rewind, @-mentions of workspace files, follow-up suggestions.
- Multiple API keys with quick switching, stored in VS Code secret storage.

Derived from [8bot for VS Code](https://github.com/upggr/8bot-vscode) by the same author.
