import { modelMessageSchema, type ModelMessage } from 'ai'
import { ApprovalIncompleteError, ApprovalNotFoundError } from '../approvals/errors.js'
import { ApprovalRun, approvalStateOf, asJson, pendingViews } from '../approvals/resumable.js'
import type { ApprovalDecision, PendingApproval, StoredApproval } from '../approvals/types.js'
import { AiException } from '../errors.js'
import type { Logger } from '../logger.js'
import type { GenerateTextOptions, GenerateTextResult } from '../types.js'
import { ConversationCorruptError, ConversationNotFoundError } from './errors.js'
import { MemoryConversationStore } from './memory_store.js'
import type {
  ConversationCallOptions,
  ConversationListResult,
  ConversationPage,
  ConversationRecord,
  ConversationStore,
  JsonValue,
} from './types.js'

/** Options of a call that continues a paused step. The prompt and messages are not used: the approvals answer. */
export type ResumeCallOptions = Omit<GenerateTextOptions, 'prompt' | 'messages' | 'conversation' | 'approvals'>

/** Runs the model call that continues a paused step. `AiManager` provides it; the facade has no model of its own. */
export interface ResumeRunner {
  generate(
    options: GenerateTextOptions,
    resume: { run: ApprovalRun; expiredApprovalIds: string[] }
  ): Promise<GenerateTextResult>
}

export interface ConversationsOptions {
  /** The store to use. Default: an in-memory store (not durable). */
  store?: ConversationStore
  logger?: Logger
  /** The clock for approval expiry. Default: the current time. */
  now?: () => Date
  /** Runs a call that continues a paused step. Set by `AiManager`. */
  runner?: ResumeRunner
}

/**
 * One open turn of a conversation: the history to send, and the way to store the turn once the model answered.
 * Nothing is stored before `commit`, so a failed or aborted turn leaves the conversation as it was.
 */
export interface ConversationTurn {
  readonly id: string
  /** The history to send to the model, before the turn's own messages. */
  readonly history: ModelMessage[]
  /**
   * Appends the turn's messages and the model's response messages. `input` replaces the turn's own messages (a resumed
   * step stores its final tool message). `state` replaces the conversation state; `null` clears it.
   */
  commit(responseMessages: ModelMessage[], extra?: { input?: ModelMessage[]; state?: JsonValue | null }): Promise<number>
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
  private readonly now: () => Date
  private readonly runner?: ResumeRunner

  constructor(options: ConversationsOptions = {}) {
    this.store = options.store ?? new MemoryConversationStore()
    this.now = options.now ?? (() => new Date())
    this.runner = options.runner
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

  /** The open approvals of a paused conversation, with the tool input each one asks for. */
  async pendingApprovals(id: string, owner: string): Promise<PendingApproval[]> {
    const record = await this.get(id, owner)
    const open = approvalStateOf(record.state).approvals.filter((approval) => approval.status === 'pending')
    return pendingViews(record.messages, open)
  }

  /**
   * Decides every open approval of a paused step and continues the step. All approvals of the step need a decision in
   * this one call. The decisions are stored before the tool runs, and an approved tool runs at most once.
   */
  async resolveApprovals(
    id: string,
    owner: string,
    decisions: ApprovalDecision[],
    callOptions: ResumeCallOptions = {}
  ): Promise<GenerateTextResult> {
    assertOwner(owner)
    const record = await this.get(id, owner)
    const approvals = approvalStateOf(record.state).approvals
    const pending = approvals.filter((approval) => approval.status === 'pending')
    if (pending.length === 0) throw new ApprovalNotFoundError()

    const seen = new Set<string>()
    for (const decision of decisions) {
      if (typeof decision.approvalId !== 'string' || typeof decision.approved !== 'boolean') {
        throw new AiException('Each decision needs an approvalId and approved: boolean', 'E_AI_INVALID_ARGUMENT')
      }
      if (seen.has(decision.approvalId)) {
        throw new AiException(`Two decisions for approval ${decision.approvalId}`, 'E_AI_INVALID_ARGUMENT')
      }
      seen.add(decision.approvalId)
      if (!pending.some((approval) => approval.approvalId === decision.approvalId)) throw new ApprovalNotFoundError()
    }
    const missing = pending.filter((approval) => !seen.has(approval.approvalId)).map((approval) => approval.approvalId)
    if (missing.length > 0) throw new ApprovalIncompleteError(missing)

    const now = this.now().getTime()
    const expiredApprovalIds: string[] = []
    const decided = approvals.map((approval): StoredApproval => {
      if (approval.status !== 'pending') return approval
      if (now > Date.parse(approval.expiresAt)) {
        expiredApprovalIds.push(approval.approvalId)
        return { ...approval, status: 'decided', approved: false, decisionReason: 'expired' }
      }
      const decision = decisions.find((d) => d.approvalId === approval.approvalId) as ApprovalDecision
      return {
        ...approval,
        status: 'decided',
        approved: decision.approved,
        ...(decision.reason !== undefined ? { decisionReason: decision.reason } : {}),
      }
    })
    const { version } = await this.store.append(id, owner, {
      messages: [],
      expectedVersion: record.version,
      state: asJson({ approvals: decided }),
    })
    return this.runResumed(id, owner, version, decided, callOptions, expiredApprovalIds)
  }

  /**
   * Continues a step whose approvals were all decided earlier, for example after a failed model call. Approved tools
   * that already ran are not run again: their stored results are used.
   */
  async resume(id: string, owner: string, callOptions: ResumeCallOptions = {}): Promise<GenerateTextResult> {
    assertOwner(owner)
    const record = await this.get(id, owner)
    const approvals = approvalStateOf(record.state).approvals
    if (approvals.length === 0) throw new ApprovalNotFoundError()
    const pending = approvals.filter((approval) => approval.status === 'pending')
    if (pending.length > 0) throw new ApprovalIncompleteError(pending.map((approval) => approval.approvalId))
    return this.runResumed(id, owner, record.version, approvals, callOptions, [])
  }

  /**
   * Opens a turn for a model call. Checks the owner, reads and validates the history, and checks the turn's own
   * messages are storable. Throws before the model is called. A conversation with open approvals takes no new turn;
   * only the step that resolves them (`run`) does.
   */
  async openTurn(call: ConversationCallOptions, input: ModelMessage[], run?: ApprovalRun): Promise<ConversationTurn> {
    assertOwner(call.owner)
    const record = await this.get(call.id, call.owner)
    if (!run) {
      const open = approvalStateOf(record.state).approvals
      if (open.length > 0) throw new ApprovalIncompleteError(open.map((approval) => approval.approvalId))
    }
    // The system prompt is not part of the history: it travels as the call's `system` on every turn.
    const stored = input.filter((message) => message.role !== 'system')
    assertJsonMessages(stored)
    const history = call.prepareHistory ? call.prepareHistory(record.messages) : record.messages
    const { id, owner } = record
    const expectedVersion = record.version
    return {
      id,
      history,
      commit: async (responseMessages, extra = {}) => {
        const appended = [...(extra.input ?? stored), ...responseMessages]
        assertJsonMessages(appended)
        const { version } = await this.store.append(id, owner, {
          messages: appended,
          expectedVersion: run ? run.version : expectedVersion,
          ...(extra.state !== undefined ? { state: extra.state } : {}),
        })
        return version
      },
    }
  }

  private runResumed(
    id: string,
    owner: string,
    version: number,
    approvals: StoredApproval[],
    callOptions: ResumeCallOptions,
    expiredApprovalIds: string[]
  ): Promise<GenerateTextResult> {
    if (!this.runner) {
      throw new AiException(
        'Resolving approvals needs the manager: use ai.conversations, which AiManager creates',
        'E_AI_CONFIG_ERROR'
      )
    }
    const run = new ApprovalRun(this.store, id, owner, version, { approvals })
    return this.runner.generate(
      { ...callOptions, approvals: 'resumable', conversation: { id, owner } },
      { run, expiredApprovalIds }
    )
  }
}
