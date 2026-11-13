# Step Control, Prompt Cache & Recovery

## Step Control (`prepareStep`)

The `prepareStep` hook (AI SDK) runs before each step of the multi-step tool loop and can narrow the tools offered:

```ts
import ai from 'adonis-ai-kit/services/main'

const result = await ai.generateText({
  prompt: 'Troubleshoot database latency and optimize slow queries.',
  tools: { queryMetrics, explainQuery, createIndex },
  maxSteps: 6,
  prepareStep: ({ stepNumber }) => {
    // Only allow index creation after the first diagnostic steps
    if (stepNumber < 2) {
      return { activeTools: ['queryMetrics', 'explainQuery'] }
    }
    return { activeTools: ['createIndex'] }
  },
})
```

- A `model` returned by `prepareStep` is ignored with a warning: fallback, the circuit breaker and cost stay bound to the attempt's model. `AgentRunner` also drops any `instructions` or `system` it returns.
- Tools cannot be added here, only narrowed; a denied tool stays denied even when named in `activeTools`.
- `maxSteps` defaults to 1.

---

## Stopping Conditions (`stopWhen`)

Halt multi-step loops safely when specific criteria are satisfied. `stopWhen` takes precedence over `maxSteps`:

```ts
import { stepCountIs } from 'ai'
import { stopOnBudget } from 'adonis-ai-kit/budget'
import ai from 'adonis-ai-kit/services/main'

const result = await ai.generateText({
  prompt: '...',
  tools,
  stopWhen: [
    stepCountIs(8),
    stopOnBudget({ maxCostUsd: 0.5, maxTokens: 40_000 }, ai.getCostTracker()),
  ],
})
```

`stopOnBudget` ends the loop after the step that exceeds a limit; pass `{ extra: spend }` (a `SubAgentSpend`) to count sub-agent usage too.

---

## Tool Call Repair (`repairToolCall`)

When a model calls a nonexistent tool or sends invalid input, `repairToolCall` (AI SDK) lets you fix the call before it fails:

```ts
const result = await ai.generateText({
  prompt: 'Calculate shipping costs',
  tools: { calculate_shipping: shippingTool },
  repairToolCall: async ({ toolCall }) => {
    if (toolCall.toolName === 'calculateShipping') {
      return { ...toolCall, toolName: 'calculate_shipping' }
    }
    return null // no repair: the original error is raised
  },
})
```

---

## Anthropic Prompt Caching (`promptCache`)

Declare cache breakpoints for Anthropic Claude models:

```ts
const result = await ai.generateText({
  system: massiveKnowledgeBasePrompt, // Cached for 1 hour!
  prompt: 'Find our refund policy',
  tools,
  promptCache: {
    instructions: '1h', // '5m' or '1h'
    tools: '1h',
  },
})
```

- `instructions` marks the system prompt; `tools` marks the last tool, with tools sorted by name so the cached prefix stays stable. At most four breakpoints are sent.
- A one-hour instructions cache needs a one-hour tools cache (when tools are cached), and a request-level one-hour cache (`providerOptions.anthropic.cacheControl`) needs every explicit breakpoint to be one hour; other combinations throw `E_AI_INVALID_ARGUMENT` before the call.
- Do not narrow tools per step (`activeTools`, `prepareStep`) when `promptCache.tools` is set: a different tool list changes the cached prefix.

Later requests with the same prefix are billed at the cache-read rate.

---

## JSON Recovery (`jsonRecovery`)

Strip conversational wrappers or markdown code fences around a JSON answer before it is parsed with the schema:

```ts
const { object } = await ai.generateObject({
  prompt: 'Return a summary of this ticket',
  schema: ticketSchema,
  jsonRecovery: true, // Strips the prose and fences around the first JSON value
})
```

It is off by default and also works with `schema` on `generateText` / `streamText`. The helper itself is exported as `extractFirstJsonValue`.
