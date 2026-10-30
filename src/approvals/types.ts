import type { JsonValue } from '../conversations/types.js'

/**
 * `blocking` (default): an `ask` tool waits in memory for `ConfirmationService`. `resumable`: the run stops at the
 * `ask` tool, its state is stored in the conversation, and `resolveApprovals()` continues it, possibly in another process.
 */
export type ApprovalMode = 'blocking' | 'resumable'

/** A tool call waiting for a human decision, as the caller sees it. */
export interface PendingApproval {
  approvalId: string
  toolCallId: string
  toolName: string
  /** The input the model asked the tool to run with (from the stored message). */
  input: unknown
  reason?: string
  /** After this time a decision counts as a denial (`reason: 'expired'`). */
  expiresAt: Date
}

/** A decision for one pending approval. Every approval of a paused step needs one, in the same call. */
export interface ApprovalDecision {
  approvalId: string
  approved: boolean
  reason?: string
}

/**
 * One approval in the conversation `state`. The tool input is not copied here: it stays in the stored message and is
 * found by `toolCallId`.
 */
export interface StoredApproval {
  approvalId: string
  toolCallId: string
  toolName: string
  reason?: string
  /** ISO time after which a decision counts as a denial. */
  expiresAt: string
  /**
   * `pending`: waiting for a decision. `decided`: approved or denied, not run yet. `executing`: an approved tool
   * started (if the process stops here, the outcome is unknown). `done`: the tool finished, its output is in `output`.
   */
  status: 'pending' | 'decided' | 'executing' | 'done'
  approved?: boolean
  decisionReason?: string
  /** The tool output in the AI SDK `ToolResultOutput` shape, once known. */
  output?: { type: string; value?: JsonValue; reason?: string }
}

/** The approval part of a conversation `state`. */
export interface ApprovalState {
  approvals: StoredApproval[]
}
