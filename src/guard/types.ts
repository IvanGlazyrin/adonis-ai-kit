export type { Logger } from '../logger.js'

export type ToolPermission = 'allow' | 'ask' | 'deny'

/**
 * The permission `ToolRegistry.getToolsWithApprovals()` resolved for a tool, stored on a copy of the tool.
 * `AiManager` reads it when `toolPermissions` has no entry for the tool; `AgentRunner` lets it tighten its own
 * default, never loosen it. `Symbol.for` keeps the mark across module copies, and an object spread (`{ ...tool }`)
 * keeps it too.
 */
export const TOOL_PERMISSION = Symbol.for('adonis-ai-kit.tool-permission')

/** The permission carried by a tool (its `TOOL_PERMISSION` mark), or `undefined` when it has none. */
export function permissionMarkOf(tool: unknown): ToolPermission | undefined {
  if (typeof tool !== 'object' || tool === null || !Object.hasOwn(tool, TOOL_PERMISSION)) return undefined
  const mark = (tool as Record<symbol, unknown>)[TOOL_PERMISSION]
  return mark === 'allow' || mark === 'ask' || mark === 'deny' ? mark : undefined
}

/**
 * Structural shape of an AI SDK tool (v5+: `inputSchema`; legacy v4 tools used `parameters`).
 * Extra keys (`outputSchema`, `providerOptions`, ...) are preserved when a tool is wrapped.
 */
export interface ToolDefinition<TArgs = any, TResult = any> {
  /**
   * Tool description. AI SDK v7 also allows a function that builds the description
   * from the call context, so both shapes are accepted.
   */
  description?: string | ((options: any) => string)
  inputSchema?: unknown
  /** @deprecated AI SDK v4 name of `inputSchema`. */
  parameters?: unknown
  execute?: (args: TArgs, options?: any) => Promise<TResult> | TResult
  [key: string]: unknown
}

export interface PendingAction<TParams = Record<string, unknown>> {
  id: string
  sessionId?: string
  toolName: string
  action: string
  params: TParams
  createdAt: number
  expiresAt: number
  status: 'pending' | 'approved' | 'rejected' | 'timeout'
  reason?: string
  metadata?: Record<string, unknown>
}

export interface ConfirmationResponse {
  status: 'approved' | 'rejected' | 'timeout'
  reason?: string
}

export interface ActionGuard {
  /**
   * Validates tool invocation before execution.
   * Returns a violation error message if rejected, or null if allowed.
   *
   * A guard that returns `null` may reserve capacity (e.g. a call slot). Every allowed `check()`
   * is followed by exactly one `record()` (the tool ran) or one `release()` (it did not).
   */
  check(toolName: string, args: unknown): string | null

  /**
   * Optional callback invoked after tool execution completes to record result stats.
   */
  record?(toolName: string, result: unknown): void

  /**
   * Optional callback invoked when a call that passed `check()` was NOT executed
   * (confirmation denied, timed out, aborted). Lets the guard give back reserved capacity.
   */
  release?(toolName: string): void

  /**
   * Optional summary of guard activity (e.g. accepted count, violations).
   */
  summary?(): Record<string, unknown>
}

export interface ExecutionReconciliation {
  claimed: number
  verified: number
  mismatch: boolean
}
