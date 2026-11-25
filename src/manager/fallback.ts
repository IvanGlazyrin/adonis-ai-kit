import { NoObjectGeneratedError, type LanguageModel } from 'ai'
import type { CallBudgetHold } from '../budget/call_budget.js'
import type { CostTracker } from '../budget/cost_tracker.js'
import type { CallEvents } from '../call_events.js'
import type { CircuitBreaker } from '../circuit_breaker.js'
import { CREDENTIAL_ERROR_CLASSES, classifyError } from '../error_classifier.js'
import { AcpCallFailedError, CascadingFallbackError, ProviderConfigError } from '../errors.js'
import { toolCallsOf } from '../events/tool_calls.js'
import type { Logger } from '../logger.js'
import {
  ACP_NPM,
  buildChainCandidates,
  runModelChain,
  type ChainCandidate,
  type LanguageModelSource,
  type ResolvedModel,
} from '../models/index.js'
import type { AiConfig, AiDriver, ModelChainCallOptions, ProviderConfig, TokenUsage } from '../types.js'
import { normalizeUsage, sumUsage } from '../usage.js'
import type { AttemptState } from './tool_preparation.js'

export interface AttemptContext {
  /** Builds the language model for this attempt (driver model in a cascade, factory model in a chain). */
  getModel: () => Promise<LanguageModel> | LanguageModel
  modelName: string
  providerName: string
  /** Circuit breaker key of this attempt. */
  breakerKey: string
  state: AttemptState
  /** Whether this attempt runs an ACP agent (its JSON and side-effect rules differ). */
  acp: boolean
}

/** A cascade attempt whose driver is loaded and whose model is resolved. */
interface PreparedAttempt {
  driver: AiDriver
  providerName: string
  modelName: string
  breakerKey: string
}

/** Reported for a failed attempt whose driver never loaded, so no model name is known yet. */
const UNRESOLVED_MODEL = 'unresolved'

export type ChainRequest = ModelChainCallOptions & {
  provider?: string
  model?: string
  agentName?: string
  abortSignal?: AbortSignal
  /** The call's events: attempts, steps and fallbacks are reported here. */
  events?: CallEvents
  /** The call's hold on its budget: every attempt's spend is added to it. */
  budgetHold?: CallBudgetHold
}

export interface FallbackDeps {
  config: AiConfig
  logger?: Logger
  circuitBreaker: CircuitBreaker
  costTracker: CostTracker
  languageModels: () => LanguageModelSource
  use: (providerName: string) => Promise<AiDriver>
  warmPricing: (providerName: string, modelName: string) => Promise<void>
  recordCost: (
    agentName: string,
    provider: string,
    model: string,
    usage: TokenUsage,
    durationMs: number,
    pricingReady: Promise<void>,
    metadata: Record<string, unknown>
  ) => Promise<number | undefined>
  agentNameOf: (options: { agentName?: string }) => string
}

/** `ResolvedModel` entries keep their order; strings become `ref` candidates. Same dedupe rules as `buildChainCandidates`. */
function toChainCandidates(models: Array<ResolvedModel | string>): ChainCandidate[] {
  if (models.every((m): m is ResolvedModel => typeof m !== 'string')) {
    return buildChainCandidates({ chain: models })
  }
  const candidates: ChainCandidate[] = []
  const seenRefs = new Set<string>()
  const seenEntries = new Set<string>()
  for (const entry of models) {
    if (typeof entry === 'string') {
      if (!entry || seenRefs.has(entry)) continue
      seenRefs.add(entry)
      candidates.push({ kind: 'ref', ref: entry, key: entry })
      continue
    }
    const [candidate] = buildChainCandidates({ chain: [entry] })
    const entryId = `${candidate.key}|${entry.providerID}/${entry.modelID}`
    if (seenEntries.has(entryId)) continue
    seenEntries.add(entryId)
    candidates.push(candidate)
  }
  return candidates
}

/**
 * Tokens a failed attempt consumed. A `NoObjectGeneratedError` carries its own usage, which already covers
 * the failing call; otherwise the usage of the steps the attempt finished is the consumed amount.
 */
function failedAttemptUsage(err: unknown, state: AttemptState): TokenUsage {
  if (NoObjectGeneratedError.isInstance(err)) return normalizeUsage(err.usage)
  return sumUsage(state.stepUsages)
}

/**
 * Executes an operation with cascading fallback across the primary and explicitly configured
 * backup providers.
 */
export async function executeWithFallback<T>(
  deps: FallbackDeps,
  request: ChainRequest,
  operation: (ctx: AttemptContext) => Promise<T>
): Promise<{ result: T; provider: string; model: string }> {
  const attemptOperation = accountFailedAttempts(deps, request, operation)
  if (request.models && request.models.length > 0) {
    return executeOverChain(deps, request, request.models, attemptOperation)
  }

  const target = resolveTarget(deps.config, request)
  const cascade = cascadeFor(deps.config, target.provider)
  const attempts: Array<{ provider: string; model: string; error: Error }> = []

  for (const [index, providerName] of cascade.entries()) {
    request.abortSignal?.throwIfAborted()

    const pConfig = deps.config.providers[providerName]
    if (!pConfig) continue

    const state: AttemptState = { toolsExecuted: false, stepUsages: [] }
    let attempt: PreparedAttempt
    try {
      attempt = await prepareAttempt(deps, providerName, pConfig, index === 0, target.model)
    } catch (err) {
      recordFailedAttempt(deps, attempts, {
        err,
        request,
        providerName,
        modelName: UNRESOLVED_MODEL,
        breakerKey: providerName,
        state,
        next: cascade[index + 1],
      })
      continue
    }

    const { modelName, breakerKey } = attempt
    if (!deps.circuitBreaker.isAvailable(breakerKey)) {
      deps.logger?.warn?.(`[AiManager] Skipping "${breakerKey}" because circuit breaker is OPEN.`)
      attempts.push({ provider: providerName, model: modelName, error: new Error('circuit breaker is open') })
      continue
    }

    try {
      const result = await attemptProvider(deps, request, attempt, state, attemptOperation)
      return { result, provider: providerName, model: modelName }
    } catch (err) {
      recordFailedAttempt(deps, attempts, {
        err,
        request,
        providerName,
        modelName,
        breakerKey,
        state,
        next: cascade[index + 1],
      })
    }
  }

  throw new CascadingFallbackError(attempts)
}

/** The primary provider (the requested one, or the default), then the fallbacks that are not the primary. */
function cascadeFor(config: AiConfig, requested: string | undefined): string[] {
  const primary = requested ?? config.default
  return [primary, ...(config.fallbackCascade ?? []).filter((p) => p !== primary)]
}

/**
 * Records a failed attempt and moves on, unless the failure may not fall back (fatal, or after tools
 * ran), which rethrows it from assertCanFallBack.
 */
function recordFailedAttempt(
  deps: FallbackDeps,
  attempts: Array<{ provider: string; model: string; error: Error }>,
  failure: {
    err: unknown
    request: ChainRequest
    providerName: string
    modelName: string
    breakerKey: string
    state: AttemptState
    /** The provider tried next, if any. */
    next?: string
  }
): void {
  const { err, request, providerName, modelName, breakerKey, state, next } = failure
  const classification = classifyError(err, request.abortSignal)
  const acp = deps.config.providers[providerName]?.driver === 'acp'
  assertCanFallBack(deps.logger, err, classification.kind, state, breakerKey, acp)

  const error = err instanceof Error ? err : new Error(String(err))
  attempts.push({ provider: providerName, model: modelName, error })
  deps.logger?.warn?.(
    `[AiManager] "${breakerKey}" failed (${classification.reason}: ${error.message}). Attempting next fallback...`
  )
  if (next !== undefined) {
    request.events?.emit({ type: 'fallback', from: breakerKey, to: next, errorClass: classification.errorClass })
  }
}

async function prepareAttempt(
  deps: FallbackDeps,
  providerName: string,
  pConfig: ProviderConfig,
  isPrimary: boolean,
  requestedModel: string | undefined
): Promise<PreparedAttempt> {
  const driver = await deps.use(providerName)
  const modelName = modelNameFor(deps.config, pConfig, providerName, isPrimary, requestedModel) ?? driver.defaultModel
  return { driver, providerName, modelName, breakerKey: `${providerName}:${modelName}` }
}

function attemptProvider<T>(
  deps: FallbackDeps,
  request: ChainRequest,
  attempt: PreparedAttempt,
  state: AttemptState,
  operation: (ctx: AttemptContext) => Promise<T>
): Promise<T> {
  const { driver, providerName, modelName, breakerKey } = attempt
  return deps.circuitBreaker.execute(
    breakerKey,
    () =>
      operation({
        getModel: () => driver.getModel(modelName),
        modelName,
        providerName,
        breakerKey,
        state,
        acp: deps.config.providers[providerName]?.driver === 'acp',
      }),
    (err) => classifyError(err, request.abortSignal).countsAsFailure
  )
}

function resolveTarget(config: AiConfig, request: ChainRequest): { provider?: string; model?: string } {
  const { provider, model } = request
  if (model && model.includes('/') && !provider) {
    const [head, ...rest] = model.split('/')
    if (Object.hasOwn(config.providers, head)) {
      return { provider: head, model: rest.join('/') }
    }
  }
  return { provider, model }
}

function modelNameFor(
  config: AiConfig,
  pConfig: ProviderConfig,
  providerName: string,
  isPrimary: boolean,
  requestedModel: string | undefined
): string | undefined {
  if (isPrimary) return requestedModel ?? pConfig.defaultModel
  const fallbackModels = config.fallbackModels
  const configured = fallbackModels && Object.hasOwn(fallbackModels, providerName) ? fallbackModels[providerName] : undefined
  return configured ?? pConfig.defaultModel
}

function assertCanFallBack(
  logger: Logger | undefined,
  err: unknown,
  kind: string,
  state: AttemptState,
  breakerKey: string,
  acp: boolean
): void {
  if (kind === 'fatal') throw err
  if (!state.toolsExecuted && !(acp && kind === 'retryable')) return
  const message = err instanceof Error ? err.message : String(err)
  const reason = acp && kind === 'retryable' ? 'after a retryable ACP agent failure' : 'after executing tools'
  logger?.error?.(
    `[AiManager] "${breakerKey}" failed ${reason} (${message}); not retrying on another provider to avoid repeating side effects.`
  )
  // The caller gets the typed error, so it can tell an ACP agent that may have changed files from a plain failure.
  if (acp && kind === 'retryable') throw new AcpCallFailedError(breakerKey, err)
  throw err
}

function accountFailedAttempts<T>(
  deps: FallbackDeps,
  request: ChainRequest,
  operation: (ctx: AttemptContext) => Promise<T>
): (ctx: AttemptContext) => Promise<T> {
  return async (ctx) => {
    const startTime = Date.now()
    const events = request.events
    if (request.budgetHold) ctx.state.budgetStop = request.budgetHold.stopCondition(deps.costTracker)
    if (events) {
      events.emit({ type: 'attempt:started', provider: ctx.providerName, model: ctx.modelName, breakerKey: ctx.breakerKey })
      let stepNumber = 0
      ctx.state.onStep = (step) =>
        events.emit({
          type: 'step:finished',
          provider: ctx.providerName,
          model: ctx.modelName,
          stepNumber: stepNumber++,
          toolCalls: toolCallsOf(step),
          usage: normalizeUsage(step.usage),
          finishReason: step.finishReason ?? 'stop',
        })
    }
    try {
      const value = await operation(ctx)
      // A tool that ran an ACP agent stopped the run; the call fails with that error, not with its partial result.
      if (ctx.state.acpCallFailed) throw ctx.state.acpCallFailed
      return value
    } catch (err) {
      const usage = failedAttemptUsage(err, ctx.state)
      if (usage.totalTokens > 0) {
        const failedCost = await deps.recordCost(
          deps.agentNameOf(request),
          ctx.providerName,
          ctx.modelName,
          usage,
          Date.now() - startTime,
          deps.warmPricing(ctx.providerName, ctx.modelName),
          { failed: true, errorClass: classifyError(err).errorClass }
        )
        request.budgetHold?.add(usage.totalTokens, failedCost ?? 0)
      }
      throw err
    }
  }
}

async function executeOverChain<T>(
  deps: FallbackDeps,
  request: ChainRequest,
  models: Array<ResolvedModel | string>,
  operation: (ctx: AttemptContext) => Promise<T>
): Promise<{ result: T; provider: string; model: string }> {
  request.abortSignal?.throwIfAborted()

  const stringEntry = models.find((m): m is string => typeof m === 'string' && m !== '')
  if (stringEntry !== undefined && !deps.config.resolver) {
    throw new ProviderConfigError('model-chain', `a resolver is required to resolve "${stringEntry}"`)
  }

  const languageModels = deps.languageModels()
  const { result, model } = await runModelChain(
    toChainCandidates(models),
    (attempt) => {
      // `state.toolsExecuted = true` inside prepareTools tells the chain not to fall back.
      const state: AttemptState = {
        get toolsExecuted() {
          return false
        },
        set toolsExecuted(value: boolean) {
          if (value) attempt.markToolsExecuted()
        },
        stepUsages: [],
      }
      return operation({
        getModel: () => languageModels.create(attempt.model),
        modelName: attempt.model.modelID,
        providerName: attempt.model.providerID,
        breakerKey: attempt.key,
        state,
        acp: attempt.model.npm === ACP_NPM,
      })
    },
    {
      breaker: deps.circuitBreaker,
      resolver: deps.config.resolver,
      abortSignal: request.abortSignal,
      onFallback: (event) => {
        request.events?.emit({ type: 'fallback', from: event.fromModel, to: event.toModel, errorClass: event.errorClass })
        return request.onFallback?.(event)
      },
      logger: deps.logger,
      alsoFallBackOn: fallsBackOnCredentialErrors(deps.config, request) ? CREDENTIAL_ERROR_CLASSES : undefined,
    }
  )
  return { result, provider: model.providerID, model: model.modelID }
}

function fallsBackOnCredentialErrors(config: AiConfig, request: ChainRequest): boolean {
  return request.fallbackOnCredentialErrors ?? config.fallbackOnCredentialErrors ?? true
}
