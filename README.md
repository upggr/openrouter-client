<p align="center"><img src="media/icon.png" width="120" alt="OpenRouter Client logo"></p>

<h1 align="center">OpenRouter Client for VS Code</h1>

<p align="center"><strong>An AI chat and coding agent for Visual Studio Code, powered by your OpenRouter API key.</strong></p>

<p align="center">
  <a href="https://github.com/upggr/openrouter-client">Source</a> ·
  <a href="https://github.com/upggr/openrouter-client/issues">Report an issue</a> ·
  <a href="https://openrouter.ai/keys">Get an API key</a>
</p>

OpenRouter Client connects Visual Studio Code to [OpenRouter](https://openrouter.ai), which puts hundreds of models from Anthropic, OpenAI, Google, Meta, DeepSeek, Mistral and others behind a single key. Chat with your code, let an agent edit files and run terminal commands, pick any model your credits allow, and control exactly what the agent may do without leaving the editor.

It works in its own sidebar, as **`@openrouter` in the VS Code Chat window**, and as a model provider that adds OpenRouter models to the VS Code Chat model picker.

> **Unofficial.** OpenRouter Client is an independent open source project. It is not affiliated with, endorsed by or supported by OpenRouter. OpenRouter is a product of OpenRouter, Inc., and the name is used here only to say what this extension connects to.

## Features

- **Sidebar chat** with streaming replies, saved history, slash commands and the current selection as context.
- **`@openrouter` in VS Code Chat**, with `/plan`, `/edit`, `/bypass` and `/models`.
- **OpenRouter models in the VS Code model picker**, usable by VS Code's built-in Agent mode.
- **Coding agent tools:** read, list and search files, create and edit files, and run terminal commands.
- **A picker built for a big catalogue.** Sort by recommended, cheapest, strongest, largest context or name, and filter to tool-capable, free, vision or a single vendor. Every row shows price, context, capabilities and benchmark score.
- **Real spend, not an estimate.** OpenRouter reports your balance to your API key, so the credit figure is authoritative. A key with its own spending cap shows that cap.
- **`openrouter/auto` routing** that picks a model for each request, with automatic failover when a provider rejects it.
- **Sub-agents** for focused subtasks, each with its own context.
- **Economy mode** moves summaries, follow-up suggestions and read-only sub-agents onto a cheaper model, and shows what it saved.
- **Checkpoints and rewind:** undo a turn's file changes in one click.
- **@-mentions** of workspace files, and follow-up suggestions after each turn.
- **Four permission modes:** Ask first, Accept edits, Plan only and Bypass permissions.
- **Diff preview** before you approve a file change.
- **Project instructions** from `AGENTS.md`, and project memory that carries lasting facts across chats.
- **Secure by default:** your key stays in VS Code secret storage and is removed from the environment of agent commands.

## Quick start

1. Install the extension, or search for **OpenRouter Client** in the VS Code Extensions view.
2. Open the **OpenRouter** tab in the Secondary Side Bar on the right, next to Chat.
3. Create a key at [openrouter.ai/keys](https://openrouter.ai/keys) and paste it on the setup screen. Keys look like `sk-or-v1-…`. The default API URL is `https://openrouter.ai/api`.
4. Pick a model and start chatting. Ask it to explain, write or fix code.

## Choosing a model

There are several hundred models, so the picker opens on a **Recommended** order: models with the best published benchmark scores that can also call tools, with duplicates and deprecated models pushed down. The two controls at the top change what you see.

**Sort by**

| Sort | Use it when |
| --- | --- |
| Recommended | You just want a good default, grouped by vendor |
| Cheapest first | Cost matters most. Free models come first |
| Strongest first | You want the highest published score, cost aside |
| Largest context | You are working with very large files |
| Name | You know what you are looking for |

**Filter by** tool support, free only, vision, or a single vendor. Filters stack, and the title shows how many models match.

Each row shows the price per million tokens for input and output, the context window, whether it supports tools, vision and reasoning, and its benchmark score where one is published. Notes on pricing:

- **free** costs nothing, with lower rate limits.
- **price varies** means a router such as `openrouter/auto` picks the model, so the cost depends on where the request lands.
- **priced per output** means an image or audio model that bills per image or per second rather than per token.
- Tool support is required for the agent to edit files. Models without it are still fine for chat.

## Economy mode

A long agent session spends credits on work that does not need your strongest model. The **Economy** toggle next to the model name moves that work to a cheap one:

- **conversation summaries**, which send the whole chat and are the most expensive request in a long session,
- **follow-up suggestions**, an extra request after every single reply,
- **sub-agents**, restricted to read-only tools so they research and report instead of editing.

**Your replies and every file edit stay on the model you picked.** Weaker models are unreliable at tool calling, and reviewing their edits costs back what delegating saved, so economy mode never hands them a file to change.

The chip shows roughly what has been saved in this chat. It is an estimate: it compares the tokens that really ran on the cheap model with the list price of the model you picked for the same tokens. When your model publishes no price, such as `openrouter/auto`, no saving can be worked out and none is claimed.

Economy mode delegates nothing when no model cheaper than your current one is available, so switching to a free model does not start pointless extra requests. Set `openrouter.economyModel` to choose the cheap model yourself, or turn off `openrouter.economySubagents` to keep sub-agents on your main model. `/economy on|off` works in the chat.

Two other ways to spend less, both on by default: **prompt caching** marks the stable parts of a request so repeated context is billed at the much lower cache-read rate, and long chats are **summarized** rather than resent in full.

## Credits

The chip in the chat and the status bar show your real OpenRouter balance, read with your own key. If the key carries its own spending limit, that limit is shown instead of the account balance, because it is the one that will stop your requests. Set `openrouter.monthlySpendLimit` to track a budget of your own as well.

## Configuration

See the settings under **OpenRouter Client** in VS Code settings, or `openrouter.*` in `settings.json`. The most useful ones:

| Setting | What it does |
| --- | --- |
| `openrouter.baseUrl` | API URL, default `https://openrouter.ai/api` |
| `openrouter.defaultModel` | Model used for new chats |
| `openrouter.permissionMode` | `ask`, `acceptEdits`, `plan` or `bypass` |
| `openrouter.maxTurns` | How many tool turns one request may take |
| `openrouter.subagents` | Allow the agent to spawn sub-agents |
| `openrouter.economy` | Start with economy mode on |
| `openrouter.economyModel` | Model for delegated work, empty picks the cheapest capable one |
| `openrouter.economySubagents` | In economy mode, run sub-agents on the cheap model |
| `openrouter.monthlySpendLimit` | Your own monthly budget, in USD |

## Credit where it is due

This extension began as a rename of [8bot for VS Code](https://github.com/upggr/8bot-vscode) by the same author, adapted from the Pax8 8os gateway to OpenRouter. Both are MIT licensed.

## License

[MIT](LICENSE)
