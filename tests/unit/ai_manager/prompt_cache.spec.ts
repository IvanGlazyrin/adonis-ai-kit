import { test } from '@japa/runner'
import { createAnthropic } from '@ai-sdk/anthropic'
import { tool } from 'ai'
import { z } from 'zod'
import { AiManager } from '../../../src/ai_manager.js'
import { defineConfig } from '../../../src/define_config.js'
import { AiException } from '../../../src/errors.js'
import { fakeModel, fakeProvider, fakeTools } from '../../../src/testing/index.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

const managerWith = (model: Parameters<typeof fakeProvider>[0]) =>
  new AiManager(
    defineConfig({
      default: 'main',
      providers: { main: fakeProvider(model) },
      catalog: { autoPricing: false },
    } as never),
    quiet
  )

/** The tool definitions the model received, as the AI SDK sends them. */
const offeredTools = (call: { options: unknown }) =>
  ((call.options as { tools?: Array<{ name: string; providerOptions?: Record<string, unknown> }> }).tools ?? [])

test.group('prompt cache markers (B3)', () => {
  test('promptCache.instructions marks the system message with an ephemeral 5m cache', async ({ assert }) => {
    const model = fakeModel([{ text: 'ok' }])

    await managerWith(model).generateText({ system: 'You are terse.', prompt: 'x', promptCache: { instructions: '5m' } })

    model.assertProviderOption('anthropic.cacheControl', { type: 'ephemeral', ttl: '5m' })
    assert.equal(model.calls[0].prompt[0].role, 'system')
  })

  test('promptCache.tools sorts the tools and marks the last one with a 1h cache', async ({ assert }) => {
    const tools = fakeTools({ zeta: () => 1, alpha: () => 2, mid: () => 3 })
    const model = fakeModel([{ text: 'ok' }])

    await managerWith(model).generateText({ prompt: 'x', tools: tools.tools, promptCache: { tools: '1h' } })

    assert.deepEqual(model.calls[0].toolNames, ['alpha', 'mid', 'zeta'])
    const offered = offeredTools(model.calls[0])
    assert.deepEqual(offered[2].providerOptions, { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } })
    assert.isUndefined(offered[0].providerOptions?.anthropic)
    assert.isUndefined(offered[1].providerOptions?.anthropic)
  })

  test('instructions 1h with tools 5m is rejected before the model is called', async ({ assert }) => {
    const tools = fakeTools({ ping: () => 1 })
    const model = fakeModel([{ text: 'never' }])

    try {
      await managerWith(model).generateText({
        system: 'x',
        prompt: 'x',
        tools: tools.tools,
        promptCache: { instructions: '1h', tools: '5m' },
      })
      assert.fail('expected the call to be rejected')
    } catch (err) {
      assert.instanceOf(err, AiException)
      assert.equal((err as AiException).code, 'E_AI_INVALID_ARGUMENT')
    }
    model.assertCalledTimes(0)
  })

  test('a request-level 1h cache with an explicit 5m marker is rejected', async ({ assert }) => {
    const model = fakeModel([{ text: 'never' }])

    try {
      await managerWith(model).generateText({
        system: 'x',
        prompt: 'x',
        promptCache: { instructions: '5m' },
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } },
      })
      assert.fail('expected the call to be rejected')
    } catch (err) {
      assert.equal((err as AiException).code, 'E_AI_INVALID_ARGUMENT')
    }
    model.assertCalledTimes(0)
  })

  test('the marker is merged into a tool that already has provider options, and call options are kept', async ({
    assert,
  }) => {
    const ping = tool({
      description: 'ping',
      inputSchema: z.object({}),
      execute: async () => 'pong',
      providerOptions: { anthropic: { note: 'kept' } },
    })
    const model = fakeModel([{ text: 'ok' }])

    await managerWith(model).generateText({
      prompt: 'x',
      tools: { ping },
      promptCache: { tools: '5m' },
      providerOptions: { openai: { x: 1 } },
    })

    const marked = offeredTools(model.calls[0])[0]
    assert.deepEqual(marked.providerOptions, {
      anthropic: { note: 'kept', cacheControl: { type: 'ephemeral', ttl: '5m' } },
    })
    assert.deepEqual(model.calls[0].providerOptions, { openai: { x: 1 } })
  })

  test('through the real @ai-sdk/anthropic, the request body carries at most four cache breakpoints', async ({
    assert,
  }) => {
    let body: Record<string, any> = {}
    const anthropic = createAnthropic({
      apiKey: 'test-key',
      fetch: (async (_url: unknown, init?: { body?: unknown }) => {
        body = JSON.parse(String(init?.body))
        return new Response(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5-5',
            content: [{ type: 'text', text: 'hi' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }) as unknown as typeof fetch,
    })
    const tools = fakeTools({ beta: () => 1, alpha: () => 2 })

    await managerWith(anthropic('claude-sonnet-5-5')).generateText({
      system: 'You are terse.',
      prompt: 'hello',
      tools: tools.tools,
      promptCache: { instructions: '1h', tools: '1h' },
    })

    const system = body.system as Array<{ cache_control?: unknown }>
    assert.deepEqual(system[system.length - 1].cache_control, { type: 'ephemeral', ttl: '1h' })
    const sent = body.tools as Array<{ name: string; cache_control?: unknown }>
    assert.deepEqual(
      sent.map((t) => t.name),
      ['alpha', 'beta']
    )
    assert.deepEqual(sent[1].cache_control, { type: 'ephemeral', ttl: '1h' })
    assert.isUndefined(sent[0].cache_control)
    const breakpoints = JSON.stringify(body).split('"cache_control"').length - 1
    assert.isAtMost(breakpoints, 4)
  })
})
