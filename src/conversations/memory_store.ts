import { randomUUID } from 'node:crypto'
import { AiException } from '../errors.js'
import { ConversationConflictError, ConversationNotFoundError } from './errors.js'
import type {
  ConversationChange,
  ConversationListResult,
  ConversationPage,
  ConversationRecord,
  ConversationStore,
  ConversationSummary,
} from './types.js'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

/** A record as kept in memory: JSON text, so every read and write is a copy. */
interface StoredRecord extends Omit<ConversationRecord, 'createdAt' | 'updatedAt'> {
  createdAt: string
  updatedAt: string
}

function encode(record: ConversationRecord): string {
  const stored: StoredRecord = {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
  return JSON.stringify(stored)
}

function decode(text: string): ConversationRecord {
  const stored = JSON.parse(text) as StoredRecord
  return { ...stored, createdAt: new Date(stored.createdAt), updatedAt: new Date(stored.updatedAt) }
}

function summaryOf(record: ConversationRecord): ConversationSummary {
  const { messages: _messages, ...summary } = record
  return summary
}

/**
 * Conversations in process memory. The default store when `conversations.store` is not configured. It is not durable:
 * a restart drops every conversation. Copies go in and come out, so the caller cannot change a stored record.
 */
export class MemoryConversationStore implements ConversationStore {
  readonly durable = false
  private readonly rows = new Map<string, string>()

  async create(owner: string, init: { agentName?: string; metadata?: Record<string, unknown> } = {}): Promise<ConversationRecord> {
    const now = new Date()
    const record: ConversationRecord = {
      id: randomUUID(),
      owner,
      messages: [],
      version: 0,
      state: null,
      ...(init.agentName !== undefined ? { agentName: init.agentName } : {}),
      ...(init.metadata !== undefined ? { metadata: init.metadata } : {}),
      createdAt: now,
      updatedAt: now,
    }
    this.rows.set(record.id, encode(record))
    return decode(encode(record))
  }

  async load(id: string, owner: string): Promise<ConversationRecord | null> {
    const record = this.fetch(id)
    return record && record.owner === owner ? record : null
  }

  async append(id: string, owner: string, change: ConversationChange): Promise<{ version: number }> {
    const record = this.fetch(id)
    if (!record || record.owner !== owner) throw new ConversationNotFoundError()
    if (record.version !== change.expectedVersion) {
      throw new ConversationConflictError(id, change.expectedVersion)
    }
    record.messages.push(...(JSON.parse(JSON.stringify(change.messages)) as ConversationRecord['messages']))
    if (change.state !== undefined) record.state = JSON.parse(JSON.stringify(change.state)) as ConversationRecord['state']
    record.version += 1
    record.updatedAt = new Date()
    this.rows.set(id, encode(record))
    return { version: record.version }
  }

  async list(owner: string, page: ConversationPage = {}): Promise<ConversationListResult> {
    const limit = page.limit ?? DEFAULT_LIMIT
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new AiException(`limit must be an integer from 1 to ${MAX_LIMIT}`, 'E_AI_INVALID_ARGUMENT')
    }
    const offset = page.cursor === undefined ? 0 : Number(page.cursor)
    if (!Number.isInteger(offset) || offset < 0) {
      throw new AiException('cursor is not valid for this store', 'E_AI_INVALID_ARGUMENT')
    }
    // Newest first: the rows are kept in creation order.
    const owned = [...this.rows.values()]
      .map(decode)
      .filter((record) => record.owner === owner)
      .reverse()
    const items = owned.slice(offset, offset + limit).map(summaryOf)
    const next = offset + limit
    return next < owned.length ? { items, nextCursor: String(next) } : { items }
  }

  async delete(id: string, owner: string): Promise<boolean> {
    const record = this.fetch(id)
    if (!record || record.owner !== owner) return false
    return this.rows.delete(id)
  }

  private fetch(id: string): ConversationRecord | undefined {
    const text = this.rows.get(id)
    return text === undefined ? undefined : decode(text)
  }
}
