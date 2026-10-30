import { test } from '@japa/runner'
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'
import { AiManager } from '../../../src/ai_manager.js'
import { AgentRunner } from '../../../src/agents/agent_runner.js'
import type { AgentPromptConfig } from '../../../src/agents/loader.js'
import { defineConfig } from '../../../src/define_config.js'
import { AiException } from '../../../src/errors.js'
import { Conversations } from '../../../src/conversations/conversations.js'
import { ConversationCorruptError } from '../../../src/conversations/errors.js'
import { MemoryConversationStore } from '../../../src/conversations/memory_store.js'
import type { ConversationRecord, ConversationStore } from '../../../src/conversations/types.js'
import { fakeApiError, fakeModel, fakeProvider } from '../../../src/testing/index.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

/** The error a promise rejects with; fails the test when it resolves. */
async function rejectionOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
  } catch (err) {
    return err
  }
  throw new Error('expected the call to reject')
}

/** A manager whose default provider answers with `model`, and whose conversations live in `store`. */
function managerWith(model: MockLanguageModelV4 | ReturnType<typeof fakeModel>, store: ConversationStore) {
  return new AiManager(
    defineConfig({
      default: 'main',
      providers: { main: fakeProvider(model as never) },
      catalog: { autoPricing: false },
      conversations: { store },
    } as never),
    quiet
  )
}

test('generateText exposes responseMessages', async ({ assert }) => {
  const model = fakeModel([{ text: 'hello there' }])
  const ai = managerWith(model, new MemoryConversationStore())

  const result = await ai.generateText({ prompt: 'hi' })

  assert.lengthOf(result.responseMessages, 1)
  assert.equal(result.responseMessages[0].role, 'assistant')
})

test('conversation turn: second call sends the first turn as history', async ({ assert }) => {
  const store = new MemoryConversationStore()
  const model = fakeModel([{ text: 'first answer' }, { text: 'second answer' }])
  const ai = managerWith(model, store)
  const conversation = await ai.conversations.start('user:1')

  await ai.generateText({ prompt: 'question one', conversation: { id: conversation.id, owner: 'user:1' } })
  await ai.generateText({ prompt: 'question two', conversation: { id: conversation.id, owner: 'user:1' } })

  model.assertCalledTimes(2)
  const secondPrompt = JSON.stringify(model.calls[1].prompt)
  assert.include(secondPrompt, 'question one')
  assert.include(secondPrompt, 'first answer')
  assert.include(secondPrompt, 'question two')
})

test('conversation turn: version grows by one per turn', async ({ assert }) => {
  const store = new MemoryConversationStore()
  const model = fakeModel([{ text: 'a' }, { text: 'b' }])
  const ai = managerWith(model, store)
  const conversation = await ai.conversations.start('user:1')
  const owned = { id: conversation.id, owner: 'user:1' }

  const first = await ai.generateText({ prompt: 'one', conversation: owned })
  const second = await ai.generateText({ prompt: 'two', conversation: owned })

  assert.deepEqual(first.conversation, { id: conversation.id, version: 1 })
  assert.deepEqual(second.conversation, { id: conversation.id, version: 2 })
  const stored = await store.load(conversation.id, 'user:1')
  assert.equal(stored?.version, 2)
  assert.lengthOf(stored?.messages ?? [], 4)
})

test('failed turn appends nothing', async ({ assert }) => {
  const store = new MemoryConversationStore()
  const model = fakeModel([{ error: fakeApiError(400) }])
  const ai = managerWith(model, store)
  const conversation = await ai.conversations.start('user:1')

  const err = await rejectionOf(() =>
    ai.generateText({ prompt: 'will fail', conversation: { id: conversation.id, owner: 'user:1' } })
  )

  assert.isDefined(err)
  const stored = await store.load(conversation.id, 'user:1')
  assert.equal(stored?.version, 0)
  assert.lengthOf(stored?.messages ?? [], 0)
})

test('stream turn is stored when the stream ends', async ({ assert }) => {
  const store = new MemoryConversationStore()
  const model = fakeModel([{ text: 'streamed answer' }])
  const ai = managerWith(model, store)
  const conversation = await ai.conversations.start('user:1')

  const result = await ai.streamText({ prompt: 'stream me', conversation: { id: conversation.id, owner: 'user:1' } })
  await result.consume()

  const stored = await store.load(conversation.id, 'user:1')
  assert.equal(stored?.version, 1)
  assert.deepEqual(
    stored?.messages.map((m) => m.role),
    ['user', 'assistant']
  )
})

test('aborted stream stores nothing', async ({ assert }) => {
  const store = new MemoryConversationStore()
  // Starts a text answer and never finishes it, so only an abort ends the stream.
  const hanging = new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'hanging',
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] })
          controller.enqueue({ type: 'text-start', id: 't' })
          controller.enqueue({ type: 'text-delta', id: 't', delta: 'partial' })
        },
      }),
    }),
  })
  const ai = managerWith(hanging, store)
  const conversation = await ai.conversations.start('user:1')
  const controller = new AbortController()

  const result = await ai.streamText({
    prompt: 'abort me',
    abortSignal: controller.signal,
    conversation: { id: conversation.id, owner: 'user:1' },
  })
  const drained = (async () => {
    for await (const _part of result.fullStream) {
      // Read until the abort ends the stream.
    }
  })().catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 20))
  controller.abort()
  await drained
  await result.usage

  const stored = await store.load(conversation.id, 'user:1')
  assert.equal(stored?.version, 0)
  assert.lengthOf(stored?.messages ?? [], 0)
})

test('AgentRunner.run passes the conversation through; system prompt is not stored', async ({ assert }) => {
  const store = new MemoryConversationStore()
  const model = fakeModel([{ text: 'agent answer' }])
  const ai = managerWith(model, store)
  const conversation = await ai.conversations.start('user:1')
  const config = {
    id: 'support',
    description: 'support agent',
    mode: 'primary',
    stopSteps: 1,
    skills: [],
    skillLoading: 'eager',
    systemPrompt: 'AGENT-PROMPT-SECRET',
    eagerSystemPrompt: 'AGENT-PROMPT-SECRET',
    body: '',
    skillPrompts: {},
    skillEntries: [],
    permissions: {},
    phases: [],
  } as unknown as AgentPromptConfig
  const runner = new AgentRunner(ai, config)

  await runner.run({ prompt: 'agent question', conversation: { id: conversation.id, owner: 'user:1' } })

  assert.include(JSON.stringify(model.calls[0].prompt), 'AGENT-PROMPT-SECRET')
  const stored = await store.load(conversation.id, 'user:1')
  assert.deepEqual(
    stored?.messages.map((m) => m.role),
    ['user', 'assistant']
  )
  assert.notInclude(JSON.stringify(stored?.messages), 'AGENT-PROMPT-SECRET')
})

test('corrupt stored message raises ConversationCorruptError', async ({ assert }) => {
  const inner = new MemoryConversationStore()
  const conversation = await inner.create('user:1')
  await inner.append(conversation.id, 'user:1', {
    messages: [{ role: 'user', content: 'ok' }],
    expectedVersion: 0,
  })
  // An adapter that returns a message the kit cannot read.
  const corrupt: ConversationStore = {
    ...inner,
    durable: false,
    create: (owner, init) => inner.create(owner, init),
    append: (id, owner, change) => inner.append(id, owner, change),
    list: (owner, page) => inner.list(owner, page),
    delete: (id, owner) => inner.delete(id, owner),
    load: async (id, owner) => {
      const record = await inner.load(id, owner)
      if (!record) return null
      return { ...record, messages: [{ role: 'not-a-role', content: 'x' }] } as unknown as ConversationRecord
    },
  }
  const model = fakeModel([{ text: 'never' }])
  const ai = managerWith(model, corrupt)

  const err = await rejectionOf(() =>
    ai.generateText({ prompt: 'hi', conversation: { id: conversation.id, owner: 'user:1' } })
  )

  assert.instanceOf(err, ConversationCorruptError)
  assert.equal((err as AiException).code, 'E_AI_CONVERSATION_CORRUPT')
  model.assertCalledTimes(0)
})

test('binary message part is rejected on append', async ({ assert }) => {
  const store = new MemoryConversationStore()
  const model = fakeModel([{ text: 'never' }])
  const ai = managerWith(model, store)
  const conversation = await ai.conversations.start('user:1')

  const err = await rejectionOf(() =>
    ai.generateText({
      messages: [
        {
          role: 'user',
          content: [{ type: 'file', data: new Uint8Array([1, 2, 3]), mediaType: 'application/pdf' }],
        },
      ],
      conversation: { id: conversation.id, owner: 'user:1' },
    })
  )

  assert.equal((err as AiException).code, 'E_AI_INVALID_ARGUMENT')
  model.assertCalledTimes(0)
  assert.equal((await store.load(conversation.id, 'user:1'))?.version, 0)
})

test('prepareHistory trims what the model sees but the store keeps the full history', async ({ assert }) => {
  const store = new MemoryConversationStore()
  const model = fakeModel([{ text: 'answer one' }, { text: 'answer two' }, { text: 'answer three' }])
  const ai = managerWith(model, store)
  const conversation = await ai.conversations.start('user:1')
  const owned = { id: conversation.id, owner: 'user:1' }

  await ai.generateText({ prompt: 'question one', conversation: owned })
  await ai.generateText({ prompt: 'question two', conversation: owned })
  await ai.generateText({
    prompt: 'question three',
    conversation: { ...owned, prepareHistory: (messages) => messages.slice(-2) },
  })

  const sent = JSON.stringify(model.calls[2].prompt)
  assert.notInclude(sent, 'question one')
  assert.notInclude(sent, 'answer one')
  assert.include(sent, 'answer two')
  assert.include(sent, 'question three')
  const stored = await store.load(conversation.id, 'user:1')
  assert.lengthOf(stored?.messages ?? [], 6)
  assert.include(JSON.stringify(stored?.messages), 'question one')
})

test('system messages sent with a turn are not stored', async ({ assert }) => {
  const store = new MemoryConversationStore()
  const model = fakeModel([{ text: 'ok' }])
  const ai = managerWith(model, store)
  const conversation = await ai.conversations.start('user:1')

  await ai.generateText({
    system: 'SYSTEM-ONLY',
    prompt: 'hi',
    conversation: { id: conversation.id, owner: 'user:1' },
  })

  const stored = await store.load(conversation.id, 'user:1')
  assert.notInclude(JSON.stringify(stored?.messages), 'SYSTEM-ONLY')
  assert.notInclude(stored?.messages.map((m) => m.role) ?? [], 'system')
})

test('Conversations is exported with the store it was given', async ({ assert }) => {
  const store = new MemoryConversationStore()
  assert.strictEqual(new Conversations({ store, logger: quiet }).store, store)
})
