import { modelMessageSchema, type ModelMessage } from 'ai'
import { AiException } from '../errors.js'
import type { Logger } from '../logger.js'
import { ConversationCorruptError, ConversationNotFoundError } from './errors.js'
import { MemoryConversationStore } from './memory_store.js'
import type {
  ConversationCallOptions,
  ConversationListResult,
  ConversationPage,
  ConversationRecord,
  ConversationStore,
} from './types.js'

export interface ConversationsOptions {
  /** The store to use. Default: an in-memory store (not durable). */
  store?: ConversationStore
  logger?: Logger
}

/**
 * One open turn of a conversation: the history to send, and the way to store the turn once the model answered.
 * Nothing is stored before `commit`, so a failed or aborted turn leaves the conversation as it was.
 */
export interface ConversationTurn {
  readonly id: string
  /** The history to send to the model, before the turn's own messages. */
  readonly history: ModelMessage[]
  /** Appends the turn's messages and the model's response messages. Returns the new version. */
  commit(responseMessages: ModelMessage[]): Promise<number>
}

/** The owner must be a non-blank string. It is an opaque key, compared with `===`. */
function assertOwner(owner: unknown): asserts owner is string {
  if (typeof owner !== 'string' || owner.trim() === '') {
    throw new AiException('owner must be a non-empty string', 'E_AI_INVALID_ARGUMENT')
  }
}

/** Binary values cannot be stored as JSON: a `Uint8Array`, an `ArrayBuffer` or a `URL` anywhere in the messages. */
function assertJsonMessages(messages: ModelMessage[]): void {
  const visit = (value: unknown): boolean => {
    if (value instanceof URL || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true
    if (value === null || typeof value !== 'object') return false
    return Object.values(value).some(visit)
  }
  if (messages.some(visit)) {
    throw new AiException(
      'Conversation messages must be JSON: binary parts (Uint8Array, ArrayBuffer, URL) cannot be stored. Store files outside the conversation.',
      'E_AI_INVALID_ARGUMENT'
    )
  }
}

/** The stored messages, each checked against the `ModelMessage` format. */
function readMessages(record: ConversationRecord): ModelMessage[] {
  if (!Array.isArray(record.messages)) {
    throw new ConversationCorruptError(record.id, 'messages is not an array')
  }
  return record.messages.map((message, index) => {
    const parsed = modelMessageSchema.safeParse(message)
    if (!parsed.success) {
      throw new ConversationCorruptError(record.id, `message ${index} does not match the model message format`)
    }
    return parsed.data
  })
}

/**
 * The conversation API. It checks the owner on every call, so no path reaches a conversation of another owner.
 * An unknown id and a foreign owner give the same result: `ConversationNotFoundError` (or `false` from `delete`).
 */
export class Conversations {
  readonly store: ConversationStore

  constructor(options: ConversationsOptions = {}) {
    this.store = options.store ?? new MemoryConversationStore()
    if (!this.store.durable && process.env.NODE_ENV === 'production') {
      options.logger?.warn?.(
        '[AiManager] Conversations are kept in memory: the history is lost on restart. Configure a durable store (conversations.store).'
      )
    }
  }

  /** A new, empty conversation for `owner`. */
  start(owner: string, init?: { agentName?: string; metadata?: Record<string, unknown> }): Promise<ConversationRecord> {
    assertOwner(owner)
    return this.store.create(owner, init)
  }

  /** The conversation with its messages. Throws `ConversationNotFoundError` for an unknown id or another owner. */
  async get(id: string, owner: string): Promise<ConversationRecord> {
    assertOwner(owner)
    const record = await this.store.load(id, owner)
    if (!record || record.owner !== owner) throw new ConversationNotFoundError()
    return { ...record, messages: readMessages(record) }
  }

  /** The owner's conversations, newest first. Other owners' conversations are never returned. */
  async list(owner: string, page?: ConversationPage): Promise<ConversationListResult> {
    assertOwner(owner)
    const result = await this.store.list(owner, page)
    return { ...result, items: result.items.filter((item) => item.owner === owner) }
  }

  /** Deletes the conversation. `false` when it is unknown or belongs to another owner (nothing is deleted). */
  async delete(id: string, owner: string): Promise<boolean> {
    assertOwner(owner)
    const record = await this.store.load(id, owner)
    if (!record || record.owner !== owner) return false
    return this.store.delete(id, owner)
  }

  /**
   * Opens a turn for a model call. Checks the owner, reads and validates the history, and checks the turn's own
   * messages are storable. Throws before the model is called.
   */
  async openTurn(call: ConversationCallOptions, input: ModelMessage[]): Promise<ConversationTurn> {
    assertOwner(call.owner)
    const record = await this.get(call.id, call.owner)
    // The system prompt is not part of the history: it travels as the call's `system` on every turn.
    const stored = input.filter((message) => message.role !== 'system')
    assertJsonMessages(stored)
    const history = call.prepareHistory ? call.prepareHistory(record.messages) : record.messages
    const { id, owner } = record
    const expectedVersion = record.version
    return {
      id,
      history,
      commit: async (responseMessages: ModelMessage[]) => {
        const appended = [...stored, ...responseMessages]
        assertJsonMessages(appended)
        const { version } = await this.store.append(id, owner, { messages: appended, expectedVersion })
        return version
      },
    }
  }
}
