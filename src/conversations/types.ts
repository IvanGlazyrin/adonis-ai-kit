import type { ModelMessage } from 'ai'

/** A JSON value. The kit stores `state` as JSON, so an adapter must be able to serialize it. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** One stored conversation, with its messages. */
export interface ConversationRecord {
  id: string
  owner: string
  messages: ModelMessage[]
  /** Starts at 0 and grows by one with every `append`. Used for compare-and-set. */
  version: number
  /** Opaque JSON state of the kit (pending approvals, from B7). `null` when unset. */
  state: JsonValue | null
  agentName?: string
  metadata?: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

/** A conversation without its messages, for listings. */
export type ConversationSummary = Omit<ConversationRecord, 'messages'>

export interface ConversationPage {
  /** Items per page. Default 20, at most 100. */
  limit?: number
  /** Opaque cursor from the previous page's `nextCursor`. */
  cursor?: string
}

export interface ConversationListResult {
  items: ConversationSummary[]
  /** Present when another page exists. */
  nextCursor?: string
}

export interface ConversationChange {
  /** Messages added to the end of the history. May be empty (for a `state`-only change). */
  messages: ModelMessage[]
  /** The version the caller read. The append fails with `ConversationConflictError` when it is stale. */
  expectedVersion: number
  /** Replaces `state` when given; `undefined` keeps it. */
  state?: JsonValue | null
}

/**
 * Storage port for conversations. Every method that takes an `owner` must treat a conversation of another owner
 * as absent. The kit checks the owner again on top of that, so an adapter that forgets it is still caught.
 */
export interface ConversationStore {
  /** `true` when records survive a process restart. The in-memory store is `false`. */
  readonly durable: boolean
  create(owner: string, init?: { agentName?: string; metadata?: Record<string, unknown> }): Promise<ConversationRecord>
  /** The record, or `null` when the id is unknown or belongs to another owner. */
  load(id: string, owner: string): Promise<ConversationRecord | null>
  /**
   * Appends messages and bumps the version. Throws `ConversationNotFoundError` for an unknown id or another owner,
   * and `ConversationConflictError` when `expectedVersion` is stale.
   */
  append(id: string, owner: string, change: ConversationChange): Promise<{ version: number }>
  list(owner: string, page?: ConversationPage): Promise<ConversationListResult>
  /** `false` when the id is unknown or belongs to another owner. */
  delete(id: string, owner: string): Promise<boolean>
}

/** The conversation a call continues. Passed as `conversation` in `generateText` and `streamText`. */
export interface ConversationCallOptions {
  id: string
  /** Opaque, non-empty owner key, for example `user:42`. Compared with `===`. */
  owner: string
  /**
   * Shapes the stored history before the model sees it, for example with `pruneMessages`. The stored history is not
   * changed; only the messages sent to the model are.
   */
  prepareHistory?: (messages: ModelMessage[]) => ModelMessage[]
}
