# Changelog

## 0.1.5

- `/handover` writes a short state document to `.openrouterclient/handover.md` so a human or another AI can continue the work, and `/resume` loads it back into a new chat. Credentials are stripped from it, and the folder is added to `.gitignore` because it lives in your repository.
- `openrouter.monthlySpendLimit` now actually stops requests when it is reached, instead of only colouring the credit chip. An empty OpenRouter balance is refused up front too.
- Plan mode no longer sends the edit and command tool schemas it would refuse, saving about 550 tokens of every plan-mode request.
- `openrouter.maxTurns` now defaults to 50 rather than 200, so one message stuck in a loop cannot run up 200 paid requests. The agent still offers to continue.

## 0.1.4

- Economy mode: a toggle next to the model name that runs conversation summaries, follow-up suggestions and read-only sub-agents on a cheaper model, while your replies and all file edits stay on the model you picked. The chip shows an estimate of what it saved, and claims nothing when the comparison cannot be priced.
- Economy sub-agents are restricted to read-only tools, so a weaker model researches and reports instead of making edits that would have to be reviewed.
- Prompt caching now also marks conversations for Gemini, not only Claude, so repeated context is billed at the lower cache-read rate.
- Added `/economy [on|off]`, and `openrouter.economy`, `openrouter.economyModel` and `openrouter.economySubagents`.

## 0.1.3

- Register the chat participant as `@openrouter` again, so VS Code stops rejecting the invalid name and the handle matches the documentation.

## 0.1.2

- Show the actual routed model(s) next to Auto as soon as OpenRouter identifies them, retaining the latest request's routing across UI refreshes.

## 0.1.1

- Refresh the OpenRouter credit balance after requests so spending is reflected in the status bar and chat.
- Fix previews for pasted and attached images without allowing remote images in the chat view.
- Scope remembered file approvals to individual paths and always ask for sensitive actions.
- Protect sensitive paths reached through symlinks and prevent checkpoint rewind from escaping the workspace.

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
