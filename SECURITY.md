# Security

Report vulnerabilities privately through [GitHub security advisories](https://github.com/upggr/openrouter-client/security/advisories/new), not in a public issue.

## How OpenRouter Client protects you

- API keys are kept in VS Code secret storage and are removed from the environment of agent commands.
- The gateway URL and permission mode are user-level settings, so a repository cannot redirect your key or enable Bypass.
- The extension does not run in untrusted workspaces.
- Outside Bypass mode, file tools stay inside the workspace, including through symlinks.
- Outside Bypass mode, secrets and files that can trigger code execution need approval.
- The chat view uses a strict Content Security Policy and escapes model output.

## Known risk

An AI agent can be misled by malicious text in files, web pages or command output. Permission prompts are your main defense, and Bypass mode removes them. Review what you approve.
