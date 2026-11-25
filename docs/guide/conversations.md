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

- A turn is stored as one unit after the model answers: the user messages and the model's response messages. A call that fails stores nothing. A stream is stored when it ends normally; an aborted or failed stream stores nothing.
- The system prompt is not stored: it is sent on every call as `system`. `messages` with `role: 'system'` are sent but not stored.
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

The default store is in memory (`store.durable === false`): a restart drops every conversation, and in production a warning is logged. When your app uses `@adonisjs/lucid`, import `LucidConversationStore` from `adonis-ai-kit/lucid`:

```ts
// config/ai.ts
import db from '@adonisjs/lucid/services/db'
import { defineConfig } from 'adonis-ai-kit'
import { LucidConversationStore } from 'adonis-ai-kit/lucid'

export default defineConfig({
  // ...providers
  conversations: { store: new LucidConversationStore(db) },
})
```

To publish the migration (`ai_conversations` and `ai_conversation_messages`), answer **Yes** when running `node ace configure adonis-ai-kit`. You can also pass `{ connection, conversationsTable, messagesTable }` to `new LucidConversationStore(db, options)`.

Custom adapters can implement `ConversationStore` (`create`, `load`, `append`, `list`, `delete`, and `durable: true`): `append` must check `owner` and `expectedVersion` in one transaction and throw `ConversationNotFoundError` or `ConversationConflictError`. Verify custom adapters with `conversationStoreContract` (see [Testing](/guide/testing)).

Table layout used by `LucidConversationStore`:

```ts
// database/migrations/<timestamp>_create_ai_conversations_tables.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.createTable('ai_conversations', (table) => {
      table.string('id', 36).primary()
      table.string('owner').notNullable()
      table.string('agent_name').nullable()
      table.integer('version').notNullable().defaultTo(0)
      table.text('state').nullable()
      table.text('metadata').nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').notNullable()
      table.index(['owner', 'updated_at'])
    })

    this.schema.createTable('ai_conversation_messages', (table) => {
      table.increments('id').primary()
      table
        .string('conversation_id', 36)
        .notNullable()
        .references('id')
        .inTable('ai_conversations')
        .onDelete('CASCADE')
      table.integer('seq').notNullable()
      table.text('message').notNullable()
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
