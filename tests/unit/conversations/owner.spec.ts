import { test } from '@japa/runner'
import { AiManager } from '../../../src/ai_manager.js'
import { defineConfig } from '../../../src/define_config.js'
import { AiException } from '../../../src/errors.js'
import { Conversations } from '../../../src/conversations/conversations.js'
import { ConversationNotFoundError } from '../../../src/conversations/errors.js'
import { MemoryConversationStore } from '../../../src/conversations/memory_store.js'
import type { ConversationRecord, ConversationStore } from '../../../src/conversations/types.js'
import { fakeModel, fakeProvider } from '../../../src/testing/index.js'

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

/** A store that counts every call it receives, and otherwise delegates to `inner`. */
function countingStore(inner: ConversationStore) {
  const calls: string[] = []
  const store: ConversationStore = {
    durable: inner.durable,
    create: (...args) => (calls.push('create'), inner.create(...args)),
    load: (...args) => (calls.push('load'), inner.load(...args)),
    append: (...args) => (calls.push('append'), inner.append(...args)),
    list: (...args) => (calls.push('list'), inner.list(...args)),
    delete: (...args) => (calls.push('delete'), inner.delete(...args)),
  }
  return { store, calls }
}

test('owner: foreign owner gets not-found', async ({ assert }) => {
  const store = new MemoryConversationStore()
  const conversations = new Conversations({ store, logger: quiet })
  const record = await conversations.start('user:1')
  const model = fakeModel([{ text: 'should not run' }])
  const ai = new AiManager(
    defineConfig({
      default: 'main',
      providers: { main: fakeProvider(model) },
      catalog: { autoPricing: false },
      conversations: { store },
    } as never),
    quiet
  )

  assert.instanceOf(await rejectionOf(() => conversations.get(record.id, 'user:2')), ConversationNotFoundError)
  assert.isFalse(await conversations.delete(record.id, 'user:2'))
  assert.instanceOf(
    await rejectionOf(() => ai.generateText({ prompt: 'hi', conversation: { id: record.id, owner: 'user:2' } })),
    ConversationNotFoundError
  )
  assert.instanceOf(
    await rejectionOf(() =>
      store.append(record.id, 'user:2', { messages: [{ role: 'user', content: 'x' }], expectedVersion: 0 })
    ),
    ConversationNotFoundError
  )

  model.assertCalledTimes(0)
  const unchanged = await store.load(record.id, 'user:1')
  assert.equal(unchanged?.version, 0)
  assert.lengthOf(unchanged?.messages ?? [], 0)
})

test('owner: foreign owner and unknown id give the same error', async ({ assert }) => {
  const store = new MemoryConversationStore()
  const conversations = new Conversations({ store, logger: quiet })
  const record = await conversations.start('user:1')

  const foreign = await rejectionOf(() => conversations.get(record.id, 'user:2'))
  const unknown = await rejectionOf(() => conversations.get('no-such-conversation', 'user:2'))

  assert.instanceOf(foreign, ConversationNotFoundError)
  assert.instanceOf(unknown, ConversationNotFoundError)
  assert.equal((foreign as AiException).code, (unknown as AiException).code)
  assert.equal((foreign as Error).message, (unknown as Error).message)
  assert.equal((foreign as Error).name, (unknown as Error).name)
  assert.deepEqual({ ...(foreign as object) }, { ...(unknown as object) })
  assert.notInclude((foreign as Error).message, 'user:1')
})

test('owner: kit rejects a record whose owner differs even if the adapter returns it', async ({ assert }) => {
  const inner = new MemoryConversationStore()
  const record = await inner.create('user:1')
  // A broken adapter that ignores the owner in `load`.
  const broken: ConversationStore = {
    ...inner,
    durable: false,
    load: async (id: string) => inner.load(id, 'user:1') as Promise<ConversationRecord | null>,
    create: (owner, init) => inner.create(owner, init),
    append: (id, owner, change) => inner.append(id, owner, change),
    list: (owner, page) => inner.list(owner, page),
    delete: (id, owner) => inner.delete(id, owner),
  }
  const conversations = new Conversations({ store: broken, logger: quiet })

  assert.instanceOf(await rejectionOf(() => conversations.get(record.id, 'user:2')), ConversationNotFoundError)
  assert.equal((await conversations.get(record.id, 'user:1')).owner, 'user:1')
})

test('owner: empty or non-string owner is rejected', async ({ assert }) => {
  const inner = new MemoryConversationStore()
  const record = await inner.create('user:1')
  const { store, calls } = countingStore(inner)
  const conversations = new Conversations({ store, logger: quiet })
  const model = fakeModel([{ text: 'never' }])
  const ai = new AiManager(
    defineConfig({
      default: 'main',
      providers: { main: fakeProvider(model) },
      catalog: { autoPricing: false },
      conversations: { store },
    } as never),
    quiet
  )

  for (const owner of ['', undefined, 42]) {
    const err = await rejectionOf(() => conversations.get(record.id, owner as never))
    assert.instanceOf(err, AiException)
    assert.equal((err as AiException).code, 'E_AI_INVALID_ARGUMENT')
    const turn = await rejectionOf(() =>
      ai.generateText({ prompt: 'hi', conversation: { id: record.id, owner: owner as never } })
    )
    assert.equal((turn as AiException).code, 'E_AI_INVALID_ARGUMENT')
  }

  assert.deepEqual(calls, [], 'the adapter must not be called with an invalid owner')
  model.assertCalledTimes(0)
})
