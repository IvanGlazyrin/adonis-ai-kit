import { test } from '@japa/runner'
import { generateText, stepCountIs, streamText } from 'ai'
import { AiManager } from '../../../src/ai_manager.js'
import { defineConfig } from '../../../src/define_config.js'
import {
  FakeAssertionError,
  FakeScriptExhaustedError,
  fakeApiError,
  fakeLanguageModels,
  fakeModel,
  fakeProvider,
  fakeResolver,
  fakeTools,
} from '../../../src/testing/index.js'
import type { ResolvedModel } from '../../../src/models/index.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

/** A manager whose default provider is `model`, with the cascade `fallbackCascade` over the given providers. */
const managerOf = (providers: Record<string, ReturnType<typeof fakeModel>>, extra: Record<string, unknown> = {}) =>
  new AiManager(
    defineConfig({
      default: Object.keys(providers)[0],
      providers: Object.fromEntries(Object.entries(providers).map(([name, m]) => [name, fakeProvider(m)])),
      catalog: { autoPricing: false },
      ...extra,
    } as never),
    quiet
  )

test.group('testing: fakeModel', () => {
  test('a scenario answers doGenerate and records the call', async ({ assert }) => {
    const model = fakeModel([{ text: 'hello there' }])

    const result = await generateText({ model, prompt: 'say hi' })

    assert.equal(result.text, 'hello there')
    model.assertCalledTimes(1)
    model.assertPromptContains('say hi')
    assert.equal(model.calls[0].mode, 'generate')
  })

  test('the same scenario answers doStream', async ({ assert }) => {
    const model = fakeModel([{ text: 'streamed' }])

    const result = streamText({ model, prompt: 'go' })
    assert.equal(await result.text, 'streamed')
    model.assertCalledTimes(1)
    assert.equal(model.calls[0].mode, 'stream')
  })

  test('a function entry sees the call and answers from it', async ({ assert }) => {
    const model = fakeModel([(call) => ({ text: `saw ${call.prompt.length} messages` })])

    const result = await generateText({ model, prompt: 'hi' })

    assert.equal(result.text, 'saw 1 messages')
  })

  test('an exhausted script throws FakeScriptExhaustedError (fail-closed by default)', async ({ assert }) => {
    const model = fakeModel([{ text: 'only once' }])
    await generateText({ model, prompt: 'first' })

    try {
      await generateText({ model, prompt: 'second' })
      assert.fail('expected the exhausted script to throw')
    } catch (err) {
      assert.instanceOf(err, FakeScriptExhaustedError)
    }
  })

  test('usage defaults to a non-zero value and can carry cache and reasoning tokens', async ({ assert }) => {
    const model = fakeModel([{ text: 'a', usage: { input: 100, output: 50, cacheRead: 40, reasoning: 5 } }])

    const result = await generateText({ model, prompt: 'x' })

    assert.equal(result.usage.inputTokens, 100)
    assert.equal(result.usage.inputTokenDetails.cacheReadTokens, 40)
    assert.equal(result.usage.outputTokenDetails.reasoningTokens, 5)
    assert.equal(result.usage.outputTokens, 50)
  })

  test('the default usage is 10 input and 10 output tokens', async ({ assert }) => {
    const model = fakeModel([{ text: 'a' }])
    const result = await generateText({ model, prompt: 'x' })
    assert.equal(result.usage.inputTokens, 10)
    assert.equal(result.usage.outputTokens, 10)
  })

  test('usage reaches the cost tracker through AiManager', async ({ assert }) => {
    const model = fakeModel([{ text: 'a', usage: { input: 100, output: 50, cacheRead: 40 } }])
    const m = managerOf({ main: model })

    await m.generateText({ prompt: 'x', agentName: 'tester' })

    const [record] = m.getCostTracker().getRecords()
    assert.equal(record.agentName, 'tester')
    assert.equal(record.inputTokens, 100)
    assert.equal(record.cacheReadTokens, 40)
  })

  test('assertion failures carry a clear message', async ({ assert }) => {
    const model = fakeModel([{ text: 'a' }])
    await generateText({ model, prompt: 'x' })

    try {
      model.assertCalledTimes(2)
      assert.fail('expected assertCalledTimes to throw')
    } catch (err) {
      assert.instanceOf(err, FakeAssertionError)
      assert.match((err as Error).message, /expected 2 calls, got 1/)
    }
  })

  test('assertProviderOption finds a value in the call options', async ({ assert }) => {
    const model = fakeModel([{ text: 'a' }])

    await generateText({
      model,
      prompt: 'x',
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '5m' } } },
    })

    model.assertProviderOption('anthropic.cacheControl.ttl', '5m')
    assert.throws(() => model.assertProviderOption('anthropic.cacheControl.ttl', '1h'), /anthropic\.cacheControl\.ttl/)
  })

  test('the model is a plain LanguageModel for the AI SDK', async ({ assert }) => {
    const model = fakeModel([{ text: 'ok' }], { provider: 'acme', modelId: 'acme-1' })
    assert.equal(model.provider, 'acme')
    assert.equal(model.modelId, 'acme-1')
  })
})

test.group('testing: fakeTools', () => {
  test('execute records every call and the assertions check them', async ({ assert }) => {
    const fake = fakeTools({ ping: (input) => `pong:${(input as { n: number }).n}` })
    const model = fakeModel([
      { toolCalls: [{ name: 'ping', input: { n: 1 } }] },
      { text: 'done' },
    ])

    await generateText({ model, prompt: 'x', tools: fake.tools, stopWhen: stepCountIs(2) })

    fake.assertToolCalled('ping', { n: 1 })
    fake.assertToolCalled('ping', (input: unknown) => (input as { n: number }).n === 1)
    fake.assertToolNotCalled('other')
    assert.throws(() => fake.assertToolCalled('ping', { n: 99 }), /ping/)
  })

  test('assertToolNotCalled fails when the tool ran', async ({ assert }) => {
    const fake = fakeTools({ ping: () => 'pong' })
    await fake.tools.ping.execute!({}, { toolCallId: 'x', messages: [] } as never)
    assert.throws(() => fake.assertToolNotCalled('ping'), /ping/)
  })
})

test.group('testing: tools offered to the model', () => {
  test('assertToolOffered and assertToolNotOffered follow the deny permission', async ({ assert }) => {
    const fake = fakeTools({ ping: () => 'pong', secret: () => 'x' })
    const model = fakeModel([{ text: 'a' }])
    const m = managerOf({ main: model })

    await m.generateText({
      prompt: 'x',
      tools: fake.tools,
      toolPermissions: { secret: 'deny' },
    })

    model.assertToolOffered('ping')
    model.assertToolNotOffered('secret')
    assert.isFalse(model.calls[0].toolNames.includes('secret'))
  })
})

test.group('testing: API errors and fallback', () => {
  test('fakeApiError(429) is classified as a rate limit and moves a generateText call to the next provider', async ({
    assert,
  }) => {
    const a = fakeModel([{ error: fakeApiError(429) }])
    const b = fakeModel([{ text: 'from b' }])
    const m = managerOf({ a, b }, { fallbackCascade: ['b'] })

    const result = await m.generateText({ prompt: 'x', maxRetries: 0 })

    assert.equal(result.provider, 'b')
    assert.equal(result.text, 'from b')
    a.assertCalledTimes(1)
    b.assertCalledTimes(1)
  })

  test('fakeApiError(429) also falls back on streamText before the first chunk', async ({ assert }) => {
    const a = fakeModel([{ error: fakeApiError(429) }])
    const b = fakeModel([{ text: 'stream from b' }])
    const m = managerOf({ a, b }, { fallbackCascade: ['b'] })

    const result = await m.streamText({ prompt: 'x', maxRetries: 0 })

    assert.equal(result.provider, 'b')
    assert.equal(await result.consume().then((r) => r.text), 'stream from b')
  })
})

test.group('testing: sources for model chains', () => {
  const resolved = (modelID: string): ResolvedModel => ({ providerID: 'mock', modelID, npm: 'fake-pkg' })

  test('fakeLanguageModels answers chain entries by provider/model', async ({ assert }) => {
    const a = fakeModel([{ error: fakeApiError(503) }], { provider: 'mock', modelId: 'a' })
    const b = fakeModel([{ text: 'from b' }], { provider: 'mock', modelId: 'b' })
    const m = new AiManager(
      defineConfig({
        default: 'main',
        providers: { main: fakeProvider(fakeModel([{ text: 'unused' }])) },
        catalog: { autoPricing: false },
        languageModels: fakeLanguageModels({ 'mock/a': a, 'mock/b': b }),
      } as never),
      quiet
    )

    const result = await m.generateText({ prompt: 'x', maxRetries: 0, models: [resolved('a'), resolved('b')] })

    assert.equal(result.text, 'from b')
    a.assertCalledTimes(1)
    b.assertCalledTimes(1)
  })

  test('an unregistered chain entry is a loud error, not a silent fallback', async ({ assert }) => {
    const source = fakeLanguageModels({})
    await assert.rejects(() => source.create(resolved('missing')), /mock\/missing/)
  })

  test('fakeResolver resolves string references for a chain', async ({ assert }) => {
    const b = fakeModel([{ text: 'by ref' }], { provider: 'mock', modelId: 'b' })
    const m = new AiManager(
      defineConfig({
        default: 'main',
        providers: { main: fakeProvider(fakeModel([{ text: 'unused' }])) },
        catalog: { autoPricing: false },
        languageModels: fakeLanguageModels({ 'mock/b': b }),
        resolver: fakeResolver(),
      } as never),
      quiet
    )

    const result = await m.generateText({ prompt: 'x', models: ['mock/b'] })

    assert.equal(result.text, 'by ref')
  })

  test('fakeProvider returns a custom provider config for the default model', async ({ assert }) => {
    const model = fakeModel([{ text: 'hi' }], { modelId: 'fake-7' })
    const config = fakeProvider(model)
    assert.equal(config.driver, 'custom')
    assert.equal(config.defaultModel, 'fake-7')

    const m = managerOf({ main: model })
    const result = await m.generateText({ prompt: 'x' })
    assert.equal(result.model, 'fake-7')
  })
})
