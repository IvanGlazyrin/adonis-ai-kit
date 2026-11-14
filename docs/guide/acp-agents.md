# ACP Coding Agents

The **Agent Client Protocol (ACP)** driver allows your AdonisJS backend to drive coding agents such as **Claude Code**, **opencode**, Gemini CLI, Codex, Qwen Code, or your own CLI binaries as child processes.

Install the optional peer package:

```bash
npm install @mcpc-tech/acp-ai-provider
```

---

## Configuring an ACP Provider

```ts
// config/ai.ts
providers: {
  // ...
  claude: {
    driver: 'acp',
    agentId: 'claude-code',      // built-in: claude-code, gemini, codex, qwen-code, opencode
    cwd: '/srv/projects/my-app', // absolute path
    permissionPolicy: 'ask',     // default
  },
}
```

| Option | Description |
| :--- | :--- |
| `agentId` | Built-in or registered agent (default `claude-code`) |
| `command` / `args` | Explicit executable for a custom agent (only values written in config are executed) |
| `cwd` | Working directory (absolute path) |
| `env` | Extra environment variables for the agent |
| `inheritEnv` | Forward the full server environment, secrets included (default `false`) |
| `mcpServers` | MCP servers attached to the agent session |
| `permissionPolicy` | `ask` (default, via `ai.getConfirmationService()`), `deny`, or `allow` (fully trusted sandboxes only) |
| `permissionTimeoutMs` | How long a permission request waits for a human (default 60000) |

ACP providers are never added to the fallback cascade automatically.

---

## Executing an ACP Agent

```ts
import ai from 'adonis-ai-kit/services/main'

const run = await ai.generateText({
  provider: 'claude',
  prompt: 'Analyze and fix TypeScript errors in packages/core',
})

console.log(run.text)
```

An agent manifest can also point at it with `provider: claude` and be loaded with `ai.agent()`.

---

## Registering a Custom ACP Agent

```ts
import { registerAcpAgent, buildAcpRuntimeConfig } from 'adonis-ai-kit/acp'

registerAcpAgent('my-agent', {
  id: 'my-agent',
  name: 'My Agent',
  description: 'In-house coding agent',
  command: 'my-agent-acp',
  args: [],
  envVarPrefix: 'ACP_MY_AGENT',
  supportsMcpServers: true,
  // For each target, the first set source is passed to the agent process as `target`
  credentialEnv: [{ target: 'MY_API_KEY', sources: ['MY_API_KEY', 'MY_KEY'] }],
})

const runtime = buildAcpRuntimeConfig('my-agent', {
  projectMcpPath: './mcp/server.js', // used when ACP_MY_AGENT_PROJECT_MCP_PATH is unset
  // the project MCP server is only attached when ACP_MY_AGENT_ENABLE_PROJECT_MCP=true
})
```

The `sourcecraft` and `freebuff` default agents are deprecated and will be removed from the defaults in 2.0. Register them with `registerAcpAgent()` if you need them.

ACP agents in a `models` chain ask a human through the manager's `ConfirmationService` (see `ai.getConfirmationService()`), like the provider cascade does.

---

## Environment Sanitization

To prevent leaking sensitive backend environment variables (such as database passwords or internal tokens) into coding sub-processes:
- Only a safe allowlist (for example `PATH`, `HOME`, `LC_*`, `XDG_*`), the agent's declared credentials (`credentialEnv`) and the provider's `env` are forwarded.
- `inheritEnv: true` forwards everything.
- Calling `buildAcpRuntimeConfig` + `createACPProvider` directly bypasses this sanitizing: the agent then inherits the full server environment.

---

## Fail-Closed Resilience

Because ACP agents can perform irreversible disk writes or terminal operations, a retryable ACP failure is thrown as `AcpCallFailedError` (`E_AI_ACP_CALL_FAILED`, `sideEffectsPossible: true`, the agent's error in `original`).

The failover cascade never re-runs the request on another model after an ACP failure (an ACP timeout included), preventing duplicate disk modifications or conflicting commands.
