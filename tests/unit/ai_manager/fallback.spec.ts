import { test } from '@japa/runner'
import { APICallError, tool } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import { AiManager } from '../../../src/ai_manager.js'
import { defineConfig } from '../../../src/define_config.js'

const usage = (inp: number, out: number) => ({
  inputTokens: { total: inp, noCache: inp, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: out, text: out, reasoning: 0 },
})
const finish = () => ({ unified: 'stop' as const, raw: 'stop' })

/** A model that counts its calls and answers with `text`, or throws `failure` when given one. */
const model = (modelId: string, opts: { text?: string; failure?: unknown } = {}) => {
  const calls = { count: 0 }
  const m = new MockLanguageModelV4({
    provider: 'mock',
    modelId,
    doGenerate: async () => {
      calls.count++
      if (opts.failure) throw opts.failure
      return {
        content: [{ type: 'text', text: opts.text ?? `from ${modelId}` }],
        finishReason: finish(),
        usage: usage(1, 1),
        warnings: [],
      }
    },
  })
  return { m, calls }
}

const retryable = () =>
  new APICallError({ message: 'overloaded', url: 'https://x', requestBodyValues: {}, statusCode: 503, isRetryable: true })

const fatal = () =>
  new APICallError({ message: 'bad key', url: 'https://x', requestBodyValues: {}, statusCode: 401, isRetryable: false })

const manager = (
  providers: Record<string, ReturnType<typeof model>>,
  extra: Record<string, unknown> = {}
) =>
  new AiManager(
    defineConfig({
      default: 'a',
      providers: Object.fromEntries(
        Object.entries(providers).map(([name, { m }]) => [
          name,
          { driver: 'custom', factory: () => m, defaultModel: 'base' },
        ])
      ),
      catalog: { autoPricing: false },
      ...extra,
    } as any),
    { info() {}, warn() {}, error() {}, debug() {} }
  )

test.group('AiManager provider fallback', () => {
  test('a retryable failure moves the call to the next provider in the cascade', async ({ assert }) => {
    const a = model('a-model', { failure: retryable() })
    const b = model('b-model')
    const m = manager({ a, b }, { fallbackCascade: ['b'] })

    const result = await m.generateText({ prompt: 'hi', maxRetries: 0 })

    assert.equal(result.provider, 'b')
    assert.equal(result.text, 'from b-model')
    assert.equal(a.calls.count, 1)
    assert.equal(b.calls.count, 1)
  })

  test('a fallback provider uses its configured fallback model name', async ({ assert }) => {
    const a = model('a-model', { failure: retryable() })
    const b = model('b-special')
    const m = manager({ a, b }, { fallbackCascade: ['b'], fallbackModels: { b: 'b-special' } })

    const result = await m.generateText({ prompt: 'hi', maxRetries: 0 })

    assert.equal(result.model, 'b-special')
  })

  test('a fatal error is thrown at once with no fallback', async ({ assert }) => {
    const a = model('a-model', { failure: fatal() })
    const b = model('b-model')
    const m = manager({ a, b }, { fallbackCascade: ['b'] })

    await assert.rejects(() => m.generateText({ prompt: 'hi', maxRetries: 0 }))
    assert.equal(b.calls.count, 0)
  })

  test('once a tool has run, a later failure is not retried on another provider', async ({ assert }) => {
    let step = 0
    const a = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'a-model',
      doGenerate: async () => {
        step++
        if (step === 1) {
          return {
            content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'ping', input: '{}' }],
            finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
            usage: usage(1, 1),
            warnings: [],
          }
        }
        throw retryable()
      },
    })
    const b = model('b-model')
    const ping = tool({ description: 'ping', inputSchema: z.object({}), execute: async () => 'pong' })
    const m = manager({ a: { m: a, calls: { count: 0 } }, b }, { fallbackCascade: ['b'] })

    await assert.rejects(() => m.generateText({ prompt: 'hi', maxRetries: 0, maxSteps: 2, tools: { ping } }))
    assert.equal(b.calls.count, 0)
  })

  test('when every provider fails the error lists each attempt', async ({ assert }) => {
    const a = model('a-model', { failure: retryable() })
    const b = model('b-model', { failure: retryable() })
    const m = manager({ a, b }, { fallbackCascade: ['b'] })

    try {
      await m.generateText({ prompt: 'hi', maxRetries: 0 })
      assert.fail('expected every provider to fail')
    } catch (err: any) {
      assert.equal(err.name, 'CascadingFallbackError')
      assert.lengthOf(err.attempts, 2)
      assert.deepEqual(
        err.attempts.map((x: { provider: string }) => x.provider),
        ['a', 'b']
      )
    }
  })

  test('a provider/model string whose prefix is configured selects that provider', async ({ assert }) => {
    const a = model('a-model')
    const b = model('b-model')
    const m = manager({ a, b })

    const result = await m.generateText({ prompt: 'hi', model: 'b/custom-id', maxRetries: 0 })

    assert.equal(result.provider, 'b')
    assert.equal(result.model, 'custom-id')
  })

  test('a model string with a slash but an unknown prefix is a plain model name', async ({ assert }) => {
    const a = model('a-model')
    const m = manager({ a })

    const result = await m.generateText({ prompt: 'hi', model: 'org/some-model', maxRetries: 0 })

    assert.equal(result.provider, 'a')
    assert.equal(result.model, 'org/some-model')
  })
})

test.group('AiManager model resolution without a configured defaultModel', () => {
  test('the driver default model is used, never the literal "default"', async ({ assert }) => {
    const requested: string[] = []
    const m = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'driver-default',
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'ok' }],
        finishReason: finish(),
        usage: usage(1, 1),
        warnings: [],
      }),
    })
    const manager = new AiManager(
      defineConfig({
        default: 'solo',
        providers: {
          solo: {
            driver: 'custom',
            factory: () => (name: string) => {
              requested.push(name)
              return m
            },
          },
        },
        catalog: { autoPricing: false },
      } as any),
      { info() {}, warn() {}, error() {}, debug() {} }
    )

    const result = await manager.generateText({ prompt: 'hi', maxRetries: 0 })

    assert.deepEqual(requested, ['custom'])
    assert.equal(result.model, 'custom')
  })
})
