import { randomUUID } from 'node:crypto'
import { AiManager } from '../../../src/ai_manager.js'
import { defineConfig } from '../../../src/define_config.js'
import { MemoryConversationStore } from '../../../src/conversations/memory_store.js'
import {
  ConversationConflictError,
  ConversationNotFoundError,
} from '../../../src/conversations/errors.js'
import type {
  ConversationChange,
  ConversationRecord,
  ConversationStore,
  ConversationSummary,
} from '../../../src/conversations/types.js'
import { fakeModel, fakeProvider, fakeTools, type FakeModel } from '../../../src/testing/index.js'

export const SECRET = 'a'.repeat(32)

export const quiet = { info() {}, warn() {}, error() {}, debug() {} }

/** Script for one run that asks for one `danger` call, then answers. */
export const askOnce = (input: unknown = { n: 1 }) => [
  { toolCalls: [{ name: 'danger', input }] },
  { text: 'done' },
]

/** A `danger` tool that records its executions; `inputs.danger` lists the inputs it ran with. */
export const dangerTools = () => fakeTools({ danger: (input) => ({ ok: (input as { n: number }).n }) })

/** A manager whose only provider answers with `model`, with approvals configured and conversations in `store`. */
export function managerFor(
  model: FakeModel,
  options: { store?: ConversationStore; approvals?: Record<string, unknown>; logger?: typeof quiet; extra?: Record<string, unknown> } = {}
): AiManager {
  return new AiManager(
    defineConfig({
      default: 'main',
      providers: { main: fakeProvider(model) },
      catalog: { autoPricing: false },
      conversations: { store: options.store ?? new MemoryConversationStore() },
      approvals: { secret: SECRET, allowVolatileStore: true, ...(options.approvals ?? {}) },
      ...(options.extra ?? {}),
    } as never),
    options.logger ?? quiet
  )
}

/** The error a promise rejects with; fails the test when it resolves. */
export async function rejectionOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
  } catch (err) {
    return err
  }
  throw new Error('expected the call to reject')
}

/**
 * A durable store that keeps every record as JSON text, the way a database row would. `rows` is public so a test can
 * copy it to a new store (a restart) or edit it in place (a tampered row).
 */
export class JsonRowStore implements ConversationStore {
  readonly durable = true
  readonly rows = new Map<string, string>()

  private read(id: string): ConversationRecord | undefined {
    const text = this.rows.get(id)
    if (text === undefined) return undefined
    const stored = JSON.parse(text) as Omit<ConversationRecord, 'createdAt' | 'updatedAt'> & {
      createdAt: string
      updatedAt: string
    }
    return { ...stored, createdAt: new Date(stored.createdAt), updatedAt: new Date(stored.updatedAt) }
  }

  private write(record: ConversationRecord): void {
    this.rows.set(
      record.id,
      JSON.stringify({ ...record, createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString() })
    )
  }

  async create(owner: string, init: { agentName?: string; metadata?: Record<string, unknown> } = {}): Promise<ConversationRecord> {
    const now = new Date()
    const record: ConversationRecord = {
      id: randomUUID(),
      owner,
      messages: [],
      version: 0,
      state: null,
      ...init,
      createdAt: now,
      updatedAt: now,
    }
    this.write(record)
    return this.read(record.id) as ConversationRecord
  }

  async load(id: string, owner: string): Promise<ConversationRecord | null> {
    const record = this.read(id)
    return record && record.owner === owner ? record : null
  }

  async append(id: string, owner: string, change: ConversationChange): Promise<{ version: number }> {
    const record = this.read(id)
    if (!record || record.owner !== owner) throw new ConversationNotFoundError()
    if (record.version !== change.expectedVersion) throw new ConversationConflictError(id, change.expectedVersion)
    record.messages.push(...change.messages)
    if (change.state !== undefined) record.state = change.state
    record.version += 1
    record.updatedAt = new Date()
    this.write(record)
    return { version: record.version }
  }

  async list(owner: string): Promise<{ items: ConversationSummary[] }> {
    const items = [...this.rows.keys()]
      .map((id) => this.read(id) as ConversationRecord)
      .filter((record) => record.owner === owner)
      .map(({ messages: _messages, ...summary }) => summary)
    return { items }
  }

  async delete(id: string, owner: string): Promise<boolean> {
    const record = this.read(id)
    if (!record || record.owner !== owner) return false
    return this.rows.delete(id)
  }

  /** Edits a stored record in place, as a row edited outside the application would be. */
  tamper(id: string, edit: (record: { messages: Array<Record<string, any>>; state: any }) => void): void {
    const record = JSON.parse(this.rows.get(id) as string)
    edit(record)
    this.rows.set(id, JSON.stringify(record))
  }

  /** Copies every row into `other`, as a restart with the same database would see them. */
  copyRowsTo(other: JsonRowStore): void {
    for (const [id, text] of this.rows) other.rows.set(id, text)
  }
}
