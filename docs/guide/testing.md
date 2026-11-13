# Testing & Test Doubles

The `adonis-ai-kit/testing` module replaces the model, not the manager, so fallback, the circuit breaker, guards and cost tracking run for real, without live network requests or API costs.

---

## Mocking Models & Tools

Test interactions deterministically using `fakeModel`, `fakeProvider`, and `fakeTools`:

```ts
// tests/unit/agent_test.spec.ts
import { test } from '@japa/runner'
import { fakeModel, fakeProvider, fakeTools } from 'adonis-ai-kit/testing'
import { AiManager, defineConfig } from 'adonis-ai-kit'

test.group('Order Agent', () => {
  test('invokes order tracking tool and formats response', async ({ assert }) => {
    // 1. Script the model's answers (one entry per model call)
    const model = fakeModel([
      { toolCalls: [{ name: 'trackOrder', input: { orderId: 'ORD-101' } }] },
      { text: 'Order ORD-101 is out for delivery.', usage: { input: 80, output: 25 } },
    ])

    const tools = fakeTools({
      trackOrder: () => ({ status: 'Out for delivery' }),
    })

    const manager = new AiManager(
      defineConfig({
        default: 'mock',
        providers: { mock: fakeProvider(model) },
      })
    )

    const response = await manager.generateText({
      prompt: 'Status of order ORD-101',
      tools: tools.tools,
      maxSteps: 2,
    })

    assert.equal(response.text, 'Order ORD-101 is out for delivery.')
    tools.assertToolCalled('trackOrder', { orderId: 'ORD-101' })
    model.assertCalledTimes(2)
  })
})
```

- A script entry is a `FakeStep` (`text`, `toolCalls`, `object`, `usage`, `finishReason`, `error`) or a function that receives the call. An exhausted script throws `FakeScriptExhaustedError`.
- Usage defaults to 10 input and 10 output tokens (`usage: { input, output, cacheRead, cacheWrite, reasoning }`).
- Model assertions: `calls`, `assertCalledTimes`, `assertPromptContains`, `assertToolOffered`, `assertToolNotOffered`, `assertProviderOption`. Tool assertions: `inputs`, `assertToolCalled(name, match?)`, `assertToolNotCalled`. A failed assertion throws `FakeAssertionError`.
- `fakeLanguageModels({ 'provider/model': model })` and `fakeResolver()` cover `models` chains.

---

## Testing Failover & Outages

Simulate API rate limits (`429`) or server downtime (`503`) with `fakeApiError(status)`, which is classified like a provider error:

```ts
import { fakeModel, fakeProvider, fakeApiError } from 'adonis-ai-kit/testing'

test('fails over to secondary provider on 429 rate limit', async ({ assert }) => {
  const primary = fakeModel([{ error: fakeApiError(429) }])
  const secondary = fakeModel([{ text: 'Response from secondary' }])

  const manager = new AiManager(
    defineConfig({
      default: 'primary',
      providers: {
        primary: fakeProvider(primary),
        secondary: fakeProvider(secondary),
      },
      fallbackCascade: ['secondary'],
    })
  )

  // maxRetries: 0 stops the AI SDK from retrying the 429 on the same model
  const response = await manager.generateText({ prompt: 'Hello', maxRetries: 0 })
  assert.equal(response.text, 'Response from secondary')
})
```

---

## Testing Custom Conversation Stores

If you implement a custom `ConversationStore` adapter, run the standard contract test suite against it:

```ts
import { test } from '@japa/runner'
import { conversationStoreContract } from 'adonis-ai-kit/testing'
import { CustomStore } from '#services/custom_store'

for (const check of conversationStoreContract(() => new CustomStore())) {
  test(`conversation store: ${check.name}`, () => check.run())
}
```
