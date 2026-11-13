# Token Budget & Live Cost

Financial visibility and token budget enforcement prevent runaway costs in AI microservices.

---

## Live USD Cost Calculations

Every invocation computes its cost when pricing for the model is known:

```ts
const response = await ai.generateText({ prompt: 'Draft press release' })

console.log(response.costUsd) // e.g. 0.00342 (undefined when no pricing is known)
```

Prices (USD per 1M tokens) come from the `models.dev` catalog (`catalog.autoPricing`, default on) or `config.budget.pricing`:

```ts
// config/ai.ts
budget: {
  pricing: {
    'my-model': { input: 3, output: 15, cacheReadCostPer1M: 0.3, cacheWriteCostPer1M: 3.75 },
  },
}
```

The calculation accounts for:
- Input tokens (cached tokens excluded).
- Output tokens.
- Cache reads and writes (at `cacheReadCostPer1M` / `cacheWriteCostPer1M`, else at the input rate).
- Reasoning tokens (at `reasoningCostPer1M` when set, else at the output rate).

---

## CostTracker (Ring Buffer)

The manager's `CostTracker` records every call inside a fixed-size ring buffer:

```ts
import ai from 'adonis-ai-kit/services/main'

const tracker = ai.getCostTracker()

console.log(tracker.getTotalCost())   // USD
console.log(tracker.getTotalTokens())
console.log(tracker.getByAgent()['support-bot']) // { tokens, cost, calls, avgDurationMs, totalDurationMs }
console.log(tracker.getByModel())
```

A standalone tracker is created with `new CostTracker({ maxRecords: 10_000, pricing, sink })` from `adonis-ai-kit/budget`. Memory stays bounded by `maxRecords` (default 10,000) under sustained load, while the running aggregates stay exact.

---

## Atomic Token Budget Enforcement

In concurrent Node.js web applications, `canAgentContinue()` followed by an LLM call is racy. The `BudgetEnforcer` (one instance per session) provides pre-flight atomic reservations:

```ts
import { BudgetEnforcer } from 'adonis-ai-kit/budget'

const enforcer = new BudgetEnforcer({
  perSessionMaxCostUsd: 10.0,
  perSessionMaxTokens: 500_000,
  perAgentMaxTokens: 100_000,
})

// 1. Reserve tokens atomically for an agent before calling the LLM
const reservation = enforcer.reserve('support-bot', 5_000, 0.05)
if (!reservation) {
  throw new Error('Session budget exceeded')
}

try {
  const result = await ai.generateText({ prompt: '...', agentName: 'support-bot' })
  // 2. Settle with actual usage
  enforcer.settle(reservation, result.usage.totalTokens, result.costUsd ?? 0)
} catch (error) {
  // 3. Release capacity if call failed
  enforcer.release(reservation)
  throw error
}
```

A call may proceed while `used + reserved + projected` stays strictly below the limit. Defaults: 50,000 tokens per agent, 200,000 per session, no cost limit. `getSummary()` reports usage.

For tool loops, `stopOnBudget(limits, ai.getCostTracker())` stops the loop once a token or cost limit is exceeded (see [Step Control](/guide/step-control-and-cache#stopping-conditions-stopwhen)).

The `budget.maxTokensPerRequest` and `budget.maxCostPerRequestUsd` config keys only log a warning when a call goes over them. They do not stop the call, so use `stopOnBudget` or `BudgetEnforcer` when a limit must hold.
