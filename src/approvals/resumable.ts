import type { ModelMessage, ToolSet } from 'ai'
import type { ConversationStore, JsonValue } from '../conversations/types.js'
import type { ToolPermission } from '../guard/types.js'
import type { ApprovalState, PendingApproval, StoredApproval } from './types.js'

/** What a call sees for an approval whose tool may have started and whose result was never stored. */
export const LOST_OUTCOME = 'outcome unknown after restart'

type ToolOutput = NonNullable<StoredApproval['output']>

/**
 * The AI SDK approval status of each offered tool: `ask` waits for a person (`user-approval`), `allow` needs none
 * (`not-applicable`). A tool denied by its permission is not offered, so it has no status.
 */
export function toolApprovalFor(
  tools: ToolSet | undefined,
  permissions: Record<string, ToolPermission> | undefined
): Record<string, 'user-approval' | 'not-applicable'> {
  const statuses: Record<string, 'user-approval' | 'not-applicable'> = {}
  for (const name of Object.keys(tools ?? {})) {
    const permission = permissions && Object.hasOwn(permissions, name) ? permissions[name] : 'allow'
    if (permission === 'deny') continue
    statuses[name] = permission === 'ask' ? 'user-approval' : 'not-applicable'
  }
  return statuses
}

/** The approval part of a conversation `state`; empty when there is none. */
export function approvalStateOf(state: JsonValue | null): ApprovalState {
  const approvals = state !== null && typeof state === 'object' && !Array.isArray(state) ? state.approvals : undefined
  return { approvals: Array.isArray(approvals) ? (approvals as unknown as StoredApproval[]) : [] }
}

/** A JSON copy of a value, for storing it in `state`. */
export function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue
}

/** The tool calls of a message list, by call id. */
function toolCallsOf(messages: ModelMessage[]): Map<string, { toolName: string; input: unknown }> {
  const calls = new Map<string, { toolName: string; input: unknown }>()
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type === 'tool-call') calls.set(part.toolCallId, { toolName: part.toolName, input: part.input })
    }
  }
  return calls
}

/** The approvals a model answer asks for: one pending entry per `tool-approval-request` part. */
export function approvalsFromMessages(messages: ModelMessage[], expiresAt: string): StoredApproval[] {
  const calls = toolCallsOf(messages)
  const approvals: StoredApproval[] = []
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type !== 'tool-approval-request') continue
      approvals.push({
        approvalId: part.approvalId,
        toolCallId: part.toolCallId,
        toolName: calls.get(part.toolCallId)?.toolName ?? '',
        expiresAt,
        status: 'pending',
      })
    }
  }
  return approvals
}

/** The open approvals as callers see them: the tool input comes from the stored call. */
export function pendingViews(messages: ModelMessage[], approvals: StoredApproval[]): PendingApproval[] {
  const calls = toolCallsOf(messages)
  return approvals.map((approval) => ({
    approvalId: approval.approvalId,
    toolCallId: approval.toolCallId,
    toolName: approval.toolName,
    input: calls.get(approval.toolCallId)?.input,
    expiresAt: new Date(approval.expiresAt),
  }))
}

/** The result a stored tool message carries for an approval, or `undefined` when the SDK still has to run the tool. */
function outputFor(approval: StoredApproval): ToolOutput | undefined {
  if (approval.status === 'done' && approval.output) return approval.output
  if (approval.status === 'executing') return { type: 'error-text', value: LOST_OUTCOME }
  if (approval.status === 'decided' && approval.approved === false) {
    return approval.decisionReason === undefined
      ? { type: 'execution-denied' }
      : { type: 'execution-denied', reason: approval.decisionReason }
  }
  return undefined
}

/**
 * The tool message that answers a step: one approval response per approval, and a result for every call whose outcome
 * is known. The SDK skips a call that already has a result, so a stored result is never run again.
 */
export function toolMessageOf(approvals: StoredApproval[]): ModelMessage {
  const content: Array<Record<string, unknown>> = approvals.map((approval) => ({
    type: 'tool-approval-response',
    approvalId: approval.approvalId,
    approved: approval.approved === true,
    ...(approval.decisionReason !== undefined ? { reason: approval.decisionReason } : {}),
  }))
  for (const approval of approvals) {
    const output = outputFor(approval)
    if (output) content.push({ type: 'tool-result', toolCallId: approval.toolCallId, toolName: approval.toolName, output })
  }
  return { role: 'tool', content } as unknown as ModelMessage
}

/** The output to store for a tool's return value. */
export function outputOfResult(value: unknown): ToolOutput {
  if (typeof value === 'string') return { type: 'text', value }
  return { type: 'json', value: asJson(value) }
}

/** The output to store for a tool that threw. */
export function outputOfError(err: unknown): ToolOutput {
  return { type: 'error-text', value: err instanceof Error ? err.message : String(err) }
}

/**
 * The approval state of one resumed step, and the writes to it. Each write is a compare-and-set on the version, and
 * writes run one after another, so a tool's "executing" mark is stored before the tool runs.
 */
export class ApprovalRun {
  #version: number
  #queue: Promise<void> = Promise.resolve()
  readonly #state: ApprovalState
  readonly #store: ConversationStore
  readonly #conversationId: string
  readonly #owner: string

  constructor(store: ConversationStore, conversationId: string, owner: string, version: number, state: ApprovalState) {
    this.#store = store
    this.#conversationId = conversationId
    this.#owner = owner
    this.#version = version
    this.#state = state
  }

  /** The version after the last write of this run. */
  get version(): number {
    return this.#version
  }

  get approvals(): StoredApproval[] {
    return this.#state.approvals
  }

  /** Denies an approval that was approved but cannot run (for example because its tool was removed). */
  deny(approvalId: string, reason: string): Promise<void> {
    return this.#update(() => {
      const approval = this.#state.approvals.find(
        (a) => a.approvalId === approvalId && a.status === 'decided' && a.approved === true
      )
      if (!approval) return false
      approval.approved = false
      approval.decisionReason = reason
      return true
    })
  }

  /** Marks the approved call as executing. Calls without an approval are left alone. */
  begin(toolCallId: string): Promise<void> {
    return this.#update(() => {
      const approval = this.#state.approvals.find(
        (a) => a.toolCallId === toolCallId && a.status === 'decided' && a.approved === true
      )
      if (!approval) return false
      approval.status = 'executing'
      return true
    })
  }

  /** Stores the output of an executing call. */
  finish(toolCallId: string, output: ToolOutput): Promise<void> {
    return this.#update(() => {
      const approval = this.#state.approvals.find((a) => a.toolCallId === toolCallId && a.status === 'executing')
      if (!approval) return false
      approval.status = 'done'
      approval.output = output
      return true
    })
  }

  /** Closes every approval of the step with a denial, keeping the outputs that are already stored. */
  closeAll(reason: string): Promise<void> {
    return this.#update(() => {
      let changed = false
      for (const approval of this.#state.approvals) {
        if (approval.status === 'done') continue
        approval.status = 'decided'
        approval.approved = false
        approval.decisionReason = reason
        changed = true
      }
      return changed
    })
  }

  #update(mutate: () => boolean): Promise<void> {
    const next = this.#queue.then(async () => {
      if (!mutate()) return
      const { version } = await this.#store.append(this.#conversationId, this.#owner, {
        messages: [],
        expectedVersion: this.#version,
        state: asJson(this.#state),
      })
      this.#version = version
    })
    this.#queue = next.catch(() => undefined)
    return next
  }
}
