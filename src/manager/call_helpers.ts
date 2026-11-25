import {
  extractJsonMiddleware,
  type generateText,
  stepCountIs,
  type streamText,
  wrapLanguageModel,
  InvalidToolApprovalSignatureError,
} from 'ai'
import type {
  Instructions,
  LanguageModel,
  ModelMessage,
  PrepareStepFunction,
  StepResult,
  StopCondition,
  ToolSet,
} from 'ai'
import { AgentLoader } from '../agents/loader.js'
import { ApprovalSignatureError } from '../approvals/errors.js'
import { type ApprovalRun, toolMessageOf } from '../approvals/resumable.js'
import { ApprovalSecret } from '../approvals/secret.js'
import type { ModelCatalogEntry } from '../catalog/models_dev.js'
import { ModelsDevSource } from '../catalog/source.js'
import type { ModelPricing } from '../budget/types.js'
import type { ConversationTurn } from '../conversations/conversations.js'
import { AiException } from '../errors.js'
import { extractFirstJsonValue } from '../json_recovery.js'
import type { Logger } from '../logger.js'
import { attemptSideEffectHooks } from '../models/index.js'
import { cacheControlFor, mergeProviderOptions } from '../prompt_cache.js'
import type {
  AiConfig,
  CacheTtl,
  GenerateTextOptions,
  ProviderOptions,
} from '../types.js'
import {
  type ApprovalContext,
  type AttemptState,
  type ToolGuardDeps,
  callerToolsOf,
  prepareTools,
  toolPermission,
} from './tool_preparation.js'
import { toolApprovalFor } from '../approvals/resumable.js'

export type TextCallParams = Parameters<typeof generateText<ToolSet>>[0]
export type TextCallResult = Awaited<ReturnType<typeof generateText<ToolSet>>>
export type StreamCallParams = Parameters<typeof streamText<ToolSet>>[0]

/** A call that continues a paused step: the run that holds its approvals, and the approvals that expired. */
export interface ResumeContext {
  run: ApprovalRun
  expiredApprovalIds: string[]
}

export const PRICING_WAIT_MS = 2_000
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000

/** The models.dev catalog for the manager, configured from the app's catalog settings. */
export function defaultCatalog(config: AiConfig, logger: Logger | undefined): ModelsDevSource {
  return new ModelsDevSource({
    logger,
    cachePath: config.catalog?.cachePath,
    overridePath: config.catalog?.overridePath,
    ttlMs: config.catalog?.ttlMs,
    systemProviders: config.catalog?.systemProviders,
  })
}

/** The agent prompt loader for the manager, configured from the app's agent folders. */
export function defaultAgentLoader(config: AiConfig, logger: Logger | undefined): AgentLoader {
  return new AgentLoader({
    configsDir: config.agentConfigsDir,
    skillsDir: config.agentSkillsDir,
    logger,
  })
}

/** Price table by model id and by provider-qualified id, for the models that have a catalog price. */
export function pricingMapOf(models: ModelCatalogEntry[]): Record<string, ModelPricing> {
  const pricingMap: Record<string, ModelPricing> = {}
  for (const m of models) {
    if (m.pricing) {
      pricingMap[m.id] = m.pricing
      pricingMap[`${m.providerId}/${m.id}`] = m.pricing
    }
  }
  return pricingMap
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** The system prompt, as a cache-marked system message when `promptCache.instructions` is set. */
export function systemInstructions(options: GenerateTextOptions): Instructions | undefined {
  if (!options.system) return undefined
  const ttl = options.promptCache?.instructions
  if (!ttl) return options.system
  return {
    role: 'system',
    content: options.system,
    providerOptions: { anthropic: { cacheControl: cacheControlFor(ttl) } },
  }
}

/**
 * The tools with the prompt-cache marker on the last one in name order, and that order as `toolOrder`, so the
 * cached prefix stays the same between calls. Without a `ttl` the tools pass through unchanged.
 */
export function cacheTools(
  tools: ToolSet | undefined,
  ttl: CacheTtl | undefined
): { tools: ToolSet | undefined; toolOrder: string[] | undefined } {
  if (!tools || !ttl) return { tools, toolOrder: undefined }
  const order = Object.keys(tools).sort()
  const last = order[order.length - 1]
  const lastTool = tools[last] as { providerOptions?: ProviderOptions }
  const marked = {
    ...tools,
    [last]: {
      ...lastTool,
      providerOptions: mergeProviderOptions(lastTool.providerOptions, {
        anthropic: { cacheControl: cacheControlFor(ttl) },
      }),
    },
  } as ToolSet
  return { tools: marked, toolOrder: order }
}

/** With `jsonRecovery`, the model strips the prose around its JSON in every text part. String and ACP models are left alone. */
export function withJsonRecovery(
  model: LanguageModel,
  options: { jsonRecovery?: boolean; schema?: unknown },
  acp: boolean
): LanguageModel {
  if (!options.jsonRecovery || !options.schema || acp || typeof model === 'string') return model
  return wrapLanguageModel({
    model,
    middleware: extractJsonMiddleware({ transform: extractFirstJsonValue }),
  })
}

/** The messages a call adds to the conversation: its `messages`, or its `prompt` as one user message. */
export function inputMessages(options: GenerateTextOptions): ModelMessage[] {
  if (options.messages && options.messages.length > 0) return options.messages
  if (options.prompt) return [{ role: 'user', content: options.prompt }]
  throw new AiException('Either "prompt" or non-empty "messages" is required.', 'E_AI_INVALID_ARGUMENT')
}

/** The call with the stored history placed before its own messages. The prompt is folded into the messages. */
export function withHistory<T extends GenerateTextOptions>(options: T, history: ModelMessage[], input: ModelMessage[]): T {
  return { ...options, prompt: undefined, messages: [...history, ...input] }
}

/**
 * A `prompt` is one string. The AI SDK also accepts a message list there, which would skip the check of approval parts
 * that `messages` gets, so anything but a string is refused.
 */
export function assertPromptIsString(prompt: unknown): void {
  if (prompt !== undefined && prompt !== null && typeof prompt !== 'string') {
    throw new AiException('prompt must be a string; send a message list as `messages`.', 'E_AI_INVALID_ARGUMENT')
  }
}

/**
 * Approval parts only come from the library: a `resumable` run writes them, and `resolveApprovals` answers them. A caller
 * that sends its own would replay a signed request into another conversation, so such messages are refused.
 */
export function assertNoApprovalParts(messages: ModelMessage[] | undefined): void {
  const carriesApproval = (messages ?? []).some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => {
        const type = (part as { type?: unknown }).type
        return type === 'tool-approval-request' || type === 'tool-approval-response'
      })
  )
  if (carriesApproval) {
    throw new AiException(
      'Messages may not contain tool approval parts: approvals are answered with ai.conversations.resolveApprovals (E_AI_APPROVAL_REPLAY).',
      'E_AI_APPROVAL_REPLAY'
    )
  }
}

/**
 * The caller's stop conditions, plus one that ends the run once a tool raised an ACP failure. Without a stop condition
 * the SDK runs one step, so that default is kept.
 */
export function stopConditionsOf(
  options: GenerateTextOptions,
  state: AttemptState,
  limits: Array<StopCondition<ToolSet> | undefined> = []
): StopCondition<ToolSet>[] {
  const own = options.stopWhen ?? stepCountIs(options.maxSteps ? options.maxSteps : 1)
  const extra = [state.budgetStop, ...limits].filter((c): c is StopCondition<ToolSet> => c !== undefined)
  return [...(Array.isArray(own) ? own : [own]), ...extra, () => state.acpCallFailed !== undefined]
}

/** The approval secret of a config: a plain value is wrapped, so the config copy never holds it in clear. */
export function approvalSecretOf(config: AiConfig): ApprovalSecret | undefined {
  const secret = config.approvals?.secret
  if (secret === undefined) return undefined
  return secret instanceof ApprovalSecret ? secret : new ApprovalSecret(secret)
}

/**
 * The caller's `prepareStep`, with a returned `model` dropped: fallback, the circuit breaker and cost are bound
 * to the model of the attempt, so a step cannot switch it.
 */
export function prepareStepOf(
  prepareStep: PrepareStepFunction<ToolSet> | undefined,
  logger: Logger | undefined
): PrepareStepFunction<ToolSet> | undefined {
  if (!prepareStep) return undefined
  return async (context) => {
    const result = await prepareStep(context)
    if (!result || result.model === undefined) return result
    logger?.warn?.(
      '[AiManager] prepareStep returned a model; it is ignored. Fallback, the circuit breaker and cost stay bound to the attempt model.'
    )
    const { model: _ignored, ...rest } = result
    return rest
  }
}

export function buildTextParams(
  options: GenerateTextOptions,
  model: LanguageModel,
  state: AttemptState,
  deps: ToolGuardDeps & { requestLimitStop: StopCondition<ToolSet> | undefined },
  signal?: AbortSignal,
  approval?: ApprovalContext
): TextCallParams & StreamCallParams {
  const maxOutputTokens = options.maxOutputTokens ?? options.maxTokens
  const sideEffects = attemptSideEffectHooks(
    () => {
      state.toolsExecuted = true
    },
    (step) => {
      state.stepUsages.push(step.usage)
    }
  )
  const { tools, toolOrder } = cacheTools(prepareTools(options, state, deps, approval), options.promptCache?.tools)
  const common = {
    model,
    instructions: systemInstructions(options),
    temperature: options.temperature,
    topP: options.topP,
    maxOutputTokens,
    tools,
    toolOrder,
    activeTools: options.activeTools,
    prepareStep: prepareStepOf(options.prepareStep, deps.logger),
    providerOptions: options.providerOptions,
    repairToolCall: options.repairToolCall,
    telemetry: options.telemetry,
    stopWhen: stopConditionsOf(options, state, [deps.requestLimitStop]),
    maxRetries: options.maxRetries,
    onToolExecutionStart: sideEffects.onToolExecutionStart,
    onStepEnd: async (step: StepResult<ToolSet>) => {
      sideEffects.onStepEnd(step)
      state.onStep?.(step)
      if (!options.onStepFinish) return
      try {
        await options.onStepFinish(step)
      } catch (err) {
        deps.logger?.warn?.(`[AiManager] onStepFinish callback failed: ${String(err)}`)
      }
    },
    abortSignal: signal,
    // Only `resumable` calls ask the SDK for approvals; in `blocking` mode the SDK sees no approval settings.
    ...(approval
      ? {
          toolApproval: tools ? toolApprovalFor(callerToolsOf(options.tools, tools), options.toolPermissions) : undefined,
          experimental_toolApprovalSecret: approval.secret.reveal(),
        }
      : {}),
  }

  if (options.messages && options.messages.length > 0) {
    return { ...common, messages: options.messages } as TextCallParams & StreamCallParams
  }
  if (options.prompt) {
    return { ...common, prompt: options.prompt } as TextCallParams & StreamCallParams
  }
  throw new AiException('Either "prompt" or non-empty "messages" is required.', 'E_AI_INVALID_ARGUMENT')
}

/** An approved call whose tool is no longer offered cannot run: its approval is denied, so the model sees why. */
export async function settleUnavailableApprovals(run: ApprovalRun, options: GenerateTextOptions): Promise<void> {
  const offered = Object.entries(options.tools ?? {})
    .filter(([name, tool]) => toolPermission(options.toolPermissions, name, tool) !== 'deny')
    .map(([name]) => name)
  for (const approval of run.approvals) {
    if (approval.status === 'decided' && approval.approved === true && !offered.includes(approval.toolName)) {
      await run.deny(approval.approvalId, 'tool unavailable')
    }
  }
}

/**
 * After an approval failed its signature check: every approval of the step is closed with a denial, and the closed
 * step is stored, so the conversation is not left waiting. No tool ran.
 */
export async function closeApprovalStep(turn: ConversationTurn, run: ApprovalRun): Promise<void> {
  await run.closeAll('invalid signature')
  await turn.commit([], { input: [toolMessageOf(run.approvals)], state: null })
}

/** Maps the SDK's signature error to ApprovalSignatureError, so it is fatal and never falls back to another model. */
export function approvalFailure(err: unknown, logger: Logger | undefined): unknown {
  if (!InvalidToolApprovalSignatureError.isInstance(err)) return err
  logger?.warn?.(
    '[AiManager] A tool approval has an invalid signature. The tool did not run; the step was closed with a denial.'
  )
  return new ApprovalSignatureError()
}
