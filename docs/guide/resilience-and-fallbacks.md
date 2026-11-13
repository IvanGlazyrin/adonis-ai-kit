# Resilience, Failover & Circuit Breakers

Production AI applications face rate limits, network disruptions, and provider degradation. `adonis-ai-kit` provides multi-tier SRE resilience.

---

## Cascading Multi-Provider Failover

Configure an ordered list of fallback providers in `config/ai.ts`:

```ts
// config/ai.ts
export default defineConfig({
  default: 'openai',
  providers: { /* openai, anthropic, gemini */ },
  fallbackCascade: ['anthropic', 'gemini'],
  fallbackModels: { gemini: 'gemini-3.5-flash' }, // optional, else the provider's defaultModel
})
```

If OpenAI returns `429 Too Many Requests` or `503 Service Unavailable`, `adonis-ai-kit` routes the request to Anthropic with its configured model, then to Gemini if needed. When `fallbackCascade` is omitted, every other provider except `acp` and `custom` ones is a fallback.

- `streamText` falls back only on errors before the first chunk.
- Set `maxRetries: 0` on a call to skip the AI SDK's own retries and fail over sooner.
- Tokens a failed attempt consumed are recorded in the cost tracker with `failed: true`.
- With a `models` chain, the entries of the chain are tried instead of the cascade (see [Configuration](/guide/configuration#dynamic-multi-tenant-credentials)).

---

## Circuit Breakers (Per `provider:model`) {#circuit-breaker-per-provider-model}

To avoid hammering degraded providers with repeated requests, an isolated circuit breaker tracks each `provider:model` pair (in `models` chains, each `credentialKey`):

```ts
circuitBreaker: {
  failureThreshold: 5,        // Trip circuit after 5 consecutive failures
  recoveryTimeoutMs: 30_000,  // Wait 30s before testing with probe requests
  halfOpenMaxAttempts: 2,     // Require 2 successful probe requests to close
  halfOpenMaxConcurrent: 1,   // Probes allowed in flight while half-open
  onStateChange: (key, from, to) => logger.warn(`${key}: ${from} -> ${to}`),
}
```

- **Isolated Tracking:** A failure in `openai:gpt-6-sol` trips its breaker without affecting other OpenAI models or other providers.
- **Fail-Fast:** When a circuit is open, the candidate is skipped without a network call and the next one is tried.
- `ai.getCircuitBreaker().getStats('openai:gpt-6-sol')` returns its state.

---

## Fail-Closed Side-Effect Protection

> [!IMPORTANT]
> `adonis-ai-kit` enforces strict fail-closed safety for tool calls: **Failover is refused once a side effect may have occurred.**

Failover is refused:
1. After any local tool has run.
2. After a provider-executed tool call (e.g. server-side web search) has been made.
3. After a retryable failure of an ACP coding agent: it is thrown as `AcpCallFailedError` (`sideEffectsPossible: true`), so an ACP timeout does not switch models.

A failure after a tool has executed throws the attempt's own error. This prevents duplicate executions of non-idempotent operations (such as processing payments or triggering webhook events). It applies to `AiManager` and `runModelChain`; direct AI SDK calls need `attemptSideEffectHooks`.

---

## Error Classification

Exceptions are classified into actionable error categories (`classifyError`, `isRetryableError`):

- **Retryable / Failover Eligible:** `429` rate limit, `409` / `425` / `529` overloaded, `408` timeout, `5xx` server errors, network errors, and "no output generated".
- **Fail-Fast (No Failover):** `400` invalid request, `401` / `403` auth errors, `404` model not found, and caller aborts (`abortSignal`, `stream.abort()`).
- **Context Window Exceeded (`prompt_too_long`):** Falls back to the next model without counting against the circuit breaker.

When every candidate fails with a retryable error, or its breaker is open, the call throws `CascadingFallbackError` (`E_AI_FALLBACK_FAILED`). Its `attempts` array lists each provider, model and error. A non-retryable error is thrown as it is, without trying the next candidate.
