import { randomUUID } from 'node:crypto'
import { SubAgentApprovalError } from '../errors.js'
import { currentSubAgent } from '../run_context.js'
import type { ConfirmationResponse, Logger, PendingAction } from './types.js'

export type ConfirmationCallback = (response: ConfirmationResponse) => void
export type ActionCreatedListener = (action: PendingAction) => void
export type ActionResolvedListener = (
  action: PendingAction,
  response: ConfirmationResponse
) => void

export interface ConfirmationServiceOptions {
  defaultTimeoutMs?: number
  logger?: Logger
}

/** Largest delay `setTimeout` accepts; larger values fire after ~1ms with a TimeoutOverflowWarning. */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1

const DEFAULT_TIMEOUT_MS = 60_000

function normalizeTimeout(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return Math.min(fallback, MAX_TIMEOUT_MS)
  }
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS)
}

type PendingEntry = PendingAction & {
  callback: ConfirmationCallback
  timer: ReturnType<typeof setTimeout>
}

/**
 * Manages human-in-the-loop confirmations for sensitive or irreversible actions.
 *
 * Actions are kept in memory with a configurable TTL.
 * External interfaces (web UI, telegram bots, webhooks) approve or reject them.
 * If no response arrives within the timeout window, the action automatically times out.
 *
 * Timers are `unref()`'d so a pending confirmation never keeps the process alive; call
 * `dispose()` on shutdown to settle everything that is still pending.
 */
export class ConfirmationService {
  private pending = new Map<string, PendingEntry>()
  private defaultTimeoutMs: number
  private logger?: Logger
  private createdListeners: Set<ActionCreatedListener> = new Set()
  private resolvedListeners: Set<ActionResolvedListener> = new Set()
  private disposed = false

  constructor(opts: ConfirmationServiceOptions = {}) {
    this.defaultTimeoutMs = normalizeTimeout(opts.defaultTimeoutMs, DEFAULT_TIMEOUT_MS)
    this.logger = opts.logger
  }

  setLogger(logger: Logger): void {
    this.logger = logger
  }

  onActionCreated(listener: ActionCreatedListener): () => void {
    this.createdListeners.add(listener)
    return () => this.createdListeners.delete(listener)
  }

  onActionResolved(listener: ActionResolvedListener): () => void {
    this.resolvedListeners.add(listener)
    return () => this.resolvedListeners.delete(listener)
  }

  /**
   * Create a pending action and wait for human confirmation, timeout, or abort.
   * Never approves implicitly: timeout, abort and disposal all resolve as non-approved.
   */
  async waitForResponse(
    action: Omit<PendingAction, 'id' | 'status' | 'createdAt' | 'expiresAt'>,
    timeoutMs: number = this.defaultTimeoutMs,
    abortSignal?: AbortSignal
  ): Promise<ConfirmationResponse> {
    const subAgent = currentSubAgent()
    if (subAgent) {
      // A sub-agent cannot wait for a human: no pending action is created, and its run stops with this error.
      const error = new SubAgentApprovalError(subAgent.agent, action.toolName)
      subAgent.approvalError ??= error
      subAgent.abort.abort(error)
      throw error
    }
    if (this.disposed) {
      return { status: 'rejected', reason: 'Confirmation service disposed' }
    }
    if (abortSignal?.aborted) {
      return { status: 'rejected', reason: 'Aborted' }
    }

    const id = randomUUID()
    const effectiveTimeout = normalizeTimeout(timeoutMs, this.defaultTimeoutMs)
    const now = Date.now()
    const expiresAt = now + effectiveTimeout

    return new Promise<ConfirmationResponse>((resolve) => {
      let settled = false

      const settle = (response: ConfirmationResponse): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        abortSignal?.removeEventListener('abort', onAbort)

        const item = this.pending.get(id)
        this.pending.delete(id)
        if (item) {
          const { callback: _cb, timer: _t, ...rest } = item
          this.notifyResolved(
            { ...rest, status: response.status, reason: response.reason },
            response
          )
        }
        resolve(response)
      }

      const onAbort = (): void => settle({ status: 'rejected', reason: 'Aborted' })

      const timer = setTimeout(() => {
        this.logger?.warn?.(
          `[ConfirmationService] Action ${id} timed out after ${effectiveTimeout}ms`
        )
        settle({ status: 'timeout', reason: 'Confirmation timeout' })
      }, effectiveTimeout)
      timer.unref?.()

      abortSignal?.addEventListener('abort', onAbort, { once: true })

      const fullAction: PendingAction = {
        ...action,
        id,
        createdAt: now,
        expiresAt,
        status: 'pending',
      }

      this.pending.set(id, { ...fullAction, callback: settle, timer })

      this.logger?.info?.(
        `[ConfirmationService] Action created: ${id} (${action.action} on ${action.toolName}), expires in ${effectiveTimeout}ms`
      )

      this.notifyCreated(fullAction)
    })
  }

  /**
   * Approve a pending action. If the action is bound to a session, the caller must present the
   * same `sessionId`; otherwise the approval is refused and the action stays pending.
   */
  approve(actionId: string, reason?: string, sessionId?: string): boolean {
    return this.resolveAction(actionId, { status: 'approved', reason }, sessionId)
  }

  /**
   * Reject a pending action. Same session binding rules as `approve()`.
   */
  reject(actionId: string, reason?: string, sessionId?: string): boolean {
    return this.resolveAction(actionId, { status: 'rejected', reason }, sessionId)
  }

  /**
   * List current pending actions, optionally restricted to one session.
   */
  getPendingActions(sessionId?: string): PendingAction[] {
    return Array.from(this.pending.values())
      .filter((entry) => sessionId === undefined || entry.sessionId === sessionId)
      .map(({ callback: _cb, timer: _t, ...action }) => action)
  }

  /**
   * Get a specific pending action by ID.
   */
  getPendingAction(actionId: string): PendingAction | null {
    const entry = this.pending.get(actionId)
    if (!entry) return null
    const { callback: _cb, timer: _t, ...action } = entry
    return action
  }

  /**
   * Resolves expired items as `timeout`, invoking `onActionResolved` listeners.
   */
  clearExpired(): void {
    const now = Date.now()
    for (const item of [...this.pending.values()]) {
      if (item.expiresAt <= now) {
        item.callback({ status: 'timeout', reason: 'Confirmation expired' })
      }
    }
  }

  /**
   * Settles every pending action as rejected, clears timers and listeners.
   * Further `waitForResponse()` calls resolve as rejected immediately.
   */
  dispose(): void {
    this.disposed = true
    for (const item of [...this.pending.values()]) {
      item.callback({ status: 'rejected', reason: 'Confirmation service disposed' })
    }
    this.pending.clear()
    this.createdListeners.clear()
    this.resolvedListeners.clear()
  }

  private resolveAction(
    actionId: string,
    response: ConfirmationResponse,
    sessionId?: string
  ): boolean {
    const entry = this.pending.get(actionId)
    if (!entry) return false

    if (entry.sessionId !== undefined && entry.sessionId !== sessionId) {
      this.logger?.warn?.(
        `[ConfirmationService] Refused to ${response.status === 'approved' ? 'approve' : 'reject'} action ${actionId}: session mismatch`
      )
      return false
    }

    entry.callback(response)
    return true
  }

  private notifyCreated(action: PendingAction): void {
    for (const listener of this.createdListeners) {
      try {
        listener(action)
      } catch (err) {
        this.logger?.warn?.('[ConfirmationService] Error in actionCreated listener:', err)
      }
    }
  }

  private notifyResolved(action: PendingAction, response: ConfirmationResponse): void {
    for (const listener of this.resolvedListeners) {
      try {
        listener(action, response)
      } catch (err) {
        this.logger?.warn?.('[ConfirmationService] Error in actionResolved listener:', err)
      }
    }
  }
}
