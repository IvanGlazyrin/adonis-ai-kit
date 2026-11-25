import type { LanguageModelUsage, ModelMessage, StepResult, StopCondition, ToolSet } from 'ai'
import { type ApprovalRun, outputOfError, outputOfResult } from '../approvals/resumable.js'
import type { ApprovalSecret } from '../approvals/secret.js'
import { AcpCallFailedError } from '../errors.js'
import type { ConfirmationService } from '../guard/confirmation.js'
import type { ToolRegistry } from '../guard/registry.js'
import { permissionMarkOf, type ToolDefinition, type ToolPermission } from '../guard/types.js'
import type { Logger } from '../logger.js'
import { isMcpTool } from '../mcp/types.js'
import { isAsyncIterable, resultOf } from '../tool_stream.js'
import type { GenerateTextOptions } from '../types.js'

/** Per-attempt facts the fallback loop reads: whether tools (or an ACP call) already ran, and the usage of finished steps. */
export interface AttemptState {
  toolsExecuted: boolean
  /** Usage of every step this attempt finished, so a failed attempt's tokens can still be recorded. */
  stepUsages: LanguageModelUsage[]
  /**
   * The first ACP failure a tool of this run raised (a sub-agent running an ACP agent, for example). It stops the run
   * after the step, so the model cannot start the same agent again, and the call then fails with it.
   */
  acpCallFailed?: AcpCallFailedError
  /** Told about every step this attempt finishes, after its usage is recorded. Set when the call has events. */
  onStep?: (step: StepResult<ToolSet>) => void
  /** Ends the tool loop when the call's budget runs out. Set when the call has a `budget`. */
  budgetStop?: StopCondition<ToolSet>
}

/** Approval context of one call: the secret that signs requests, and for a resumed step the run that records it. */
export interface ApprovalContext {
  secret: ApprovalSecret
  run?: ApprovalRun
}

export interface ToolGuardDeps {
  toolRegistry: ToolRegistry
  confirmation: ConfirmationService
  logger?: Logger
}

export function hasOwnPermission(permissions: Record<string, ToolPermission> | undefined, name: string): boolean {
  return permissions !== undefined && Object.hasOwn(permissions, name)
}

/**
 * The permission of a tool in a call. An explicit entry wins, then the permission the registry put on the tool. Without
 * either, a tool from an MCP server is 'deny' (fail-closed, even when it is passed here directly), and any other
 * tool is 'allow'.
 */
export function toolPermission(
  permissions: Record<string, ToolPermission> | undefined,
  name: string,
  tool?: unknown
): ToolPermission {
  if (hasOwnPermission(permissions, name)) return permissions![name]
  return permissionMarkOf(tool) ?? (isMcpTool(tool) ? 'deny' : 'allow')
}

/** Whether a tool that runs locally declares the AI SDK's own `needsApproval` (`true` or a function). */
export function hasNativeApproval(tool: ToolDefinition): boolean {
  return (
    typeof tool.execute === 'function' &&
    tool.needsApproval !== undefined &&
    tool.needsApproval !== null &&
    tool.needsApproval !== false
  )
}

/**
 * The caller's own tools that survived `prepareTools`. The approval map is built from these, not from the wrapped
 * tools, so a wrapper that builds a fresh object cannot lose a tool's permission mark.
 */
export function callerToolsOf(callerTools: ToolSet | undefined, offered: ToolSet): ToolSet {
  const own: ToolSet = {}
  for (const name of Object.keys(offered)) own[name] = callerTools?.[name] ?? offered[name]
  return own
}

/** The chunks of a streaming tool, passed on as they come. An error from the stream is recorded, then thrown on. */
async function* recordedStream(stream: AsyncIterable<unknown>, record: (err: unknown) => void): AsyncGenerator<unknown> {
  try {
    for await (const chunk of stream) yield chunk
  } catch (err) {
    record(err)
    throw err
  }
}

/**
 * Applies tool permissions and the tool guard, and tracks whether any tool actually ran.
 * `deny` tools are dropped, `ask` tools need a human confirmation (fail-closed without one), so do tools with the
 * SDK's own `needsApproval` in `blocking` mode, and every tool passes through `toolGuard.guard` when provided.
 */
export function prepareTools(
  options: GenerateTextOptions,
  state: AttemptState,
  deps: ToolGuardDeps,
  approval?: ApprovalContext
): ToolSet | undefined {
  const tools = options.tools
  if (!tools || Object.keys(tools).length === 0) return undefined

  const prepared: Record<string, ToolDefinition> = {}
  for (const [name, tool] of Object.entries(tools)) {
    const permission = toolPermission(options.toolPermissions, name, tool)
    if (permission === 'deny') {
      if (isMcpTool(tool) && !hasOwnPermission(options.toolPermissions, name)) {
        deps.logger?.warn?.(
          `[AiManager] MCP tool "${name}" is not offered: give it a permission in toolPermissions (the same one the ToolRegistry gives).`
        )
      }
      continue
    }

    let candidate = trackExecution(tool as unknown as ToolDefinition, state)
    if (approval) {
      // `resumable`: an `ask` tool is not confirmed in memory; the run pauses at its approval request instead.
      if (options.toolGuard?.guard) candidate = guardTool(name, candidate, 'allow', options.toolGuard, deps)
      if (approval.run) candidate = approvalExecution(candidate, approval.run)
    } else if (hasNativeApproval(candidate)) {
      candidate = nativeApprovalTool(name, candidate, permission, options.toolGuard, deps)
    } else if (permission === 'ask' || options.toolGuard?.guard) {
      candidate = guardTool(name, candidate, permission, options.toolGuard, deps)
    }
    prepared[name] = candidate
  }

  return Object.keys(prepared).length > 0 ? (prepared as unknown as ToolSet) : undefined
}

/**
 * Marks the attempt as having run tools, so the chain never falls back after a side effect. An ACP failure that a
 * tool throws is recorded too: the SDK turns a tool's error into a tool result, so the run would go on without it.
 */
export function trackExecution(tool: ToolDefinition, state: AttemptState): ToolDefinition {
  const original = tool.execute?.bind(tool)
  if (!original) return tool
  const record = (err: unknown) => {
    if (err instanceof AcpCallFailedError) state.acpCallFailed ??= err
  }
  return {
    ...tool,
    execute: (args: unknown, execOptions?: unknown) => {
      state.toolsExecuted = true
      let result: unknown
      try {
        result = original(args, execOptions)
      } catch (err) {
        record(err)
        throw err
      }
      // The SDK checks for an async generator on the value `execute` returns, so it is passed on as it is.
      if (isAsyncIterable(result)) return recordedStream(result, record)
      return Promise.resolve(result).catch((err: unknown) => {
        record(err)
        throw err
      })
    },
  }
}

/**
 * Records a resumed call's tool: "executing" before the tool runs, and its output after. The writes are awaited, so
 * a stop between them leaves a state that `resume` reads as "outcome unknown", never as "not started".
 */
export function approvalExecution(tool: ToolDefinition, run: ApprovalRun): ToolDefinition {
  const original = tool.execute?.bind(tool)
  if (!original) return tool
  return {
    ...tool,
    execute: async (args: unknown, execOptions?: unknown) => {
      const toolCallId = (execOptions as { toolCallId?: string } | undefined)?.toolCallId
      if (toolCallId === undefined) return resultOf(original(args, execOptions))
      await run.begin(toolCallId)
      try {
        const output = await resultOf(original(args, execOptions))
        await run.finish(toolCallId, outputOfResult(output))
        return output
      } catch (err) {
        await run.finish(toolCallId, outputOfError(err))
        throw err
      }
    },
  }
}

/**
 * A tool with the AI SDK's own `needsApproval`, in `blocking` mode. The SDK would stop at its approval request and
 * nothing in this mode answers one, so the flag is removed and the call is confirmed like an `ask` tool. A
 * `needsApproval` function still decides per call.
 */
export function nativeApprovalTool(
  name: string,
  tool: ToolDefinition,
  permission: ToolPermission,
  guardOptions: GenerateTextOptions['toolGuard'],
  deps: ToolGuardDeps
): ToolDefinition {
  const { needsApproval, ...rest } = tool
  const asked = guardTool(name, rest, 'ask', guardOptions, deps)
  if (typeof needsApproval !== 'function') return asked
  const plain = permission === 'ask' || guardOptions?.guard ? guardTool(name, rest, permission, guardOptions, deps) : rest
  return {
    ...asked,
    execute: async (args: unknown, execOptions?: { toolCallId?: string; messages?: ModelMessage[]; context?: unknown }) => {
      const needed = await needsApproval(args, {
        toolCallId: execOptions?.toolCallId,
        messages: execOptions?.messages ?? [],
        context: execOptions?.context,
      })
      return (needed ? asked : plain).execute!(args, execOptions)
    },
  }
}

/** Wraps a tool with the guard and, for `ask`, the confirmation service. */
export function guardTool(
  name: string,
  tool: ToolDefinition,
  permission: ToolPermission,
  guardOptions: GenerateTextOptions['toolGuard'],
  deps: ToolGuardDeps
): ToolDefinition {
  return deps.toolRegistry.wrapTool(name, tool, {
    permission,
    guard: guardOptions?.guard,
    confirmation: guardOptions?.confirmation ?? deps.confirmation,
    sessionId: guardOptions?.sessionId,
    timeoutMs: guardOptions?.timeoutMs,
  })
}
