import { test } from '@japa/runner'
import { AiManager } from '../../../src/ai_manager.js'
import { defineConfig } from '../../../src/define_config.js'
import { ConversationConflictError } from '../../../src/conversations/errors.js'
import { LucidConversationStore } from '../../../src/lucid/index.js'
import { conversationStoreContract, fakeModel, fakeProvider, fakeTools } from '../../../src/testing/index.js'
import { createTestDatabase, type TestDatabaseHandle } from './helpers.js'

const SECRET = 'a'.repeat(32)
const quiet = { info() {}, warn() {}, error() {}, debug() {} }

test.group('LucidConversationStore contract', (group) => {
  const handles: TestDatabaseHandle[] = []

  group.each.teardown(async () => {
    while (handles.length > 0) {
      await handles.pop()!.close()
    }
  })

  for (const check of conversationStoreContract(async () => {
    const handle = await createTestDatabase()
    handles.push(handle)
    return new LucidConversationStore(handle.db)
  })) {
    test(check.name, () => check.run())
  }
})

test.group('LucidConversationStore', (group) => {
  let handle: TestDatabaseHandle

  group.each.setup(async () => {
    handle = await createTestDatabase()
    return () => handle.close()
  })

  test('two concurrent appends with one expectedVersion: one conflicts, nothing is duplicated', async ({ assert }) => {
    const store = new LucidConversationStore(handle.db)
    const created = await store.create('user:1')

    const results = await Promise.allSettled([
      store.append(created.id, 'user:1', { messages: [{ role: 'user', content: 'first' }], expectedVersion: 0 }),
      store.append(created.id, 'user:1', { messages: [{ role: 'user', content: 'second' }], expectedVersion: 0 }),
    ])

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<{ version: number }> => r.status === 'fulfilled')
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')

    assert.lengthOf(fulfilled, 1)
    assert.lengthOf(rejected, 1)
    assert.instanceOf(rejected[0].reason, ConversationConflictError)

    const loaded = await store.load(created.id, 'user:1')
    assert.equal(loaded?.version, 1)
    assert.lengthOf(loaded?.messages ?? [], 1)
  })

  test('a second store instance on the same database reads the conversation', async ({ assert }) => {
    const store1 = new LucidConversationStore(handle.db)
    const created = await store1.create('user:1', { agentName: 'support', metadata: { topic: 'billing' } })
    await store1.append(created.id, 'user:1', {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
      expectedVersion: 0,
      state: { step: 2 },
    })

    const db2 = await handle.reopen()
    const store2 = new LucidConversationStore(db2)
    const loaded = await store2.load(created.id, 'user:1')

    assert.isNotNull(loaded)
    assert.equal(loaded!.version, 1)
    assert.equal(loaded!.agentName, 'support')
    assert.deepEqual(loaded!.metadata, { topic: 'billing' })
    assert.deepEqual(loaded!.state, { step: 2 })
    assert.deepEqual(loaded!.messages, [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ])
  })

  test('list paginates with cursor across updated_at and id', async ({ assert }) => {
    const store = new LucidConversationStore(handle.db)
    const createdIds: string[] = []
    for (let i = 0; i < 5; i++) {
      const record = await store.create('user:1')
      createdIds.push(record.id)
    }

    const page1 = await store.list('user:1', { limit: 2 })
    assert.lengthOf(page1.items, 2)
    assert.isString(page1.nextCursor)

    const page2 = await store.list('user:1', { limit: 2, cursor: page1.nextCursor })
    assert.lengthOf(page2.items, 2)
    assert.isString(page2.nextCursor)

    const page3 = await store.list('user:1', { limit: 2, cursor: page2.nextCursor })
    assert.lengthOf(page3.items, 1)
    assert.isUndefined(page3.nextCursor)

    const seen = [...page1.items, ...page2.items, ...page3.items].map((item) => item.id)
    assert.sameMembers(seen, createdIds)
    assert.equal(new Set(seen).size, 5)
  })

  test('resumable approvals work on the Lucid store without allowVolatileStore', async ({ assert }) => {
    const model = fakeModel([
      { toolCalls: [{ name: 'danger', input: { n: 7 } }] },
      { text: 'approved and done' },
    ])
    const tools = fakeTools({ danger: (input) => ({ ok: (input as { n: number }).n }) })

    const ai1 = new AiManager(
      defineConfig({
        default: 'main',
        providers: { main: fakeProvider(model) },
        catalog: { autoPricing: false },
        conversations: { store: new LucidConversationStore(handle.db) },
        approvals: { secret: SECRET },
      }),
      quiet
    )

    const conversation = await ai1.conversations.start('user:1')
    const paused = await ai1.generateText({
      prompt: 'run it',
      tools: tools.tools,
      toolPermissions: { danger: 'ask' },
      approvals: 'resumable',
      conversation: { id: conversation.id, owner: 'user:1' },
    })

    assert.equal(paused.status, 'awaiting-approval')
    assert.lengthOf(paused.pendingApprovals, 1)
    assert.lengthOf(tools.inputs.danger, 0)

    const db2 = await handle.reopen()
    const ai2 = new AiManager(
      defineConfig({
        default: 'main',
        providers: { main: fakeProvider(model) },
        catalog: { autoPricing: false },
        conversations: { store: new LucidConversationStore(db2) },
        approvals: { secret: SECRET },
      }),
      quiet
    )

    const resumed = await ai2.conversations.resolveApprovals(
      conversation.id,
      'user:1',
      [{ approvalId: paused.pendingApprovals[0].approvalId, approved: true }],
      { tools: tools.tools, toolPermissions: { danger: 'ask' } }
    )

    assert.equal(resumed.status, 'completed')
    assert.equal(resumed.text, 'approved and done')
    assert.lengthOf(tools.inputs.danger, 1)
  })
})
