# Tools & Security Guardrails

Uncontrolled tool execution presents severe operational risks. `adonis-ai-kit` provides a fail-closed `ToolRegistry` and policy enforcement framework.

---

## Tool Registry

Tools are registered through the centralized `ToolRegistry` (the manager's own is `ai.getToolRegistry()`):

```ts
import { ToolRegistry } from 'adonis-ai-kit/guard'
import { tool } from 'ai'
import { z } from 'zod'

const registry = new ToolRegistry()

// Register read-only tool
registry.registerTool(
  'get_weather',
  tool({
    description: 'Get weather for city',
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }) => ({ temp: 22, condition: 'Sunny' }),
  }),
  'allow'
)

// Register high-impact tool requiring human approval
registry.registerTool(
  'restart_cluster',
  tool({
    description: 'Restart production Kubernetes cluster',
    inputSchema: z.object({ clusterId: z.string() }),
    execute: async ({ clusterId }) => ({ restarted: true }),
  }),
  'ask'
)

// Per-agent overrides
registry.setAgentPermissions('support-bot', { restart_cluster: 'deny' })
```

---

## Permission Tiers (`allow`, `ask`, `deny`)

| Permission | Behavior |
| :--- | :--- |
| **`allow`** | Tool executes automatically without interruption |
| **`ask`** | Tool waits for a human confirmation before running; without a `ConfirmationService` every call is refused |
| **`deny`** | Tool is not offered to the model |

A permission is looked up in the agent's matrix (`setAgentPermissions`), then the tool's own default (`registerTool(name, tool, permission)`), then `askByDefault`.

> [!IMPORTANT]
> The registry operates on a **deny-by-default** model (`defaultPermission: 'deny'`): tools without a permission cannot run.
> `AiManager` reads `toolPermissions` from each call instead: there, a tool with no entry is `allow`, except MCP tools, which stay `deny`. Use `registry.getToolsWithApprovals(agentName)` to get both `tools` and `toolPermissions` for a manager call.

```ts
const { tools, toolPermissions } = registry.getToolsWithApprovals('support-bot')
await ai.generateText({ prompt, tools, toolPermissions })
```

---

## PolicyGuard Rules

The `PolicyGuard` enforces an allow-list, a maximum number of calls, and argument rules:

```ts
import { PolicyGuard, rangeRule, enumRule } from 'adonis-ai-kit/guard'

const guard = new PolicyGuard({
  maxCalls: 5, // Maximum 5 tool calls for this guard instance (create one per request)
  allowedTools: ['issue_refund', 'lookup_order'],
  rules: {
    issue_refund: [
      rangeRule('refundAmount', 0, 200), // Refund never exceeds $200
      enumRule('currency', ['USD', 'EUR']),
    ],
  },
})

// Per call through the manager
await ai.generateText({ prompt, tools, toolPermissions, toolGuard: { guard } })

// Or on registry tools handed to your own code
const guarded = registry.getToolsForAgent('support-bot', {
  guard,
  confirmation: ai.getConfirmationService(), // without it, `ask` tools refuse every call
})
```

- A custom rule is `{ field, validate: (value, allArgs) => string | null }` (an error message or `null`); add one later with `guard.addRule(toolName, rule)`.
- `check()` reserves a call slot, so parallel tool calls cannot all pass `maxCalls` at once.

> [!WARNING]
> Tools from `getToolsForAgent()` already carry the registry's `ask` wrapper. Do not pass them to `ai.generateText` with `toolPermissions` marking them `ask` as well; use `getToolsWithApprovals()` for manager calls.

---

## Streaming Tools

A streaming tool (an `async function*`) runs once and gives only its final value (the last chunk) when it runs under a tool guard, with an `ask` permission, or with resumable approvals in the call that continues a paused step (`resolveApprovals` / `resume`). Its intermediate chunks are then not shown to the model or to the caller. Without these wrappers it streams as usual.
