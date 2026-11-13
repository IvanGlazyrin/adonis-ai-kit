# Text & Chat Generation

## Basic Text Generation

The primary entry point for generating responses is `ai.generateText()`:

```ts
import ai from 'adonis-ai-kit/services/main'

const response = await ai.generateText({
  system: 'You are a technical documentation assistant.',
  prompt: 'Summarize the architecture of AdonisJS 7 in two sentences.',
})

console.log(response.text)
```

### Options

| Option | Type | Description |
| :--- | :--- | :--- |
| `prompt` | `string` | The user prompt to send to the model |
| `system` | `string` | System-level prompt or instructions |
| `provider` | `string` | Specific provider key from `config/ai.ts` |
| `model` | `string` | Model name (e.g. `'gpt-6-sol'`, `'claude-sonnet-5-5'`) |
| `temperature` | `number` | Sampling temperature (`0.0` to `2.0`) |
| `maxOutputTokens` | `number` | Maximum tokens to generate |
| `messages` | `ModelMessage[]` | A message list (`prompt` must be a string) |
| `tools` | `ToolSet` | Tools available for this call |
| `toolPermissions` | `Record<string, ToolPermission>` | `allow` / `ask` / `deny` per tool; unlisted tools are `allow` (MCP tools `deny`) |
| `maxSteps` | `number` | Maximum model steps in a tool loop (default `1`) |
| `stopWhen` | `StopCondition \| StopCondition[]` | Custom stop condition(s); takes precedence over `maxSteps` |
| `schema` | `ZodType` | Structured output, exposed as `output`; works together with `tools` |
| `maxRetries` | `number` | AI SDK retries per model (`0` fails over sooner) |
| `models` | `Array<ResolvedModel \| string>` | Dynamic model chain instead of the provider cascade |
| `conversation` | `{ id, owner, prepareHistory? }` | Continues a stored conversation |
| `abortSignal` | `AbortSignal` | Cancels the call |
| `agentName` | `string` | Attributes cost and budget to this agent name |
| `activeTools` | `string[]` | Only these tools are offered in every step; denied tools stay denied |
| `prepareStep` | `function` | Runs before each tool-loop step and may narrow `activeTools` (a returned `model` is ignored) |
| `repairToolCall` | `function` | Fixes a tool call with an unknown name or invalid input before it fails |
| `onStepFinish` | `function` | Called after every model step |
| `toolGuard` | `{ guard?, confirmation?, timeoutMs? }` | Policy guard, confirmation service and wait timeout for this call's tools |
| `approvals` | `'blocking' \| 'resumable'` | How `ask` tools wait: in memory, or as a stored pause resumed with `ai.conversations.resolveApprovals()` |
| `promptCache` | `{ instructions?, tools? }` | Anthropic prompt-cache breakpoints, each `'5m'` or `'1h'` |
| `jsonRecovery` | `boolean` | Strips prose and code fences around the JSON before the schema check (off by default) |

---

## Token Usage & Live Cost

Every call returns a normalized token breakdown, the duration, and the USD cost when pricing for the model is known (`models.dev` catalog or `config.budget.pricing`):

```ts
const response = await ai.generateText({ prompt: 'Draft a release note' })

console.log(response.usage)
// {
//   inputTokens: 350,      // includes cached tokens
//   outputTokens: 120,     // includes reasoning tokens
//   totalTokens: 470,
//   cacheReadTokens: 0,
//   cacheWriteTokens: 0,
//   reasoningTokens: 0,
//   ...
// }

console.log(`Duration: ${response.durationMs}ms`)
console.log(`Cost: $${response.costUsd?.toFixed(6) ?? 'n/a'} USD`) // costUsd is undefined without pricing
```

---

## Structured Output with Zod

To guarantee that the model produces strongly typed, validated JSON conforming to your domain schemas, use `ai.generateObject()`:

```ts
import { z } from 'zod'
import ai from 'adonis-ai-kit/services/main'

const userProfileSchema = z.object({
  name: z.string(),
  email: z.string().email(),
  roles: z.array(z.enum(['admin', 'member', 'guest'])),
  preferences: z.object({
    theme: z.enum(['light', 'dark', 'system']),
    notifications: z.boolean(),
  }),
})

const { object } = await ai.generateObject({
  prompt: 'Extract user profile: Alex Smith (alex@example.com), admin user, prefers dark mode and notifications enabled.',
  schema: userProfileSchema,
})

console.log(object.name) // 'Alex Smith'
console.log(object.roles) // ['admin']
```

### Automatic JSON Recovery

Models occasionally wrap JSON output in markdown fences (` ```json `) or precede it with conversational filler. Setting `jsonRecovery: true` strips the text around the first JSON value (`extractFirstJsonValue`) before it is parsed with the schema. It is off by default:

```ts
const { object } = await ai.generateObject({
  prompt: '...',
  schema: userProfileSchema,
  jsonRecovery: true,
})
```
