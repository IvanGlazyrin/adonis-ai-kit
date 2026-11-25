import { randomUUID } from 'node:crypto'
import type { Database } from '@adonisjs/lucid/database'
import type { QueryClientContract, TransactionClientContract } from '@adonisjs/lucid/types/database'
import { AiException } from '../errors.js'
import {
  ConversationConflictError,
  ConversationCorruptError,
  ConversationNotFoundError,
} from '../conversations/errors.js'
import type {
  ConversationChange,
  ConversationListResult,
  ConversationPage,
  ConversationRecord,
  ConversationStore,
  ConversationSummary,
  JsonValue,
} from '../conversations/types.js'

const DEFAULT_CONVERSATIONS_TABLE = 'ai_conversations'
const DEFAULT_MESSAGES_TABLE = 'ai_conversation_messages'
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

export interface LucidConversationStoreOptions {
  connection?: string
  /** Table for conversation headers. Default: `'ai_conversations'`. */
  conversationsTable?: string
  /** Table for conversation messages. Default: `'ai_conversation_messages'`. */
  messagesTable?: string
}

interface ConversationRow {
  id: string
  owner: string
  agent_name: string | null
  version: number
  state: string | null
  metadata: string | null
  created_at: Date | string | number
  updated_at: Date | string | number
}

interface MessageRow {
  seq: number
  message: string
}

interface ListCursor {
  updatedAt: string
  id: string
}

function affectedCount(result: unknown): number {
  if (typeof result === 'number') return result
  if (Array.isArray(result)) {
    return typeof result[0] === 'number' ? result[0] : result.length
  }
  return 0
}

function toDate(value: Date | string | number): Date {
  if (value instanceof Date) return new Date(value.getTime())
  return new Date(value)
}

function parseJson<T>(raw: unknown, conversationId: string, field: string): T {
  if (typeof raw !== 'string') return raw as T
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new ConversationCorruptError(conversationId, `invalid JSON in ${field}`)
  }
}

function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url')
}

function decodeCursor(raw: string): ListCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8')) as Partial<ListCursor>
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.updatedAt === 'string' &&
      !Number.isNaN(Date.parse(parsed.updatedAt)) &&
      typeof parsed.id === 'string' &&
      parsed.id.length > 0
    ) {
      return { updatedAt: parsed.updatedAt, id: parsed.id }
    }
  } catch {
    // Fall through to uniform error
  }
  throw new AiException('cursor is not valid for this store', 'E_AI_INVALID_ARGUMENT')
}

function toSummary(row: ConversationRow): ConversationSummary {
  const id = String(row.id)
  const summary: ConversationSummary = {
    id,
    owner: String(row.owner),
    version: Number(row.version),
    state: row.state === null || row.state === undefined ? null : parseJson<JsonValue | null>(row.state, id, 'state'),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  }
  if (row.agent_name !== null && row.agent_name !== undefined) {
    summary.agentName = String(row.agent_name)
  }
  if (row.metadata !== null && row.metadata !== undefined) {
    summary.metadata = parseJson<Record<string, unknown>>(row.metadata, id, 'metadata')
  }
  return summary
}

/**
 * Durable `ConversationStore` backed by `@adonisjs/lucid`. Stores JSON payloads as text so behavior is identical
 * across PostgreSQL and SQLite, and checks `(owner, expectedVersion)` inside a single transaction on `append`.
 */
export class LucidConversationStore implements ConversationStore {
  readonly durable = true
  private readonly connection?: string
  private readonly conversationsTable: string
  private readonly messagesTable: string

  constructor(
    private readonly db: Database,
    options: LucidConversationStoreOptions = {}
  ) {
    this.connection = options.connection
    this.conversationsTable = options.conversationsTable ?? DEFAULT_CONVERSATIONS_TABLE
    this.messagesTable = options.messagesTable ?? DEFAULT_MESSAGES_TABLE
  }

  private client(): QueryClientContract | TransactionClientContract {
    return this.connection ? this.db.connection(this.connection) : this.db.connection()
  }

  async create(
    owner: string,
    init: { agentName?: string; metadata?: Record<string, unknown> } = {}
  ): Promise<ConversationRecord> {
    const id = randomUUID()
    const now = new Date()
    await this.client()
      .table(this.conversationsTable)
      .insert({
        id,
        owner,
        agent_name: init.agentName ?? null,
        version: 0,
        state: null,
        metadata: init.metadata !== undefined ? JSON.stringify(init.metadata) : null,
        created_at: now,
        updated_at: now,
      })

    const record: ConversationRecord = {
      id,
      owner,
      messages: [],
      version: 0,
      state: null,
      createdAt: new Date(now.getTime()),
      updatedAt: new Date(now.getTime()),
    }
    if (init.agentName !== undefined) record.agentName = init.agentName
    if (init.metadata !== undefined) {
      record.metadata = JSON.parse(JSON.stringify(init.metadata)) as Record<string, unknown>
    }
    return record
  }

  async load(id: string, owner: string): Promise<ConversationRecord | null> {
    const client = this.client()
    const row = (await client
      .from(this.conversationsTable)
      .where({ id, owner })
      .first()) as ConversationRow | null
    if (!row) return null

    const messageRows = (await client
      .from(this.messagesTable)
      .where('conversation_id', id)
      .orderBy('seq', 'asc')
      .select('seq', 'message')) as MessageRow[]

    const messages = messageRows.map((entry) =>
      parseJson<ConversationRecord['messages'][number]>(entry.message, id, `message[${entry.seq}]`)
    )

    return {
      ...toSummary(row),
      messages,
    }
  }

  async append(id: string, owner: string, change: ConversationChange): Promise<{ version: number }> {
    const nextVersion = change.expectedVersion + 1
    const now = new Date()
    const updateFields: Record<string, unknown> = {
      version: nextVersion,
      updated_at: now,
    }
    if (change.state !== undefined) {
      updateFields.state = change.state === null ? null : JSON.stringify(change.state)
    }

    return this.client().transaction(async (trx) => {
      const updated = await trx
        .from(this.conversationsTable)
        .where({ id, owner, version: change.expectedVersion })
        .update(updateFields)

      if (affectedCount(updated) === 0) {
        const existing = (await trx
          .from(this.conversationsTable)
          .where('id', id)
          .select('owner')
          .first()) as { owner: string } | null
        if (!existing || existing.owner !== owner) {
          throw new ConversationNotFoundError()
        }
        throw new ConversationConflictError(id, change.expectedVersion)
      }

      if (change.messages.length > 0) {
        const maxRow = (await trx
          .from(this.messagesTable)
          .where('conversation_id', id)
          .max('seq as max_seq')
          .first()) as { max_seq: number | string | null } | null
        const base =
          maxRow?.max_seq !== null && maxRow?.max_seq !== undefined ? Number(maxRow.max_seq) + 1 : 0

        await trx.table(this.messagesTable).multiInsert(
          change.messages.map((message, index) => ({
            conversation_id: id,
            seq: base + index,
            message: JSON.stringify(message),
            created_at: now,
          }))
        )
      }

      return { version: nextVersion }
    })
  }

  async list(owner: string, page: ConversationPage = {}): Promise<ConversationListResult> {
    const limit = page.limit ?? DEFAULT_LIMIT
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new AiException(`limit must be an integer from 1 to ${MAX_LIMIT}`, 'E_AI_INVALID_ARGUMENT')
    }
    const cursor = page.cursor !== undefined ? decodeCursor(page.cursor) : undefined

    const query = this.client()
      .from(this.conversationsTable)
      .where('owner', owner)
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)

    if (cursor) {
      const cursorDate = new Date(cursor.updatedAt)
      query.where((builder) => {
        builder.where('updated_at', '<', cursorDate).orWhere((tie) => {
          tie.where('updated_at', cursorDate).where('id', '<', cursor.id)
        })
      })
    }

    const rows = (await query) as ConversationRow[]
    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const items = pageRows.map(toSummary)

    if (!hasMore || pageRows.length === 0) {
      return { items }
    }
    const last = pageRows[pageRows.length - 1]
    return {
      items,
      nextCursor: encodeCursor({
        updatedAt: toDate(last.updated_at).toISOString(),
        id: String(last.id),
      }),
    }
  }

  async delete(id: string, owner: string): Promise<boolean> {
    return this.client().transaction(async (trx) => {
      const row = (await trx.from(this.conversationsTable).where({ id, owner }).select('id').first()) as {
        id: string
      } | null
      if (!row) return false
      await trx.from(this.messagesTable).where('conversation_id', id).delete()
      const deleted = await trx.from(this.conversationsTable).where({ id, owner }).delete()
      return affectedCount(deleted) > 0
    })
  }
}
