import { test } from '@japa/runner'
import { APICallError, tool } from 'ai'
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'
import { z } from 'zod'
import { AiManager } from '../../../src/ai_manager.js'
import { defineConfig } from '../../../src/define_config.js'
import { ProviderConfigError } from '../../../src/errors.js'
import { LanguageModelFactory, ProviderFactoryRegistry } from '../../../src/models/index.js'
import type { ResolvedModel } from '../../../src/models/index.js'

const usage = (inp: number, out: number) => ({
  inputTokens: { total: inp, noCache: inp, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: out, text: out, reasoning: 0 },
})
const finish = (unified: 'stop' | 'tool-calls' = 'stop') => ({ unified, raw: unified })

const rateLimit = () =>
  new APICallError({
    message: 'rate limited',
    url: 'http://x',
    requestBodyValues: {},
    statusCode: 429,
    isRetryable: true,
  })

const unauthorized = () =>
  new APICallError({
    message: 'unauthorized',
    url: 'http://x',
    requestBodyValues: {},
    statusCode: 401,
    isRetryable: false,
  })

const unauthorizedModel = (id: string) =>
  new MockLanguageModelV4({
    provider: 'mock',
    modelId: id,
    doGenerate: async () => {
      throw unauthorized()
    },
    doStream: async () => {
      throw unauthorized()
    },
  })

const textModel = (id: string, text: string) =>
  new MockLanguageModelV4({
    provider: 'mock',
    modelId: id,
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: finish(),
      usage: usage(10, 5),
      warnings: [],
    }),
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: text },
        { type: 'text-end', id: '1' },
        { type: 'finish', finishReason: finish(), usage: usage(10, 5) },
      ]),
    }),
  })

const failingModel = (id: string) =>
  new MockLanguageModelV4({
    provider: 'mock',
    modelId: id,
    doGenerate: async () => {
      throw rateLimit()
    },
    doStream: async () => {
      throw rateLimit()
    },
  })

const resolved = (modelID: string, credentialKey: string): ResolvedModel => ({
  providerID: 'mock',
  modelID,
  npm: 'mock-pkg',
  credentialKey,
})

const manager = (models: Record<string, MockLanguageModelV4>, extra: Record<string, unknown> = {}) => {
  const factories = new ProviderFactoryRegistry()
  factories.register('mock-pkg', () => ({ languageModel: (id: string) => models[id] }) as never)
  return new AiManager(
    defineConfig({
      default: 'main',
      providers: { main: { driver: 'custom', factory: () => textModel('main', 'cascade'), defaultModel: 'm' } },
      catalog: { autoPricing: false },
      languageModels: new LanguageModelFactory({ factories }),
      ...extra,
    } as never),
    { info() {}, warn() {}, error() {}, debug() {} }
  )
}

const ping = tool({ description: 'ping', inputSchema: z.object({}), execute: async () => 'pong' })

test.group('AiManager model chain', () => {
  test('generateText falls back from a 429 model to the next one and reports it', async ({ assert }) => {
    const m = manager({ a: failingModel('a'), b: textModel('b', 'from b') })
    const events: Array<{ fromModel: string; toModel: string; errorClass: string }> = []
    const result = await m.generateText({
      prompt: 'x',
      maxRetries: 0,
      models: [resolved('a', 'key:1'), resolved('b', 'key:2')],
      onFallback: (e) => events.push(e),
    })
    assert.equal(result.text, 'from b')
    assert.equal(result.provider, 'mock')
    assert.equal(result.model, 'b')
    assert.lengthOf(events, 1)
    assert.equal(events[0].errorClass, 'rate_limit')
  })

  test('generateText moves from a 401 entry to the next one by default', async ({ assert }) => {
    const m = manager({ a: unauthorizedModel('a'), b: textModel('b', 'from b') })
    const events: Array<{ errorClass: string }> = []
    const result = await m.generateText({
      prompt: 'x',
      maxRetries: 0,
      models: [resolved('a', 'key:1'), resolved('b', 'key:2')],
      onFallback: (e) => events.push(e),
    })
    assert.equal(result.text, 'from b')
    assert.equal(result.model, 'b')
    assert.equal(events[0].errorClass, 'auth_error')
  })

  test('fallbackOnCredentialErrors: false on the call throws the 401', async ({ assert }) => {
    const b = textModel('b', 'never')
    const m = manager({ a: unauthorizedModel('a'), b })
    await assert.rejects(
      () =>
        m.generateText({
          prompt: 'x',
          maxRetries: 0,
          fallbackOnCredentialErrors: false,
          models: [resolved('a', 'key:1'), resolved('b', 'key:2')],
        }),
      /unauthorized/
    )
    assert.equal(b.doGenerateCalls.length, 0)
  })

  test('fallbackOnCredentialErrors: false in config throws the 401', async ({ assert }) => {
    const b = textModel('b', 'never')
    const m = manager({ a: unauthorizedModel('a'), b }, { fallbackOnCredentialErrors: false })
    await assert.rejects(
      () =>
        m.generateText({
          prompt: 'x',
          maxRetries: 0,
          models: [resolved('a', 'key:1'), resolved('b', 'key:2')],
        }),
      /unauthorized/
    )
    assert.equal(b.doGenerateCalls.length, 0)
  })

  test('the call option wins over the config', async ({ assert }) => {
    const m = manager({ a: unauthorizedModel('a'), b: textModel('b', 'from b') }, { fallbackOnCredentialErrors: false })
    const result = await m.generateText({
      prompt: 'x',
      maxRetries: 0,
      fallbackOnCredentialErrors: true,
      models: [resolved('a', 'key:1'), resolved('b', 'key:2')],
    })
    assert.equal(result.model, 'b')
  })

  test('a 401 on the last entry is thrown', async ({ assert }) => {
    const m = manager({ a: unauthorizedModel('a'), b: unauthorizedModel('b') })
    await assert.rejects(
      () =>
        m.generateText({
          prompt: 'x',
          maxRetries: 0,
          models: [resolved('a', 'key:1'), resolved('b', 'key:2')],
        }),
      /unauthorized/
    )
  })

  test('no fallback on a 401 after a tool ran', async ({ assert }) => {
    let step = 0
    const flaky = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'a',
      doGenerate: async () => {
        step++
        if (step === 1) {
          return {
            content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'ping', input: '{}' }],
            finishReason: finish('tool-calls'),
            usage: usage(1, 1),
            warnings: [],
          }
        }
        throw unauthorized()
      },
    })
    const b = textModel('b', 'never')
    const m = manager({ a: flaky, b })
    await assert.rejects(() =>
      m.generateText({
        prompt: 'x',
        maxRetries: 0,
        maxSteps: 5,
        tools: { ping },
        models: [resolved('a', 'key:1'), resolved('b', 'key:2')],
      })
    )
    assert.equal(b.doGenerateCalls.length, 0)
  })

  test('a string entry without a resolver throws ProviderConfigError', async ({ assert }) => {
    const m = manager({ a: textModel('a', 'x') })
    await assert.rejects(() => m.generateText({ prompt: 'x', models: ['openai/gpt-4o'] }), ProviderConfigError as never)
  })

  test('string entries are resolved through config.resolver', async ({ assert }) => {
    const m = manager(
      { b: textModel('b', 'from b') },
      { resolver: { resolve: async () => resolved('b', 'key:2') } }
    )
    const result = await m.generateText({ prompt: 'x', models: ['whatever'] })
    assert.equal(result.model, 'b')
  })

  test('streamText falls back when the first model fails before the first chunk', async ({ assert }) => {
    const m = manager({ a: failingModel('a'), b: textModel('b', 'stream b') })
    const stream = await m.streamText({
      prompt: 'x',
      maxRetries: 0,
      models: [resolved('a', 'key:1'), resolved('b', 'key:2')],
    })
    const result = await stream.consume()
    assert.equal(stream.model, 'b')
    assert.equal(result.text, 'stream b')
  })

  test('generateObject runs over the chain', async ({ assert }) => {
    const m = manager({ a: failingModel('a'), b: textModel('b', '{"n":3}') })
    const result = await m.generateObject({
      prompt: 'x',
      schema: z.object({ n: z.number() }),
      maxRetries: 0,
      models: [resolved('a', 'key:1'), resolved('b', 'key:2')],
    } as never)
    assert.deepEqual(result.object, { n: 3 })
    assert.equal(result.model, 'b')
  })

  test('no fallback after a tool ran', async ({ assert }) => {
    let step = 0
    const flaky = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'a',
      doGenerate: async () => {
        step++
        if (step === 1) {
          return {
            content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'ping', input: '{}' }],
            finishReason: finish('tool-calls'),
            usage: usage(1, 1),
            warnings: [],
          }
        }
        throw rateLimit()
      },
    })
    const b = textModel('b', 'never')
    const m = manager({ a: flaky, b })
    await assert.rejects(() =>
      m.generateText({
        prompt: 'x',
        maxRetries: 0,
        maxSteps: 5,
        tools: { ping },
        models: [resolved('a', 'key:1'), resolved('b', 'key:2')],
      })
    )
    assert.equal(b.doGenerateCalls.length, 0)
  })

  test('chain options stopWhen/onStepFinish work on the chain path', async ({ assert }) => {
    let steps = 0
    const m = manager({ b: textModel('b', 'hi') })
    const result = await m.generateText({
      prompt: 'x',
      models: [resolved('b', 'key:2')],
      onStepFinish: () => {
        steps++
      },
    })
    assert.equal(result.text, 'hi')
    assert.equal(steps, 1)
  })

  test('empty models falls back to the provider cascade', async ({ assert }) => {
    const m = manager({})
    const result = await m.generateText({ prompt: 'x', models: [] })
    assert.equal(result.provider, 'main')
  })

  test('the lazy LanguageModelFactory shares the manager ConfirmationService with ACP drivers', async ({ assert }) => {
    const m = new AiManager(
      defineConfig({
        default: 'main',
        providers: { main: { driver: 'custom', factory: () => textModel('main', 'x'), defaultModel: 'm' } },
        catalog: { autoPricing: false },
      } as never),
      { info() {}, warn() {}, error() {}, debug() {} }
    )
    const factory = (m as any).languageModels as LanguageModelFactory
    assert.strictEqual((factory as any).acp.confirmation, m.getConfirmationService())
    await m.shutdown()
  })

  test('a mixed chain with a string entry and no resolver is rejected before any attempt', async ({ assert }) => {
    const a = textModel('a', 'x')
    const m = manager({ a })
    await assert.rejects(
      () => m.generateText({ prompt: 'x', models: [resolved('a', 'key:1'), 'openai/gpt-4o'] }),
      ProviderConfigError as never
    )
    assert.equal(a.doGenerateCalls.length, 0)
  })
})
