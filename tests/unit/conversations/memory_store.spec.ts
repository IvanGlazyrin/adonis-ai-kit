import { test } from '@japa/runner'
import { MemoryConversationStore } from '../../../src/conversations/memory_store.js'
import { ConversationConflictError } from '../../../src/conversations/errors.js'
import { conversationStoreContract } from '../../../src/testing/conversation_store_contract.js'

const userText = (text: string) => ({ role: 'user' as const, content: text })

/** The error a promise rejects with; fails the test when it resolves. */
async function rejectionOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
  } catch (err) {
    return err
  }
  throw new Error('expected the call to reject')
}

test('memory store: create returns a record owned by the caller with version 0', async ({ assert }) => {
  const store = new MemoryConversationStore()
  const record = await store.create('user:1', { agentName: 'support' })

  assert.equal(record.owner, 'user:1')
  assert.equal(record.version, 0)
  assert.deepEqual(record.messages, [])
  assert.isNull(record.state)
  assert.equal(record.agentName, 'support')
  assert.isString(record.id)
  assert.instanceOf(record.createdAt, Date)
})

test('memory store: load with another owner returns null', async ({ assert }) => {
  const store = new MemoryConversationStore()
  const record = await store.create('user:1')

  assert.isNull(await store.load(record.id, 'user:2'))
  assert.isNull(await store.load('unknown-id', 'user:1'))
  assert.equal((await store.load(record.id, 'user:1'))?.id, record.id)
})

test('append with a stale version throws ConversationConflictError', async ({ assert }) => {
  const store = new MemoryConversationStore()
  const record = await store.create('user:1')

  const first = await store.append(record.id, 'user:1', { messages: [userText('hi')], expectedVersion: 0 })
  assert.equal(first.version, 1)

  const err = await rejectionOf(() =>
    store.append(record.id, 'user:1', { messages: [userText('again')], expectedVersion: 0 })
  )
  assert.instanceOf(err, ConversationConflictError)
  const stored = await store.load(record.id, 'user:1')
  assert.equal(stored?.messages.length, 1)
})

test("list returns only the owner's conversations, paginated", async ({ assert }) => {
  const store = new MemoryConversationStore()
  for (let i = 0; i < 5; i++) await store.create('user:1')
  for (let i = 0; i < 2; i++) await store.create('user:2')

  const first = await store.list('user:1', { limit: 2 })
  assert.lengthOf(first.items, 2)
  assert.isString(first.nextCursor)

  const second = await store.list('user:1', { limit: 2, cursor: first.nextCursor })
  assert.lengthOf(second.items, 2)

  const last = await store.list('user:1', { limit: 2, cursor: second.nextCursor })
  assert.lengthOf(last.items, 1)
  assert.isUndefined(last.nextCursor)

  const ids = [...first.items, ...second.items, ...last.items].map((item) => item.id)
  assert.lengthOf(new Set(ids), 5)
  for (const item of [...first.items, ...second.items, ...last.items]) {
    assert.equal(item.owner, 'user:1')
    assert.notProperty(item, 'messages')
  }
})

test('delete by a foreign owner returns false and keeps the conversation', async ({ assert }) => {
  const store = new MemoryConversationStore()
  const record = await store.create('user:1')

  assert.isFalse(await store.delete(record.id, 'user:2'))
  assert.isNotNull(await store.load(record.id, 'user:1'))

  assert.isTrue(await store.delete(record.id, 'user:1'))
  assert.isNull(await store.load(record.id, 'user:1'))
})

test('memory store: records are copied on the way in and out', async ({ assert }) => {
  const store = new MemoryConversationStore()
  const record = await store.create('user:1')
  const input = [userText('hello')]
  await store.append(record.id, 'user:1', { messages: input, expectedVersion: 0 })
  input[0].content = 'changed after append'

  const loaded = await store.load(record.id, 'user:1')
  assert.deepEqual(loaded?.messages, [userText('hello')])
  loaded?.messages.push(userText('injected'))

  const again = await store.load(record.id, 'user:1')
  assert.lengthOf(again?.messages ?? [], 1)
})

test('memory store is not durable', async ({ assert }) => {
  assert.isFalse(new MemoryConversationStore().durable)
})

test('MemoryConversationStore passes conversationStoreContract', async () => {
  for (const check of conversationStoreContract(() => new MemoryConversationStore())) {
    await check.run()
  }
})
