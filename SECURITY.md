# Security policy

## Supported versions

Security fixes go into the latest 1.x release. Older releases do not get fixes.

## Reporting a vulnerability

Report it privately. Do not open a public issue.

1. Open the repository [IvanGlazyrin/adonis-ai-kit](https://github.com/IvanGlazyrin/adonis-ai-kit) on GitHub.
2. Go to the Security tab, then Advisories, and choose "Report a vulnerability".
3. Describe the problem, the version, and how to reproduce it.

You will get an answer in the advisory thread. Please do not publish details until a fix is released.

## What the package runs with your process's rights

Some features start local programs or pass untrusted text to the model. Treat them as part of your trusted base and set them up with that in mind.

- **stdio MCP servers** are commands that run with your process's rights. The child process gets only a whitelist of the environment (for example `PATH`) plus the `env` you set in the config. Run such servers in a container or as a separate user. See [docs/guide/mcp-tools.md](docs/guide/mcp-tools.md).
- **ACP agents** are local commands started as child processes. Only a `command` and `args` written in your config are executed. `inheritEnv: true` gives the agent the full server environment, secrets included. See [docs/guide/acp-agents.md](docs/guide/acp-agents.md).
- **`permissionPolicy: 'allow'`** approves every action an ACP agent asks for. Use it only in fully trusted sandboxes. The default is `ask`.
- **MCP tool descriptions and tool results are untrusted input.** The kit cleans descriptions, but it does not filter tool results. Prompt injection can come through either. MCP tools are denied until you give them a permission, and `ask` is the right permission for tools with side effects.

The documentation pages above describe each of these in full.
