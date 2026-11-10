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

## Handing work to another AI

`/handover` asks the model to write a short state document to `.openrouterclient/handover.md`: the goal, what is done, the files that matter, decisions and their reasons, dead ends, and the single next step. `/resume` starts a fresh chat from that document.

It is deliberately **not** a transcript. A saved session is tens of thousands of tokens of file contents and command output: expensive to resume from, and meaningless to a different tool. A page of prose is cheap to read and portable, so you can also just point Claude Code, Cursor or Copilot at the file, or commit it for a colleague.

Two things to know:

- **The folder is not secret.** It lives in your repository, so `/handover` adds `.openrouterclient/` to your `.gitignore` the first time. Delete that line if you would rather commit the handover and share it through git.
- **Secrets are stripped.** The model is told never to include credentials, and anything that still looks like an API key, token or `SECRET=…` assignment is replaced with `[redacted]` before the file is written. Read it before you commit it anyway.

Full chat history stays in VS Code's own per-workspace storage, as before. The handover is the part meant to leave the machine.

## Economy mode

A long agent session spends credits on work that does not need your strongest model. The **Economy** toggle next to the model name moves that work to a cheap one:

- **conversation summaries**, which send the whole chat and are the most expensive request in a long session,
- **follow-up suggestions**, an extra request after every single reply,
- **sub-agents**, restricted to read-only tools so they research and report instead of editing.

**Your replies and every file edit stay on the model you picked.** Weaker models are unreliable at tool calling, and reviewing their edits costs back what delegating saved, so economy mode never hands them a file to change.

The chip shows roughly what has been saved in this chat. It is an estimate: it compares the tokens that really ran on the cheap model with the list price of the model you picked for the same tokens. When your model publishes no price, such as `openrouter/auto`, no saving can be worked out and none is claimed.

Economy mode delegates nothing when no model cheaper than your current one is available, so switching to a free model does not start pointless extra requests. Set `openrouter.economyModel` to choose the cheap model yourself, or turn off `openrouter.economySubagents` to keep sub-agents on your main model. `/economy on|off` works in the chat.

Other ways the extension keeps the bill down, all on by default:

- **Prompt caching** marks the stable parts of a request, so repeated context is billed at the much lower cache-read rate.
- **Long chats are summarized** rather than resent in full.
- **Plan mode only pays for the tools it can use.** Edit and command schemas are left out of requests that would refuse them anyway.
- **`openrouter.maxTurns`** caps how many paid requests one message can turn into, so a model stuck in a loop cannot run up a bill. The default is 50; the agent asks you to send `continue` if it needs more.
- **`openrouter.monthlySpendLimit`** refuses to send once your own budget for the month is gone, and says so rather than failing quietly. Your real OpenRouter balance stops requests too, so an empty account never silently retries.

## Credits

The chip in the chat and the status bar show your real OpenRouter balance, read with your own key. If the key carries its own spending limit, that limit is shown instead of the account balance, because it is the one that will stop your requests. Set `openrouter.monthlySpendLimit` to cap your own monthly spend as well: once it is reached, OpenRouter Client refuses to send and tells you which setting to change.

## Configuration

See the settings under **OpenRouter Client** in VS Code settings, or `openrouter.*` in `settings.json`. The most useful ones:

| Setting | What it does |
| --- | --- |
| `openrouter.baseUrl` | API URL, default `https://openrouter.ai/api` |
| `openrouter.defaultModel` | Model used for new chats |
| `openrouter.permissionMode` | `ask`, `acceptEdits`, `plan` or `bypass` |
| `openrouter.maxTurns` | How many paid turns one message may take, default 50 |
| `openrouter.subagents` | Allow the agent to spawn sub-agents |
| `openrouter.economy` | Start with economy mode on |
| `openrouter.economyModel` | Model for delegated work, empty picks the cheapest capable one |
| `openrouter.economySubagents` | In economy mode, run sub-agents on the cheap model |
| `openrouter.monthlySpendLimit` | Your own monthly budget, in USD |

## Credit where it is due

This extension began as a rename of [8bot for VS Code](https://github.com/upggr/8bot-vscode) by the same author, adapted from the Pax8 8os gateway to OpenRouter. Both are MIT licensed.

## License

[MIT](LICENSE)
