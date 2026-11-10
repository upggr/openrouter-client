# Contributing

Issues and pull requests are welcome.

1. Install Node.js 22 or later, then run `npm install`.
2. Press `F5` in VS Code to launch an Extension Development Host.
3. Before opening a pull request, run `npm run lint` and `npm test`.

`src/core` must stay free of `vscode` imports so it can be tested directly. VS Code integration belongs in `src/vscode`.

Every change ships as a version bump in `package.json` with a matching `## <version>` section in `CHANGELOG.md`. CI fails without both.

Never commit API keys. For live tests, copy `.env.example` to `.env`, which git ignores. `.openrouterclient/` holds handover notes the agent writes into a workspace and is ignored too.
