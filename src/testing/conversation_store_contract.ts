import { ConversationConflictError, ConversationNotFoundError } from '../conversations/errors.js'
import type { ConversationStore } from '../conversations/types.js'

/** One check of the adapter contract. `run` throws when the adapter breaks the rule. */
export interface ConversationStoreCheck {
  name: string
  run(): Promise<void>
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`conversation store contract: ${message}`)
}

/** The error a call rejects with; fails the check when the call resolves. */
async function rejectionOf(run: () => Promise<unknown>, message: string): Promise<unknown> {
  try {
    await run()
  } catch (err) {
    return err
  }
  throw new Error(`conversation store contract: ${message}`)
}

/**
 * The contract every conversation store (an application's Lucid adapter, for example) must meet. Each check gets a
 * fresh store from `factory`. Use it from any test runner:
 *
 *     for (const check of conversationStoreContract(() => new LucidConversationStore())) {
 *       test(check.name, () => check.run())
 *     }
 */
export function conversationStoreContract(
  factory: () => ConversationStore | Promise<ConversationStore>
): ConversationStoreCheck[] {
  return [
    {
      name: 'create returns a record owned by the caller with version 0',
      async run() {
        const store = await factory()
        const record = await store.create('user:1')
        expect(record.owner === 'user:1', 'the record owner must be the caller')
        expect(record.version === 0, 'a new conversation has version 0')
        expect(Array.isArray(record.messages) && record.messages.length === 0, 'a new conversation has no messages')
      },
    },
    {
      name: 'load with another owner returns null',
      async run() {
        const store = await factory()
        const record = await store.create('user:1')
        expect((await store.load(record.id, 'user:2')) === null, 'a foreign owner must not load the record')
        expect((await store.load('unknown-id', 'user:1')) === null, 'an unknown id must load as null')
      },
    },
    {
      name: 'append with another owner throws ConversationNotFoundError',
      async run() {
        const store = await factory()
        const record = await store.create('user:1')
        const err = await rejectionOf(
          () => store.append(record.id, 'user:2', { messages: [{ role: 'user', content: 'x' }], expectedVersion: 0 }),
          'append with a foreign owner must throw'
        )
        expect(err instanceof ConversationNotFoundError, 'append with a foreign owner must throw ConversationNotFoundError')
        expect((await store.load(record.id, 'user:1'))?.version === 0, 'a rejected append must not change the version')
      },
    },
    {
      name: 'append with a stale version throws ConversationConflictError',
      async run() {
        const store = await factory()
        const record = await store.create('user:1')
        const first = await store.append(record.id, 'user:1', { messages: [], expectedVersion: 0 })
        expect(first.version === 1, 'append bumps the version by one')
        const err = await rejectionOf(
          () => store.append(record.id, 'user:1', { messages: [], expectedVersion: 0 }),
          'a stale expectedVersion must throw'
        )
        expect(err instanceof ConversationConflictError, 'a stale expectedVersion must throw ConversationConflictError')
      },
    },
    {
      name: "list returns only the owner's conversations",
      async run() {
        const store = await factory()
        await store.create('user:1')
        await store.create('user:1')
        await store.create('user:2')
        const page = await store.list('user:1')
        expect(page.items.length === 2, 'list must return the two conversations of user:1')
        expect(
          page.items.every((item) => item.owner === 'user:1'),
          'list must not return conversations of another owner'
        )
      },
    },
    {
      name: 'delete by another owner returns false and keeps the conversation',
      async run() {
        const store = await factory()
        const record = await store.create('user:1')
        expect((await store.delete(record.id, 'user:2')) === false, 'a foreign delete must return false')
        expect((await store.load(record.id, 'user:1')) !== null, 'a foreign delete must keep the conversation')
      },
    },
    {
      name: 'loaded records are copies',
      async run() {
        const store = await factory()
        const record = await store.create('user:1')
        await store.append(record.id, 'user:1', { messages: [{ role: 'user', content: 'kept' }], expectedVersion: 0 })
        const loaded = await store.load(record.id, 'user:1')
        loaded?.messages.push({ role: 'user', content: 'injected' })
        const again = await store.load(record.id, 'user:1')
        expect(again?.messages.length === 1, 'changing a loaded record must not change the store')
      },
    },
  ]
}
