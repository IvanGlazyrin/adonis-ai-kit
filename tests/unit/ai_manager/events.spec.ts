import { test } from '@japa/runner'
import { z } from 'zod'
import { AiManager } from '../../../src/ai_manager.js'
import { defineConfig } from '../../../src/define_config.js'
import type { AiEvent } from '../../../src/events/types.js'
import { fakeApiError, fakeModel, fakeProvider, fakeTools, type FakeScriptEntry } from '../../../src/testing/index.js'

type Of<T extends AiEvent['type']> = Extract<AiEvent, { type: T }>

const single = (script: FakeScriptEntry[]) =>
  defineConfig({ default: 'main', providers: { main: fakeProvider(fakeModel(script)) }, catalog: { autoPricing: false } })

/** Events recorded through `onEvent`. */
function recorder() {
  const events: AiEvent[] = []
  return { events, onEvent: (event: AiEvent) => void events.push(event), types: () => events.map((e) => e.type) }
}

/** Lets events sent after an awaited step (the cost of a stream, a rejected handler) arrive. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

test.group('AiManager events', () => {
  test('generateText emits call:started, attempt:started, step:finished, call:completed once each, in this order', async ({ assert }) => {
    const ai = new AiManager(single([{ text: 'ok' }]))
    const rec = recorder()

    await ai.generateText({ prompt: 'hi', onEvent: rec.onEvent })

    assert.deepEqual(rec.types(), ['call:started', 'attempt:started', 'step:finished', 'call:completed'])
    const done = rec.events[3] as Of<'call:completed'>
    assert.equal(done.usage.totalTokens, 20)
    assert.equal(done.provider, 'main')
    assert.equal(done.status, 'completed')
    assert.equal(new Set(rec.events.map((e) => (e as Of<'call:started'>).callId)).size, 1)
  })

  test('a tool loop emits one step:finished per step', async ({ assert }) => {
    const ai = new AiManager(single([{ toolCalls: [{ name: 'lookup', input: { id: 1 } }] }, { text: 'done' }]))
    const tools = fakeTools({ lookup: () => ({ ok: true }) })
    const rec = recorder()

    await ai.generateText({ prompt: 'hi', tools: tools.tools, maxSteps: 2, onEvent: rec.onEvent })

    const steps = rec.events.filter((e): e is Of<'step:finished'> => e.type === 'step:finished')
    assert.lengthOf(steps, 2)
    assert.deepEqual(steps.map((s) => s.stepNumber), [0, 1])
    assert.equal(steps[0].toolCalls[0].toolName, 'lookup')
    assert.isFalse(steps[0].toolCalls[0].invalid)
    assert.deepEqual(steps[0].toolCalls[0].output, { ok: true })
  })

  test('a cascade fallback emits fallback and completes on the second provider', async ({ assert }) => {
    const ai = new AiManager(
      defineConfig({
        default: 'a',
        providers: {
          a: fakeProvider(fakeModel([{ error: fakeApiError(503) }], { modelId: 'model-a' })),
          b: fakeProvider(fakeModel([{ text: 'ok' }], { modelId: 'model-b' })),
        },
        fallbackCascade: ['b'],
        catalog: { autoPricing: false },
      })
    )
    const rec = recorder()

    await ai.generateText({ prompt: 'hi', maxRetries: 0, onEvent: rec.onEvent })

    assert.deepEqual(rec.types(), [
      'call:started',
      'attempt:started',
      'fallback',
      'attempt:started',
      'step:finished',
      'call:completed',
    ])
    const fallback = rec.events[2] as Of<'fallback'>
    assert.equal(fallback.from, 'a:model-a')
    assert.equal(fallback.to, 'b')
    assert.equal(fallback.errorClass, 'server_error')
    assert.equal((rec.events[5] as Of<'call:completed'>).provider, 'b')
  })

  test('a fatal failure emits call:failed and no call:completed', async ({ assert }) => {
    const ai = new AiManager(single([{ error: fakeApiError(400, 'invalid param') }]))
    const rec = recorder()

    await assert.rejects(() => ai.generateText({ prompt: 'hi', maxRetries: 0, onEvent: rec.onEvent }))

    assert.deepEqual(rec.types(), ['call:started', 'attempt:started', 'call:failed'])
    assert.equal((rec.events[2] as Of<'call:failed'>).errorClass, 'invalid_request')
  })

  test('onEvent and the manager observer both receive every event', async ({ assert }) => {
    const observed: AiEvent[] = []
    const ai = new AiManager(single([{ text: 'ok' }]), { observer: { emit: (event) => void observed.push(event) } })
    const rec = recorder()

    await ai.generateText({ prompt: 'hi', onEvent: rec.onEvent })

    assert.deepEqual(
      observed.map((e) => e.type),
      rec.types()
    )
  })

  test('a throwing observer does not fail the call', async ({ assert }) => {
    const ai = new AiManager(single([{ text: 'ok' }]), {
      observer: {
        emit() {
          throw new Error('observer down')
        },
      },
    })

    const result = await ai.generateText({ prompt: 'hi' })

    assert.equal(result.text, 'ok')
  })

  test('an onEvent that returns a rejected promise does not fail the call and leaves no unhandled rejection', async ({ assert }) => {
    const unhandled: unknown[] = []
    const listener = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', listener)
    try {
      const ai = new AiManager(single([{ text: 'ok' }]))
      const result = await ai.generateText({ prompt: 'hi', onEvent: async () => Promise.reject(new Error('sink down')) })
      await settle()
      assert.equal(result.text, 'ok')
      assert.deepEqual(unhandled, [])
    } finally {
      process.off('unhandledRejection', listener)
    }
  })

  test('streamText emits call:completed after the stream is consumed', async ({ assert }) => {
    const ai = new AiManager(single([{ text: 'streamed' }]))
    const rec = recorder()

    const stream = await ai.streamText({ prompt: 'hi', onEvent: rec.onEvent })
    await stream.consume()
    await settle()

    assert.deepEqual(rec.types(), ['call:started', 'attempt:started', 'step:finished', 'call:completed'])
  })

  test('a stream that fails before its first chunk emits call:failed', async ({ assert }) => {
    const ai = new AiManager(single([{ error: fakeApiError(400, 'invalid param') }]))
    const rec = recorder()

    await assert.rejects(() => ai.streamText({ prompt: 'hi', maxRetries: 0, onEvent: rec.onEvent }))

    assert.deepEqual(rec.types(), ['call:started', 'attempt:started', 'call:failed'])
  })

  test('generateObject emits call:started and call:completed', async ({ assert }) => {
    const ai = new AiManager(single([{ object: { name: 'x' } }]))
    const rec = recorder()

    const result = await ai.generateObject({ prompt: 'hi', schema: z.object({ name: z.string() }), onEvent: rec.onEvent })

    assert.deepEqual(result.object, { name: 'x' })
    assert.equal(rec.types()[0], 'call:started')
    assert.equal(rec.types().at(-1), 'call:completed')
    assert.notProperty(result, 'finishReason')
  })

  test('a breaker the manager builds reports breaker:state to the observer', async ({ assert }) => {
    const observed: AiEvent[] = []
    const ai = new AiManager(
      defineConfig({
        default: 'main',
        providers: { main: fakeProvider(fakeModel([{ error: fakeApiError(503) }])) },
        circuitBreaker: { failureThreshold: 1 },
        catalog: { autoPricing: false },
      }),
      { observer: { emit: (event) => void observed.push(event) } }
    )

    await assert.rejects(() => ai.generateText({ prompt: 'hi', maxRetries: 0 }))

    const change = observed.find((e) => e.type === 'breaker:state')
    assert.deepInclude(change, { type: 'breaker:state', key: 'main:fake-model', from: 'closed', to: 'open' })
  })
})
