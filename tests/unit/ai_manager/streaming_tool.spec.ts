import { test } from '@japa/runner'
import { tool } from 'ai'
import { z } from 'zod'
import { AiManager } from '../../../src/ai_manager.js'
import { defineConfig } from '../../../src/define_config.js'
import { fakeModel, fakeProvider } from '../../../src/testing/index.js'
import { managerFor } from '../approvals/helpers.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

/** A streaming tool that counts its runs; its last chunk is the value the model should see. */
function countingStream() {
  const counter = { runs: 0 }
  const streaming = tool({
    description: 'streams progress',
    inputSchema: z.object({}),
    execute: async function* () {
      counter.runs++
      yield 'partial'
      yield 'final value'
    },
  })
  return { streaming, counter }
}

/** A tool declared `async` that returns an object, so the SDK gets a Promise and never iterates the object. */
function asyncReturning(value: () => unknown) {
  const counter = { runs: 0 }
  const returning = tool({
    description: 'returns a value',
    inputSchema: z.object({}),
    execute: (async () => {
      counter.runs++
      return value()
    }) as never,
  })
  return { returning, counter }
}

/** An object that is an async iterable (like a database cursor), with a `marker` field the model can show. */
function cursorLike() {
  return {
    marker: 'cursor-object',
    async *[Symbol.asyncIterator]() {
      yield 'row-first'
      yield 'row-last'
    },
  }
}

async function promptSentAfter(options: {
  tools: Record<string, unknown>
  guarded?: 'guard' | 'ask'
}): Promise<string> {
  const model = fakeModel([{ toolCalls: [{ name: 'value', input: {} }] }, { text: 'done' }])
  const manager = new AiManager(
    defineConfig({ default: 'main', providers: { main: fakeProvider(model) }, catalog: { autoPricing: false } } as never),
    quiet
  )
  const guard = { check: () => null, record() {}, release() {} }
  await manager.generateText({
    prompt: 'go',
    maxSteps: 3,
    tools: options.tools as never,
    ...(options.guarded === 'guard' ? { toolGuard: { guard } } : {}),
    ...(options.guarded === 'ask'
      ? {
          toolPermissions: { value: 'ask' },
          toolGuard: { confirmation: { waitForResponse: async () => ({ status: 'approved' }) } as never },
        }
      : {}),
  })
  return JSON.stringify(model.calls[1].prompt)
}

test.group('tools declared async that return an object', () => {
  test('the model gets a plain object whole, with or without a guard', async ({ assert }) => {
    for (const guarded of [undefined, 'guard', 'ask'] as const) {
      const { returning } = asyncReturning(() => ({ items: ['item-a', 'item-b'] }))
      const prompt = await promptSentAfter({ tools: { value: returning }, guarded })
      assert.include(prompt, 'item-a', `guarded: ${guarded}`)
      assert.include(prompt, 'item-b', `guarded: ${guarded}`)
    }
  })

  test('an async-iterable object returned from an async function reaches the model as the object, as the SDK does without a guard', async ({ assert }) => {
    const unguarded = asyncReturning(cursorLike)
    const plain = await promptSentAfter({ tools: { value: unguarded.returning } })
    assert.include(plain, 'cursor-object')
    assert.notInclude(plain, 'row-last')

    for (const guarded of ['guard', 'ask'] as const) {
      const { returning, counter } = asyncReturning(cursorLike)
      const prompt = await promptSentAfter({ tools: { value: returning }, guarded })
      assert.equal(counter.runs, 1)
      assert.include(prompt, 'cursor-object', `guarded: ${guarded}`)
      assert.notInclude(prompt, 'row-last', `guarded: ${guarded}`)
    }
  })

  test('a resumable call, and an ask tool approved on resume, give the model the same object', async ({ assert }) => {
    const { returning, counter } = asyncReturning(cursorLike)
    const model = fakeModel([{ toolCalls: [{ name: 'value', input: {} }] }, { text: 'done' }])
    const ai = managerFor(model)
    const conversation = await ai.conversations.start('user:1')

    await ai.generateText({
      prompt: 'go',
      maxSteps: 3,
      tools: { value: returning },
      approvals: 'resumable',
      conversation: { id: conversation.id, owner: 'user:1' },
    })
    assert.equal(counter.runs, 1)
    let prompt = JSON.stringify(model.calls[1].prompt)
    assert.include(prompt, 'cursor-object')
    assert.notInclude(prompt, 'row-last')

    const askModel = fakeModel([{ toolCalls: [{ name: 'value', input: {} }] }, { text: 'done' }])
    const askAi = managerFor(askModel)
    const askConversation = await askAi.conversations.start('user:1')
    const paused = await askAi.generateText({
      prompt: 'go',
      maxSteps: 3,
      tools: { value: returning },
      toolPermissions: { value: 'ask' },
      approvals: 'resumable',
      conversation: { id: askConversation.id, owner: 'user:1' },
    })
    await askAi.conversations.resolveApprovals(
      askConversation.id,
      'user:1',
      [{ approvalId: paused.pendingApprovals[0].approvalId, approved: true }],
      { tools: { value: returning }, toolPermissions: { value: 'ask' } }
    )
    assert.equal(counter.runs, 2)
    prompt = JSON.stringify(askModel.calls[1].prompt)
    assert.include(prompt, 'cursor-object')
    assert.notInclude(prompt, 'row-last')
  })
})

test.group('approval wrapper without a tool call id', () => {
  test('hands back the object an async function returned, and drains a stream returned synchronously', async ({ assert }) => {
    const ai = managerFor(fakeModel([])) as unknown as {
      approvalExecution(tool: unknown, run: unknown): { execute(args: unknown, options?: unknown): Promise<unknown> }
    }
    const run = { begin: async () => {}, finish: async () => {} }
    const { returning } = asyncReturning(() => ({ items: ['item-a', 'item-b'] }))
    const cursor = cursorLike()
    const cursorTool = { execute: async () => cursor }
    const streamTool = { execute: async function* () { yield 'partial'; yield 'final' } }

    assert.deepEqual(await ai.approvalExecution(returning, run).execute({}), { items: ['item-a', 'item-b'] })
    assert.strictEqual(await ai.approvalExecution(cursorTool, run).execute({}), cursor)
    assert.equal(await ai.approvalExecution(streamTool, run).execute({}), 'final')
  })
})

test.group('tools with an async generator execute', () => {
  test('the model gets the final value of the generator, not the generator object', async ({ assert }) => {
    const { streaming } = countingStream()
    const model = fakeModel([{ toolCalls: [{ name: 'stream', input: {} }] }, { text: 'done' }])
    const manager = new AiManager(
      defineConfig({ default: 'main', providers: { main: fakeProvider(model) }, catalog: { autoPricing: false } } as never),
      quiet
    )

    const result = await manager.generateText({ prompt: 'go', maxSteps: 3, tools: { stream: streaming } })

    assert.equal(result.text, 'done')
    model.assertPromptContains('final value')
    assert.notInclude(JSON.stringify(model.calls[1].prompt), 'AsyncGenerator')
  })

  test('under a tool guard the generator runs once and the model gets its final value', async ({ assert }) => {
    const { streaming, counter } = countingStream()
    const model = fakeModel([{ toolCalls: [{ name: 'stream', input: {} }] }, { text: 'done' }])
    const manager = new AiManager(
      defineConfig({ default: 'main', providers: { main: fakeProvider(model) }, catalog: { autoPricing: false } } as never),
      quiet
    )
    const guard = { check: () => null, record() {}, release() {} }

    await manager.generateText({ prompt: 'go', maxSteps: 3, tools: { stream: streaming }, toolGuard: { guard } })

    assert.equal(counter.runs, 1)
    model.assertPromptContains('final value')
  })

  test('an ask tool that is approved runs its generator once and the model gets the final value', async ({ assert }) => {
    const { streaming, counter } = countingStream()
    const model = fakeModel([{ toolCalls: [{ name: 'stream', input: {} }] }, { text: 'done' }])
    const manager = new AiManager(
      defineConfig({ default: 'main', providers: { main: fakeProvider(model) }, catalog: { autoPricing: false } } as never),
      quiet
    )
    const confirmation = { waitForResponse: async () => ({ status: 'approved' }) }

    await manager.generateText({
      prompt: 'go',
      maxSteps: 3,
      tools: { stream: streaming },
      toolPermissions: { stream: 'ask' },
      toolGuard: { confirmation: confirmation as never },
    })

    assert.equal(counter.runs, 1)
    model.assertPromptContains('final value')
  })

  test('a resumable call runs its generator once and the model gets the final value', async ({ assert }) => {
    const { streaming, counter } = countingStream()
    const model = fakeModel([{ toolCalls: [{ name: 'stream', input: {} }] }, { text: 'done' }])
    const ai = managerFor(model)
    const conversation = await ai.conversations.start('user:1')

    const result = await ai.generateText({
      prompt: 'go',
      maxSteps: 3,
      tools: { stream: streaming },
      approvals: 'resumable',
      conversation: { id: conversation.id, owner: 'user:1' },
    })

    assert.equal(result.text, 'done')
    assert.equal(counter.runs, 1)
    model.assertPromptContains('final value')
  })

  test('a streaming ask tool, once approved on resume, runs once and the model gets the final value', async ({ assert }) => {
    const { streaming, counter } = countingStream()
    const model = fakeModel([{ toolCalls: [{ name: 'stream', input: {} }] }, { text: 'done' }])
    const ai = managerFor(model)
    const conversation = await ai.conversations.start('user:1')
    const paused = await ai.generateText({
      prompt: 'go',
      maxSteps: 3,
      tools: { stream: streaming },
      toolPermissions: { stream: 'ask' },
      approvals: 'resumable',
      conversation: { id: conversation.id, owner: 'user:1' },
    })
    assert.equal(paused.status, 'awaiting-approval')
    assert.equal(counter.runs, 0)

    const result = await ai.conversations.resolveApprovals(
      conversation.id,
      'user:1',
      [{ approvalId: paused.pendingApprovals[0].approvalId, approved: true }],
      { tools: { stream: streaming }, toolPermissions: { stream: 'ask' } }
    )

    assert.equal(result.text, 'done')
    assert.equal(counter.runs, 1)
    model.assertPromptContains('final value')
  })
})
