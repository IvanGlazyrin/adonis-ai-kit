import type {
  ActionGuard,
  ConfirmationResponse,
  Logger,
  ToolDefinition,
  ToolPermission,
} from './types.js'
import type { ConfirmationService } from './confirmation.js'
import { PolicyViolationError } from './errors.js'

export interface ToolAccessOptions {
  guard?: ActionGuard
  confirmation?: ConfirmationService
  sessionId?: string
  timeoutMs?: number
  /** Agent whose permission matrix applies in `getToolsByList()`. */
  agentName?: string
  /**
   * Per-call permission map. When given, it is the only source of permissions for this call:
   * tools missing from it get the registry's `defaultPermission`. The agent matrix is neither
   * read nor modified, so nothing leaks into later calls.
   */
  permissions?: Record<string, ToolPermission>
}

export interface WrapToolOptions extends ToolAccessOptions {
  /**
   * Effective permission of the tool. `ask` requires a `confirmation` service (otherwise every
   * call is refused with `PolicyViolationError`); `deny` refuses every call.
   * Defaults to `allow` because `wrapTool()` is a low-level primitive; the registry's
   * `getToolsForAgent()` / `getToolsByList()` always pass the resolved permission.
   */
  permission?: ToolPermission
}

export interface ToolRegistryOptions {
  logger?: Logger
  askByDefault?: string[]
  /**
   * Permission of tools that have neither an agent-specific nor a tool-level permission.
   * Default: `deny` (fail-closed).
   */
  defaultPermission?: ToolPermission
}

/** A tool description may be a function (AI SDK v7); fall back to the tool name then. */
function describeTool(tool: ToolDefinition, fallback: string): string {
  return typeof tool.description === 'string' && tool.description.length > 0
    ? tool.description
    : fallback
}

/**
 * Registry for managing AI agent tools, access permissions, policy guards,
 * and Human-in-the-loop confirmation hooks.
 *
 * Fail-closed: unknown permissions resolve to `deny`, `ask` without a confirmation service
 * never executes, and every tool that is handed out goes through the policy guard.
 */
export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map()
  private agentPermissions: Map<string, Map<string, ToolPermission>> = new Map()
  private defaultPermissions: Map<string, ToolPermission> = new Map()
  private askByDefault: Set<string>
  private defaultPermission: ToolPermission
  private logger?: Logger

  constructor(opts: ToolRegistryOptions = {}) {
    this.logger = opts.logger
    this.askByDefault = new Set(opts.askByDefault ?? [])
    this.defaultPermission = opts.defaultPermission ?? 'deny'
  }

  setLogger(logger: Logger): void {
    this.logger = logger
  }

  registerTool(name: string, tool: ToolDefinition, defaultPermission?: ToolPermission): this {
    this.tools.set(name, tool)
    if (defaultPermission) {
      this.defaultPermissions.set(name, defaultPermission)
    }
    return this
  }

  registerTools(
    tools: Record<string, ToolDefinition>,
    defaultPermission?: ToolPermission
  ): this {
    for (const [name, tool] of Object.entries(tools)) {
      this.registerTool(name, tool, defaultPermission)
    }
    return this
  }

  setAgentPermissions(agentName: string, permissions: Record<string, ToolPermission>): this {
    const map = this.agentPermissions.get(agentName) ?? new Map<string, ToolPermission>()
    for (const [tool, perm] of Object.entries(permissions)) {
      map.set(tool, perm)
    }
    this.agentPermissions.set(agentName, map)
    return this
  }

  getAgentPermission(agentName: string, toolName: string): ToolPermission {
    const agentMap = this.agentPermissions.get(agentName)
    if (agentMap?.has(toolName)) {
      return agentMap.get(toolName)!
    }
    if (this.defaultPermissions.has(toolName)) {
      return this.defaultPermissions.get(toolName)!
    }
    if (this.askByDefault.has(toolName)) {
      return 'ask'
    }
    return this.defaultPermission
  }

  /**
   * Wraps a tool with policy guard validation and, for `ask`, Human-in-the-loop confirmation.
   * Tools without an `execute` function (provider-executed / client-side tools) are returned as is.
   */
  wrapTool(name: string, tool: ToolDefinition, options: WrapToolOptions = {}): ToolDefinition {
    const originalExecute = tool.execute?.bind(tool)
    if (!originalExecute) {
      return tool
    }

    const permission = options.permission ?? 'allow'

    return {
      ...tool,
      execute: async (args: unknown, execOptions?: any) => {
        // 0. Defense in depth: a denied tool never runs, even if it slipped past filtering.
        if (permission === 'deny') {
          throw new PolicyViolationError(name, 'permission is "deny"')
        }

        // 1. Guard check (also reserves a call slot in guards that support it)
        const refusal = this.guardRefusal(name, args, options.guard)
        if (refusal) return refusal

        // 2-3. Confirmation for `ask`, then the tool itself, while holding the call slot.
        return this.runHoldingSlot(name, options.guard, async (markExecuted) => {
          if (permission === 'ask') {
            const declined = await this.confirmOrDecline(name, tool, args, options, execOptions)
            if (declined) return declined
          }
          markExecuted()
          return originalExecute(args, execOptions)
        })
      },
    }
  }

  /** The guard's refusal as a tool result, or `null` when the guard allows the call. */
  private guardRefusal(
    name: string,
    args: unknown,
    guard: ToolAccessOptions['guard'] | undefined
  ): { error: string } | null {
    const violation = guard?.check(name, args)
    if (!violation) return null
    this.logger?.warn?.(`[ToolRegistry] Tool "${name}" call rejected by guard: ${violation}`, args)
    return {
      error: `Rejected by policy guard: ${violation}. Adjust parameters to match approved bounds.`,
    }
  }

  /**
   * Human-in-the-loop check for `ask`. Fail-closed: `ask` without a service never runs.
   * Returns `null` when approved, or the not-executed result otherwise.
   */
  private async confirmOrDecline(
    name: string,
    tool: ToolDefinition,
    args: unknown,
    options: WrapToolOptions,
    execOptions: any
  ): Promise<{ error: string } | null> {
    if (!options.confirmation) {
      throw new PolicyViolationError(name, 'permission is "ask" but no ConfirmationService was provided')
    }

    this.logger?.info?.(`[ToolRegistry] Requesting confirmation for "${name}"`)
    const confirmation = await options.confirmation.waitForResponse(
      {
        sessionId: options.sessionId,
        toolName: name,
        action: describeTool(tool, name),
        params: (args as Record<string, unknown>) ?? {},
      },
      options.timeoutMs,
      execOptions?.abortSignal
    )
    if (confirmation.status === 'approved') return null
    return this.declinedResult(name, confirmation)
  }

  /** The not-executed result for a declined or expired confirmation, logged with its reason. */
  private declinedResult(name: string, confirmation: ConfirmationResponse): { error: string } {
    this.logger?.warn?.(
      `[ToolRegistry] Tool "${name}" execution not approved: ${confirmation.status} (${confirmation.reason ?? 'no reason'})`
    )
    return {
      error: `Tool "${name}" was not executed: ${confirmation.status}. ${confirmation.reason ?? ''}`.trim(),
    }
  }

  /**
   * Runs `body` holding the guard's call slot. The slot ends in exactly one `record()` (the tool
   * ran, with its result or its error) or one `release()` (it did not run).
   */
  private async runHoldingSlot(
    name: string,
    guard: ToolAccessOptions['guard'] | undefined,
    body: (markExecuted: () => void) => Promise<unknown>
  ): Promise<unknown> {
    let executed = false
    let slotSettled = false
    const settleSlot = (result: unknown): void => {
      if (slotSettled) return
      slotSettled = true
      guard?.record?.(name, result)
    }

    try {
      const result = await body(() => {
        executed = true
      })
      if (executed) settleSlot(result)
      return result
    } catch (err) {
      if (executed) {
        settleSlot({ error: err instanceof Error ? err.message : String(err) })
      }
      throw err
    } finally {
      if (!slotSettled && guard) {
        slotSettled = true
        guard.release?.(name)
      }
    }
  }

  /**
   * Returns the tools an agent may use. `deny` tools are omitted, `ask` tools require
   * confirmation, and every returned tool is checked by `options.guard` when one is provided.
   */
  getToolsForAgent(
    agentName: string,
    options: ToolAccessOptions = {}
  ): Record<string, ToolDefinition> {
    const result: Record<string, ToolDefinition> = {}

    for (const [name, tool] of this.tools.entries()) {
      const wrapped = this.resolveTool(agentName, name, tool, options)
      if (wrapped) result[name] = wrapped
    }

    return result
  }

  /**
   * Returns the requested tools, subject to the permission matrix of `options.agentName`
   * (or the tool-level / registry defaults when no agent is given).
   */
  getToolsByList(
    toolNames: string[],
    options: ToolAccessOptions = {}
  ): Record<string, ToolDefinition> {
    const result: Record<string, ToolDefinition> = {}

    for (const name of toolNames) {
      const tool = this.tools.get(name)
      if (!tool) {
        this.logger?.warn?.(`[ToolRegistry] Unknown tool requested: "${name}"`)
        continue
      }

      const wrapped = this.resolveTool(options.agentName ?? '', name, tool, options)
      if (wrapped) result[name] = wrapped
    }

    return result
  }

  /** The per-call map decides when given (the registry default for names it omits); otherwise the agent matrix. */
  private permissionFor(agentName: string, name: string, options: ToolAccessOptions): ToolPermission {
    if (!options.permissions) return this.getAgentPermission(agentName, name)
    return Object.hasOwn(options.permissions, name) ? options.permissions[name] : this.defaultPermission
  }

  private resolveTool(
    agentName: string,
    name: string,
    tool: ToolDefinition,
    options: ToolAccessOptions
  ): ToolDefinition | null {
    const permission = this.permissionFor(agentName, name, options)
    if (permission === 'deny') {
      return null
    }

    if (permission === 'ask' && !options.confirmation) {
      this.logger?.warn?.(
        `[ToolRegistry] Tool "${name}" requires confirmation but no ConfirmationService was provided; calls will be refused.`
      )
    }

    if (permission === 'allow' && !options.guard) {
      return tool
    }

    return this.wrapTool(name, tool, { ...options, permission })
  }
}
