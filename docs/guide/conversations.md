# Conversations & History

Stateful conversation persistence is provided via `adonis-ai-kit/conversations`.

---

## Starting & Continuing Conversations

```ts
import ai from 'adonis-ai-kit/services/main'

// 1. Initialize a conversation owned by a specific user/tenant
const conversation = await ai.conversations.start('user:42')

// 2. First turn
const turn1 = await ai.generateText({
  prompt: 'I live in Stockholm.',
  conversation: { id: conversation.id, owner: 'user:42' },
})

// 3. Second turn (context automatically retained)
const turn2 = await ai.generateText({
  prompt: 'What city do I live in?',
  conversation: { id: conversation.id, owner: 'user:42' },
})

console.log(turn2.text) // "You live in Stockholm."
console.log(turn2.conversation) // { id, version }
```

`ai.conversations` also has `get(id, owner)`, `list(owner, { limit, cursor })` and `delete(id, owner)`.

- A turn is stored as one unit after the model answers. A call that fails stores nothing; a stream is stored when it ends normally.
- The system prompt is not stored: it is sent on every call as `system`.
- Binary parts (`Uint8Array`, `ArrayBuffer`, `URL`) cannot be stored (`E_AI_INVALID_ARGUMENT`, before the model is called).
- Stored messages are validated when loaded; a bad one raises `ConversationCorruptError`.

---

## Strict Owner Verification (Anti-IDOR)

Every conversation call requires an `owner` string identifier:

```ts
await ai.generateText({
  prompt: 'Show sensitive conversation history',
  conversation: { id: conversation.id, owner: 'user:999' }, // Wrong owner!
})
// Throws: ConversationNotFoundError (the model is not called)
```

To prevent Insecure Direct Object Reference (IDOR) enumeration, a conversation of another owner gives the same answer as an unknown id: `ConversationNotFoundError` (or `false` from `delete`). Owners are non-empty strings compared with `===`.

---

## Optimistic Concurrency Control

Each turn increments the conversation `version` by one:
- If two requests continue the same version, one succeeds and the other throws `ConversationConflictError`. The kit does not repeat the model call.
- This prevents database divergence and race conditions.

---

## Pruning Conversation History

To avoid overflowing model context windows over long conversations, pass `prepareHistory`. It shapes only what the model sees, for example with `pruneMessages` from `ai`:

```ts
import { pruneMessages } from 'ai'

const turn = await ai.generateText({
  prompt: 'Let us continue',
  conversation: {
    id: conversation.id,
    owner: 'user:42',
    prepareHistory: (messages) =>
      pruneMessages({
        messages,
        reasoning: 'before-last-message',
        toolCalls: 'before-last-2-messages',
      }).slice(-40),
  },
})
```

The stored history stays complete.

---

## Durable Store (Lucid Adapter)

The default store is in memory (`store.durable === false`): a restart drops every conversation, and in production a warning is logged. The kit has no database dependency: write an adapter that implements `ConversationStore` (`create`, `load`, `append`, `list`, `delete`, and `durable: true`) and register it:

```ts
// config/ai.ts
import { LucidConversationStore } from '#services/lucid_conversation_store' // your adapter

export default defineConfig({
  // ...providers
  conversations: { store: new LucidConversationStore() },
})
```

`append` must check `owner` and `expectedVersion` in one transaction and throw `ConversationNotFoundError` or `ConversationConflictError`. Verify the adapter with `conversationStoreContract` (see [Testing](/guide/testing)).

A table layout that fits the store port:

```ts
// database/migrations/1700000000000_create_ai_conversations.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.createTable('ai_conversations', (table) => {
      table.string('id').primary()
      table.string('owner').notNullable()
      table.string('agent_name').nullable()
      table.integer('version').notNullable().defaultTo(0)
      table.jsonb('state').nullable()
      table.jsonb('metadata').nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').notNullable()
      table.index(['owner', 'updated_at'])
    })

    this.schema.createTable('ai_conversation_messages', (table) => {
      table.increments('id')
      table.string('conversation_id').references('id').inTable('ai_conversations').onDelete('CASCADE')
      table.integer('seq').notNullable()
      table.jsonb('message').notNullable()
      table.timestamp('created_at').notNullable()
      table.unique(['conversation_id', 'seq'])
    })
  }

  async down() {
    this.schema.dropTable('ai_conversation_messages')
    this.schema.dropTable('ai_conversations')
  }
}
```
