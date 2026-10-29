import { test } from '@japa/runner'
import { APICallError, NoObjectGeneratedError, tool } from 'ai'
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'
import { z } from 'zod'
import { AiManager } from '../../../src/ai_manager.js'
import { defineConfig } from '../../../src/define_config.js'
import { AiException } from '../../../src/errors.js'
import { attemptSideEffectHooks } from '../../../src/models/index.js'
import type { ResolvedModel } from '../../../src/models/index.js'

/** The npm package of ACP agents (`ACP_NPM` in src/models). */
const ACP_NPM = '@mcpc-tech/acp-ai-provider'

const usage = (inp: number, out: number) => ({
  inputTokens: { total: inp, noCache: inp, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: out, text: out, reasoning: 0 },
})
const finish = (unified: 'stop' | 'tool-calls' = 'stop') => ({ unified, raw: unified })
const quiet = { info() {}, warn() {}, error() {}, debug() {} }

const rateLimit = () =>
  new APICallError({ message: 'rate limited', url: 'http://x', requestBodyValues: {}, statusCode: 429, isRetryable: true })

const textModel = (id: string, text = `from ${id}`) => {
  const calls = { count: 0 }
  const model = new MockLanguageModelV4({
    provider: 'mock',
    modelId: id,
    doGenerate: async () => {
      calls.count++
      return {
        content: [{ type: 'text', text }],
        finishReason: finish(),
        usage: usage(10, 5),
        warnings: [],
      }
    },
  })
  return { model, calls }
}

/** Calls `toolName` on step 1 (the SDK answers it), then fails with a 429 on step 2. */
const toolThen429 = (id: string, toolName: string) =>
  new MockLanguageModelV4({
    provider: 'mock',
    modelId: id,
    doGenerate: (() => {
      let step = 0
      return async () => {
        step++
        if (step === 1) {
          return {
            content: [{ type: 'tool-call', toolCallId: 'c1', toolName, input: '{}' }],
            finishReason: finish('tool-calls'),
            usage: usage(10, 5),
            warnings: [],
          }
        }
        throw rateLimit()
      }
    })(),
  })

/** Each entry of a chain resolves to a model; an `Error` entry is thrown when the entry is created. */
type ChainEntry = MockLanguageModelV4 | Error

const resolved = (modelID: string, npm?: string): ResolvedModel => ({
  providerID: 'mock',
  modelID,
  npm,
  credentialKey: `key:${modelID}`,
})

const chainManager = (entries: Record<string, ChainEntry>) =>
  new AiManager(
    defineConfig({
      default: 'main',
      providers: { main: { driver: 'custom', factory: () => textModel('main').model, defaultModel: 'm' } },
      catalog: { autoPricing: false },
      languageModels: {
        create: async (model: ResolvedModel) => {
          const entry = entries[model.modelID]
          if (entry instanceof Error) throw entry
          return entry
        },
        shutdown: async () => {},
      },
    } as never),
    quiet
  )

const cascadeManager = (providers: Record<string, MockLanguageModelV4>, extra: Record<string, unknown> = {}) =>
  new AiManager(
    defineConfig({
      default: 'a',
      providers: Object.fromEntries(
        Object.entries(providers).map(([name, m]) => [name, { driver: 'custom', factory: () => m, defaultModel: 'base' }])
      ),
      catalog: { autoPricing: false },
      ...extra,
    } as never),
    quiet
  )

test.group('AiManager side effects on fallback', () => {
  test('a local tool that ran on step 1 blocks fallback when step 2 fails with 429 (model chain)', async ({ assert }) => {
    const a = toolThen429('a', 'ping')
    const b = textModel('b')
    const ping = tool({ description: 'ping', inputSchema: z.object({}), execute: async () => 'pong' })
    const m = chainManager({ a, b: b.model })

    await assert.rejects(() =>
      m.generateText({
        prompt: 'x',
        maxRetries: 0,
        maxSteps: 2,
        tools: { ping },
        models: [resolved('a'), resolved('b')],
      })
    )
    assert.equal(b.calls.count, 0)
  })

  test('a provider-executed tool call that ran blocks fallback when the next step fails with 429', async ({ assert }) => {
    // The provider runs `web_search` and its result is deferred, so the SDK loops to step 2 without a local
    // `execute`. Only the step-end hook sees the call.
    const webSearch = {
      type: 'provider',
      id: 'test.web_search',
      args: {},
      inputSchema: z.object({}),
      outputSchema: z.string(),
      supportsDeferredResults: true,
    } as never
    let step = 0
    const a = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'a',
      doGenerate: async () => {
        step++
        if (step === 1) {
          return {
            content: [{ type: 'tool-call', toolCallId: 'p1', toolName: 'web_search', input: '{}', providerExecuted: true }],
            finishReason: finish('tool-calls'),
            usage: usage(10, 5),
            warnings: [],
          } as never
        }
        throw rateLimit()
      },
    })
    const b = textModel('b')
    const m = chainManager({ a, b: b.model })

    await assert.rejects(() =>
      m.generateText({
        prompt: 'x',
        maxRetries: 0,
        maxSteps: 2,
        tools: { web_search: webSearch },
        models: [resolved('a'), resolved('b')],
      })
    )
    assert.equal(step, 2)
    assert.equal(b.calls.count, 0)
  })

  test('attemptSideEffectHooks marks on a provider-executed tool call and not on an invalid one', ({ assert }) => {
    const marks: string[] = []
    const hooks = attemptSideEffectHooks(() => marks.push('mark'))
    const step = (toolCalls: object[]) => ({ toolCalls, usage: usage(1, 1) }) as never

    hooks.onStepEnd(step([{ type: 'tool-call', toolName: 'nope', invalid: true }]))
    assert.deepEqual(marks, [])

    hooks.onStepEnd(step([{ type: 'tool-call', toolName: 'web_search', providerExecuted: true }]))
    assert.deepEqual(marks, ['mark'])

    hooks.onToolExecutionStart()
    assert.deepEqual(marks, ['mark', 'mark'])
  })

  test('attemptSideEffectHooks passes every finished step to the observer', ({ assert }) => {
    const seen: unknown[] = []
    const hooks = attemptSideEffectHooks(() => {}, (step) => seen.push(step))
    hooks.onStepEnd({ toolCalls: [], usage: usage(2, 3) } as never)
    assert.lengthOf(seen, 1)
  })

  test('an unknown tool on step 1 does not block fallback when step 2 fails with 429', async ({ assert }) => {
    // The SDK answers the unknown call with a tool error and runs step 2; that call never ran a side effect.
    let step = 0
    const a = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'a',
      doGenerate: async () => {
        step++
        if (step === 1) {
          return {
            content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'nope', input: '{}' }],
            finishReason: finish('tool-calls'),
            usage: usage(10, 5),
            warnings: [],
          }
        }
        throw rateLimit()
      },
    })
    const b = textModel('b')
    const ping = tool({ description: 'ping', inputSchema: z.object({}), execute: async () => 'pong' })
    const m = chainManager({ a, b: b.model })

    const result = await m.generateText({
      prompt: 'x',
      maxRetries: 0,
      maxSteps: 2,
      tools: { ping },
      models: [resolved('a'), resolved('b')],
    })

    assert.equal(result.model, 'b')
    assert.equal(b.calls.count, 1)
  })

  test('an ACP candidate in a chain does not fall back on a retryable timeout', async ({ assert }) => {
    const acp = new MockLanguageModelV4({
      provider: 'acp',
      modelId: 'claude-code',
      doGenerate: async () => {
        throw new Error('agent request timeout')
      },
    })
    const b = textModel('b')
    const m = chainManager({ 'claude-code': acp, b: b.model })

    await assert.rejects(() =>
      m.generateText({
        prompt: 'x',
        maxRetries: 0,
        models: [resolved('claude-code', ACP_NPM), resolved('b')],
      })
    )
    assert.equal(b.calls.count, 0)
  })

  test('an ACP candidate in a chain still falls back when its package is missing', async ({ assert }) => {
    const acp = new AiException('ACP package is missing', 'E_AI_MISSING_DEPENDENCY')
    const b = textModel('b')
    const m = chainManager({ 'claude-code': acp, b: b.model })

    const result = await m.generateText({
      prompt: 'x',
      maxRetries: 0,
      models: [resolved('claude-code', ACP_NPM), resolved('b')],
    })

    assert.equal(result.model, 'b')
    assert.equal(b.calls.count, 1)
  })

  test('an ACP driver in the cascade does not fall back on a retryable timeout', async ({ assert }) => {
    const acp = new MockLanguageModelV4({
      provider: 'acp',
      modelId: 'agent',
      doGenerate: async () => {
        throw new Error('agent request timeout')
      },
    })
    const b = textModel('b')
    const m = cascadeManager({}, {
      providers: {
        a: { driver: 'acp', defaultModel: 'agent' },
        b: { driver: 'custom', factory: () => b.model, defaultModel: 'base' },
      },
      fallbackCascade: ['b'],
    })
    // The ACP package is not installed in the kit, so the driver is seeded into the manager's driver cache.
    ;(m as any).drivers.set('a', Promise.resolve({ name: 'a', defaultModel: 'agent', getModel: () => acp }))

    await assert.rejects(() => m.generateText({ prompt: 'x', maxRetries: 0 }))
    assert.equal(b.calls.count, 0)
  })

  test('an ACP driver in the cascade still falls back when its package is missing', async ({ assert }) => {
    const b = textModel('b')
    const m = cascadeManager({}, {
      providers: {
        a: { driver: 'acp', defaultModel: 'agent' },
        b: { driver: 'custom', factory: () => b.model, defaultModel: 'base' },
      },
      fallbackCascade: ['b'],
    })
    ;(m as any).drivers.set(
      'a',
      Promise.resolve({
        name: 'a',
        defaultModel: 'agent',
        getModel: () => {
          throw new AiException('ACP package is missing', 'E_AI_MISSING_DEPENDENCY')
        },
      })
    )

    const result = await m.generateText({ prompt: 'x', maxRetries: 0 })

    assert.equal(result.provider, 'b')
    assert.equal(b.calls.count, 1)
  })

  test('a stream that ran a tool after its first text, then failed, never falls back and still resolves usage', async ({
    assert,
  }) => {
    let executed = 0
    const ping = tool({
      description: 'ping',
      inputSchema: z.object({}),
      execute: async () => {
        executed++
        return 'pong'
      },
    })
    let call = 0
    const a = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'a',
      doStream: async () => {
        call++
        if (call === 1) {
          return {
            stream: convertArrayToReadableStream([
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: '1' },
              { type: 'text-delta', id: '1', delta: 'partial' },
              { type: 'text-end', id: '1' },
              { type: 'tool-call', toolCallId: 'c1', toolName: 'ping', input: '{}' },
              { type: 'finish', finishReason: finish('tool-calls'), usage: usage(10, 5) },
            ]),
          }
        }
        throw rateLimit()
      },
    })
    const b = textModel('b')
    const m = chainManager({ a, b: b.model })

    const result = await m.streamText({
      prompt: 'x',
      maxRetries: 0,
      maxSteps: 2,
      tools: { ping },
      models: [resolved('a'), resolved('b')],
    })
    try {
      for await (const part of result.fullStream) void part
    } catch {
      // the stream error is expected here
    }
    await result.usage

    assert.equal(executed, 1)
    assert.equal(b.calls.count, 0)
  })

  test('a failed attempt records the usage of its completed steps, flagged as failed', async ({ assert }) => {
    const a = toolThen429('a', 'ping')
    const b = textModel('b')
    const ping = tool({ description: 'ping', inputSchema: z.object({}), execute: async () => 'pong' })
    const m = chainManager({ a, b: b.model })

    await assert.rejects(() =>
      m.generateText({ prompt: 'x', maxRetries: 0, maxSteps: 2, tools: { ping }, models: [resolved('a'), resolved('b')] })
    )

    const records = m.getCostTracker().getRecords()
    assert.lengthOf(records, 1)
    assert.equal(records[0].metadata?.failed, true)
    assert.equal(records[0].inputTokens, 10)
    assert.equal(records[0].outputTokens, 5)
  })

  test('a NoObjectGeneratedError records the usage it carries, flagged as failed', async ({ assert }) => {
    const a = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'a',
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'not json at all' }],
        finishReason: finish(),
        usage: usage(7, 3),
        warnings: [],
      }),
    })
    const m = cascadeManager({ a })

    try {
      await m.generateText({ prompt: 'x', maxRetries: 0, schema: z.object({ x: z.number() }) })
      assert.fail('expected NoObjectGeneratedError')
    } catch (err) {
      assert.isTrue(NoObjectGeneratedError.isInstance(err))
    }

    const records = m.getCostTracker().getRecords()
    assert.lengthOf(records, 1)
    assert.equal(records[0].metadata?.failed, true)
    assert.equal(records[0].inputTokens, 7)
    assert.equal(records[0].outputTokens, 3)
  })
})
