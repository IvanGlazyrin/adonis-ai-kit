import { generateText, streamText, stepCountIs, Output } from 'ai'
import type { LanguageModel, ModelMessage, StepResult, ToolSet } from 'ai'
import { CostTracker } from './budget/cost_tracker.js'
import type { ModelPricing } from './budget/types.js'
import { ConfirmationService } from './guard/confirmation.js'
import { ToolRegistry } from './guard/registry.js'
import type { ToolDefinition, ToolPermission } from './guard/types.js'
import { CircuitBreaker } from './circuit_breaker.js'
import {
  AiException,
  CascadingFallbackError,
  ProviderConfigError,
} from './errors.js'
import { classifyError } from './error_classifier.js'
import { EMPTY_USAGE, normalizeUsage, sumUsage } from './usage.js'
import { ModelsDevSource, resolveCatalogProviderId } from './catalog/source.js'
import { AgentLoader, type AgentPromptConfig } from './agents/loader.js'
import { AgentRunner, type AgentRunnerOptions } from './agents/agent_runner.js'
import type { AcpProviderConfig } from './acp/types.js'
import {
  LanguageModelFactory,
  buildChainCandidates,
  runModelChain,
  type ChainCandidate,
  type ResolvedModel,
} from './models/index.js'
import type {
  AiConfig,
  AiDriver,
  BaseProviderConfig,
  ChatMessage,
  GenerateObjectOptions,
  GenerateObjectResult,
  GenerateTextOptions,
  GenerateTextResult,
  ModelChainCallOptions,
  ProviderConfig,
  StreamTextOptions,
  StreamTextResult,
  TokenUsage,
} from './types.js'

import type { Logger } from './logger.js'

/** @deprecated Use Logger */
export type LoggerContract = Logger

type TextCallParams = Parameters<typeof generateText<ToolSet>>[0]
type TextCallResult = Awaited<ReturnType<typeof generateText<ToolSet>>>
type StreamCallParams = Parameters<typeof streamText<ToolSet>>[0]

/** Lets the fallback loop know whether the failed attempt already ran tools (side effects). */
interface AttemptState {
  toolsExecuted: boolean
}

interface AttemptContext {
  /** Builds the language model for this attempt (driver model in a cascade, factory model in a chain). */
  getModel: () => Promise<LanguageModel> | LanguageModel
  modelName: string
  providerName: string
  /** Circuit breaker key of this attempt. */
  breakerKey: string
  state: AttemptState
}

type ChainRequest = ModelChainCallOptions & {
  provider?: string
  model?: string
  abortSignal?: AbortSignal
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

type ModelFactory = (modelId: string) => LanguageModel
type ClientFactory = (settings: Record<string, unknown>) => ModelFactory

/** How one built-in SDK driver loads its package and builds its client. */
interface SdkDriverSpec {
  /** Name used in the missing-package error. */
  label: string
  pkg: string
  factory: string
  defaultModel: string
  settings: (config: SdkDriverConfig) => Record<string, unknown>
}

type SdkDriverConfig = Pick<BaseProviderConfig, 'baseURL' | 'headers'> & {
  apiKey?: string
  organization?: string
}

const GOOGLE_DRIVER: SdkDriverSpec = {
  label: 'Google/Gemini',
  pkg: '@ai-sdk/google',
  factory: 'createGoogleGenerativeAI',
  defaultModel: 'gemini-3.5-flash',
  settings: (c) => ({
    apiKey: c.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY,
    baseURL: c.baseURL,
    headers: c.headers,
  }),
}

/** Built-in SDK drivers, keyed by the `driver` value in provider config. */
const SDK_DRIVERS: Record<string, SdkDriverSpec> = {
  openai: {
    label: 'OpenAI',
    pkg: '@ai-sdk/openai',
    factory: 'createOpenAI',
    defaultModel: 'gpt-6-sol',
    settings: (c) => ({
      apiKey: c.apiKey ?? process.env.OPENAI_API_KEY,
      organization: c.organization ?? process.env.OPENAI_ORG_ID,
      baseURL: c.baseURL ?? process.env.OPENAI_BASE_URL,
      headers: c.headers,
    }),
  },
  anthropic: {
    label: 'Anthropic',
    pkg: '@ai-sdk/anthropic',
    factory: 'createAnthropic',
    defaultModel: 'claude-sonnet-5-5',
    settings: (c) => ({
      apiKey: c.apiKey ?? process.env.ANTHROPIC_API_KEY,
      baseURL: c.baseURL ?? process.env.ANTHROPIC_BASE_URL,
      headers: c.headers,
    }),
  },
  google: GOOGLE_DRIVER,
  gemini: GOOGLE_DRIVER,
  groq: {
    label: 'Groq',
    pkg: '@ai-sdk/groq',
    factory: 'createGroq',
    defaultModel: 'openai/gpt-oss-120b',
    settings: (c) => ({
      apiKey: c.apiKey ?? process.env.GROQ_API_KEY,
      baseURL: c.baseURL,
      headers: c.headers,
    }),
  },
  ollama: {
    label: 'Ollama',
    pkg: '@ai-sdk/openai-compatible',
    factory: 'createOpenAICompatible',
    defaultModel: 'llama3.2',
    settings: (c) => ({
      name: 'ollama',
      baseURL: c.baseURL ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',
      headers: c.headers,
    }),
  },
}


const PRICING_WAIT_MS = 2_000

/** A tool with no explicit permission is allowed. */
function toolPermission(permissions: Record<string, ToolPermission> | undefined, name: string): ToolPermission {
  return permissions && Object.hasOwn(permissions, name) ? permissions[name] : 'allow'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Central AI Manager for AdonisJS 7 (analog of Laravel AI / Prism).
 * Orchestrates multi-provider drivers, models.dev catalog discovery, ACP agents,
 * declarative skills & agent runners, cascading failover, circuit breaker resilience,
 * token budget accounting, and guarded tool execution.
 */
export class AiManager {
  private config: AiConfig
  private logger?: Logger
  private circuitBreaker: CircuitBreaker
  private costTracker: CostTracker
  private toolRegistry: ToolRegistry
  private confirmation: ConfirmationService
  private catalog: ModelsDevSource
  private agentLoader: AgentLoader
  private drivers: Map<string, Promise<AiDriver>> = new Map()
  private pricingWarmups: Map<string, Promise<void>> = new Map()
  private lazyLanguageModels?: LanguageModelFactory

  constructor(
    config: AiConfig,
    logger?: Logger,
    costTracker?: CostTracker,
    toolRegistry?: ToolRegistry,
    catalog?: ModelsDevSource,
    agentLoader?: AgentLoader,
    confirmation?: ConfirmationService
  ) {
    this.config = config
    this.logger = logger
    this.circuitBreaker = new CircuitBreaker(config.circuitBreaker)
    this.costTracker =
      costTracker ??
      new CostTracker({
        pricing: config.budget?.pricing,
        logger: this.logger,
      })
    this.toolRegistry = toolRegistry ?? new ToolRegistry({ logger: this.logger })
    this.confirmation = confirmation ?? new ConfirmationService({ logger: this.logger })
    this.catalog =
      catalog ??
      new ModelsDevSource({
        logger: this.logger,
        cachePath: config.catalog?.cachePath,
        overridePath: config.catalog?.overridePath,
        ttlMs: config.catalog?.ttlMs,
        systemProviders: config.catalog?.systemProviders,
      })
    this.agentLoader =
      agentLoader ??
      new AgentLoader({
        configsDir: config.agentConfigsDir,
        skillsDir: config.agentSkillsDir,
        logger: this.logger,
      })

    // Setup dynamic pricing loader from models.dev catalog
    if (this.config.catalog?.autoPricing !== false) {
      this.costTracker.registerPricingLoader(async () => {
        const models = await this.catalog.listModels()
        const pricingMap: Record<string, ModelPricing> = {}
        for (const m of models) {
          if (m.pricing) {
            pricingMap[m.id] = m.pricing
            pricingMap[`${m.providerId}/${m.id}`] = m.pricing
          }
        }
        return pricingMap
      })
    }
  }

  getConfig(): AiConfig {
    return this.config
  }

  getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker
  }

  getCostTracker(): CostTracker {
    return this.costTracker
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry
  }

  /**
   * Service that answers `ask` tool permissions and ACP agent permission requests.
   * Subscribe with `onActionCreated()` and call `approve()` / `reject()` from your UI.
   */
  getConfirmationService(): ConfirmationService {
    return this.confirmation
  }

  getCatalog(): ModelsDevSource {
    return this.catalog
  }

  getAgentLoader(): AgentLoader {
    return this.agentLoader
  }

  /**
   * Instantiates an executable AgentRunner by loading its markdown manifest and skills.
   */
  async agent(name: string, options?: AgentRunnerOptions): Promise<AgentRunner> {
    const promptConfig = await this.agentLoader.loadAgentPrompt(name)
    return new AgentRunner(this, promptConfig, options)
  }

  /**
   * Loads all agent prompt configurations from the configured directory.
   */
  async loadAgents(
    configsDir?: string,
    skillsDir?: string
  ): Promise<Record<string, AgentPromptConfig>> {
    return this.agentLoader.loadAllAgentPrompts(configsDir, skillsDir)
  }

  /**
   * Dynamically resolves a model reference string (e.g. 'openai/gpt-4o', 'claude-3-5-sonnet')
   * against the models.dev catalog.
   */
  async resolveModel(modelRef: string, defaultProvider?: string) {
    return this.catalog.resolveModel(modelRef, defaultProvider ?? this.config.default)
  }

  /**
   * Returns a specific driver by name, or the default driver.
   * Concurrent callers share one driver instance.
   */
  async use(name?: string): Promise<AiDriver> {
    const providerName = name ?? this.config.default
    const existing = this.drivers.get(providerName)
    if (existing) {
      return existing
    }

    const providerConfig = this.config.providers[providerName]
    if (!providerConfig) {
      throw new ProviderConfigError(providerName, `Provider "${providerName}" is not registered in config.`)
    }

    const pending = this.createDriver(providerName, providerConfig)
    this.drivers.set(providerName, pending)
    pending.catch(() => {
      if (this.drivers.get(providerName) === pending) this.drivers.delete(providerName)
    })
    return pending
  }

  /**
   * Alias for use() matching AdonisJS convention.
   */
  async driver(name?: string): Promise<AiDriver> {
    return this.use(name)
  }

  /**
   * Stops child processes (ACP agents), disposes pending confirmations and forgets drivers.
   * Call on application shutdown.
   */
  async shutdown(): Promise<void> {
    const languageModels = this.config.languageModels ?? this.lazyLanguageModels
    this.lazyLanguageModels = undefined
    const drivers = [...this.drivers.values()]
    this.drivers.clear()
    const settled = await Promise.allSettled(drivers)
    await Promise.allSettled(
      settled.map(async (entry) => {
        if (entry.status === 'fulfilled') await entry.value.shutdown?.()
      })
    )
    await Promise.allSettled([languageModels?.shutdown()])
    this.confirmation.dispose()
  }

  private get languageModels(): LanguageModelFactory {
    return (
      this.config.languageModels ??
      (this.lazyLanguageModels ??= new LanguageModelFactory({
        logger: this.logger,
        acp: { confirmation: this.confirmation },
      }))
    )
  }

  /**
   * Starts loading catalog pricing for a model in the background (deduplicated).
   */
  private warmPricing(providerName: string, modelName: string): Promise<void> {
    if (this.config.catalog?.autoPricing === false) return Promise.resolve()
    // Chain models are not configured providers: their provider id is already a catalog id.
    const pConfig = this.config.providers[providerName]
    if (pConfig?.driver === 'acp') return Promise.resolve()
    const catalogProviderId = pConfig ? resolveCatalogProviderId(pConfig.driver) : providerName

    const key = `${providerName}/${modelName}`
    let warmup = this.pricingWarmups.get(key)
    if (!warmup) {
      warmup = (async () => {
        try {
          const pricing = await this.catalog.getModelPricing(catalogProviderId, modelName)
          if (pricing) {
            this.costTracker.setPricing({ [modelName]: pricing, [key]: pricing })
          }
        } catch {
          // Non-fatal catalog pricing lookup
        }
      })()
      this.pricingWarmups.set(key, warmup)
    }
    return warmup
  }

  /**
   * Executes an operation with cascading fallback across the primary and explicitly configured
   * backup providers.
   *
   * - The requested model is used for the primary provider only; fallbacks use `fallbackModels`
   *   or their own `defaultModel`.
   * - Only transient failures (429, 5xx, network) fall through to the next provider; bad requests,
   *   validation errors and aborts are rethrown immediately, as are failures after tools ran.
   * - The circuit breaker is keyed by `provider:model`.
   */
  private async executeWithFallback<T>(
    request: ChainRequest,
    operation: (ctx: AttemptContext) => Promise<T>
  ): Promise<{ result: T; provider: string; model: string }> {
    if (request.models && request.models.length > 0) {
      return this.executeOverChain(request, request.models, operation)
    }

    const target = this.resolveTarget(request)
    const cascade = this.cascadeFor(target.provider)
    const attempts: Array<{ provider: string; model: string; error: Error }> = []

    for (const [index, providerName] of cascade.entries()) {
      request.abortSignal?.throwIfAborted()

      const pConfig = this.config.providers[providerName]
      if (!pConfig) continue

      const modelName = this.modelNameFor(pConfig, providerName, index === 0, target.model)
      const breakerKey = `${providerName}:${modelName}`

      if (!this.circuitBreaker.isAvailable(breakerKey)) {
        this.logger?.warn?.(`[AiManager] Skipping "${breakerKey}" because circuit breaker is OPEN.`)
        attempts.push({ provider: providerName, model: modelName, error: new Error('circuit breaker is open') })
        continue
      }

      const state: AttemptState = { toolsExecuted: false }
      try {
        const result = await this.attemptProvider(request, providerName, modelName, breakerKey, state, operation)
        return { result, provider: providerName, model: modelName }
      } catch (err) {
        this.recordFailedAttempt(attempts, { err, request, providerName, modelName, breakerKey, state })
      }
    }

    throw new CascadingFallbackError(attempts)
  }

  /** The primary provider (the requested one, or the default), then the fallbacks that are not the primary. */
  private cascadeFor(requested: string | undefined): string[] {
    const primary = requested ?? this.config.default
    return [primary, ...(this.config.fallbackCascade ?? []).filter((p) => p !== primary)]
  }

  /**
   * Records a failed attempt and moves on, unless the failure may not fall back (fatal, or after tools
   * ran), which rethrows it from assertCanFallBack.
   */
  private recordFailedAttempt(
    attempts: Array<{ provider: string; model: string; error: Error }>,
    failure: {
      err: unknown
      request: ChainRequest
      providerName: string
      modelName: string
      breakerKey: string
      state: AttemptState
    }
  ): void {
    const { err, request, providerName, modelName, breakerKey, state } = failure
    const classification = classifyError(err, request.abortSignal)
    this.assertCanFallBack(err, classification.kind, state, breakerKey)

    const error = err instanceof Error ? err : new Error(String(err))
    attempts.push({ provider: providerName, model: modelName, error })
    this.logger?.warn?.(
      `[AiManager] "${breakerKey}" failed (${classification.reason}: ${error.message}). Attempting next fallback...`
    )
  }

  /** One provider's attempt, run through its circuit breaker. */
  private async attemptProvider<T>(
    request: ChainRequest,
    providerName: string,
    modelName: string,
    breakerKey: string,
    state: AttemptState,
    operation: (ctx: AttemptContext) => Promise<T>
  ): Promise<T> {
    const driver = await this.use(providerName)
    return this.circuitBreaker.execute(
      breakerKey,
      () =>
        operation({
          getModel: () => driver.getModel(modelName),
          modelName,
          providerName,
          breakerKey,
          state,
        }),
      (err) => classifyError(err, request.abortSignal).countsAsFailure
    )
  }

  /** Splits a `provider/model` string, but only when the prefix really is a configured provider. */
  private resolveTarget(request: ChainRequest): { provider?: string; model?: string } {
    const { provider, model } = request
    if (model && model.includes('/') && !provider) {
      const [head, ...rest] = model.split('/')
      if (Object.hasOwn(this.config.providers, head)) {
        return { provider: head, model: rest.join('/') }
      }
    }
    return { provider, model }
  }

  /** The primary uses the requested model; a fallback uses its configured fallback model. */
  private modelNameFor(
    pConfig: ProviderConfig,
    providerName: string,
    isPrimary: boolean,
    requestedModel: string | undefined
  ): string {
    if (isPrimary) return requestedModel ?? pConfig.defaultModel ?? 'default'
    const fallbackModels = this.config.fallbackModels
    const configured = fallbackModels && Object.hasOwn(fallbackModels, providerName) ? fallbackModels[providerName] : undefined
    return configured ?? pConfig.defaultModel ?? 'default'
  }

  /**
   * Throws unless a failed attempt may move on: fatal errors end the call, and so does any attempt
   * that already ran tools, to avoid repeating side effects on another provider.
   */
  private assertCanFallBack(
    err: unknown,
    kind: string,
    state: AttemptState,
    breakerKey: string
  ): void {
    if (kind === 'fatal') throw err
    if (state.toolsExecuted) {
      const message = err instanceof Error ? err.message : String(err)
      this.logger?.error?.(
        `[AiManager] "${breakerKey}" failed after executing tools (${message}); not retrying on another provider to avoid repeating side effects.`
      )
      throw err
    }
  }

  /**
   * Executes an operation over an explicit chain of models. The provider cascade is not used; the
   * chain is authoritative and every entry has its own per-credential circuit breaker.
   */
  private async executeOverChain<T>(
    request: ChainRequest,
    models: Array<ResolvedModel | string>,
    operation: (ctx: AttemptContext) => Promise<T>
  ): Promise<{ result: T; provider: string; model: string }> {
    request.abortSignal?.throwIfAborted()

    const stringEntry = models.find((m): m is string => typeof m === 'string' && m !== '')
    if (stringEntry !== undefined && !this.config.resolver) {
      throw new ProviderConfigError('model-chain', `a resolver is required to resolve "${stringEntry}"`)
    }

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
        }
        return operation({
          getModel: () => this.languageModels.create(attempt.model),
          modelName: attempt.model.modelID,
          providerName: attempt.model.providerID,
          breakerKey: attempt.key,
          state,
        })
      },
      {
        breaker: this.circuitBreaker,
        resolver: this.config.resolver,
        abortSignal: request.abortSignal,
        onFallback: request.onFallback,
        logger: this.logger,
      }
    )
    return { result, provider: model.providerID, model: model.modelID }
  }

  /**
   * Applies tool permissions and the tool guard, and tracks whether any tool actually ran.
   * `deny` tools are dropped, `ask` tools need a human confirmation (fail-closed without one),
   * and every tool passes through `toolGuard.guard` when provided.
   */
  private prepareTools(options: GenerateTextOptions, state: AttemptState): ToolSet | undefined {
    const tools = options.tools
    if (!tools || Object.keys(tools).length === 0) return undefined

    const prepared: Record<string, ToolDefinition> = {}
    for (const [name, tool] of Object.entries(tools)) {
      const permission = toolPermission(options.toolPermissions, name)
      if (permission === 'deny') continue

      let candidate = this.trackExecution(tool as unknown as ToolDefinition, state)
      if (permission === 'ask' || options.toolGuard?.guard) {
        candidate = this.guardTool(name, candidate, permission, options.toolGuard)
      }
      prepared[name] = candidate
    }

    return Object.keys(prepared).length > 0 ? (prepared as unknown as ToolSet) : undefined
  }

  /** Marks the attempt as having run tools, so the chain never falls back after a side effect. */
  private trackExecution(tool: ToolDefinition, state: AttemptState): ToolDefinition {
    const original = tool.execute?.bind(tool)
    if (!original) return tool
    return {
      ...tool,
      execute: (args: unknown, execOptions?: unknown) => {
        state.toolsExecuted = true
        return original(args, execOptions)
      },
    }
  }

  /** Wraps a tool with the guard and, for `ask`, the confirmation service. */
  private guardTool(
    name: string,
    tool: ToolDefinition,
    permission: ToolPermission,
    guardOptions: GenerateTextOptions['toolGuard']
  ): ToolDefinition {
    return this.toolRegistry.wrapTool(name, tool, {
      permission,
      guard: guardOptions?.guard,
      confirmation: guardOptions?.confirmation ?? this.confirmation,
      sessionId: guardOptions?.sessionId,
      timeoutMs: guardOptions?.timeoutMs,
    })
  }

  private buildTextParams(
    options: GenerateTextOptions,
    model: LanguageModel,
    state: AttemptState,
    signal?: AbortSignal
  ): TextCallParams & StreamCallParams {
    const maxOutputTokens = options.maxOutputTokens ?? options.maxTokens
    const common = {
      model,
      instructions: options.system || undefined,
      temperature: options.temperature,
      topP: options.topP,
      maxOutputTokens,
      tools: this.prepareTools(options, state),
      stopWhen: options.stopWhen ?? (options.maxSteps ? stepCountIs(options.maxSteps) : undefined),
      maxRetries: options.maxRetries,
      onStepFinish: options.onStepFinish
        ? async (step: StepResult<ToolSet>) => {
            try {
              await options.onStepFinish?.(step)
            } catch (err) {
              this.logger?.warn?.(`[AiManager] onStepFinish callback failed: ${String(err)}`)
            }
          }
        : undefined,
      abortSignal: signal,
    }

    if (options.messages && options.messages.length > 0) {
      return { ...common, messages: options.messages } as TextCallParams & StreamCallParams
    }
    if (options.prompt) {
      return { ...common, prompt: options.prompt } as TextCallParams & StreamCallParams
    }
    throw new AiException('Either "prompt" or non-empty "messages" is required.', 'E_AI_INVALID_ARGUMENT')
  }

  private async recordCost(
    agentName: string,
    provider: string,
    model: string,
    usage: TokenUsage,
    durationMs: number,
    pricingReady: Promise<void>,
    metadata: Record<string, unknown>
  ): Promise<number | undefined> {
    await Promise.race([pricingReady, sleep(PRICING_WAIT_MS)])
    try {
      return this.costTracker.record({
        agentName,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        reasoningTokens: usage.reasoningTokens,
        totalTokens: usage.totalTokens,
        durationMs,
        metadata: { provider, ...metadata },
      })
    } catch {
      // Cost tracking is non-fatal
      return undefined
    }
  }

  private warnIfOverBudget(agentName: string, totalTokens: number, costUsd?: number): void {
    const budget = this.config.budget
    if (budget?.maxTokensPerRequest && totalTokens > budget.maxTokensPerRequest) {
      this.logger?.warn?.(
        `[AiManager] Token limit exceeded for ${agentName}: ${totalTokens} > ${budget.maxTokensPerRequest}`
      )
    }
    if (costUsd !== undefined && budget?.maxCostPerRequestUsd && costUsd > budget.maxCostPerRequestUsd) {
      this.logger?.warn?.(
        `[AiManager] Cost limit exceeded for ${agentName}: $${costUsd} > $${budget.maxCostPerRequestUsd}`
      )
    }
  }

  /**
   * Generates text using the configured LLM provider with fallback, budget accounting, and tool guard.
   */
  async generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
    const agentName = this.agentNameOf(options)

    const { result, provider, model, usage, durationMs, costUsd } = await this.generateAndRecord(
      agentName,
      options,
      options.schema ? Output.object({ schema: options.schema }) : undefined,
      (done) => ({ finishReason: done.finishReason, ...options.metadata })
    )
    this.warnIfOverBudget(agentName, usage.totalTokens, costUsd)

    return {
      text: result.text,
      usage,
      costUsd,
      finishReason: result.finishReason ?? 'stop',
      provider,
      model,
      toolCalls: result.toolCalls,
      toolResults: result.toolResults,
      steps: result.steps,
      // `output` throws when no output was specified, so read it only for schema calls.
      output: options.schema ? result.output : undefined,
      rawResponse: result.response,
      durationMs,
    }
  }

  /**
   * Streams text from LLM. Initial provider failures (429, 5xx, network) are detected before this
   * method returns, so they trigger fallback and the HTTP layer can still send proper headers.
   * Token usage is recorded when the stream ends or is aborted.
   */
  async streamText(options: StreamTextOptions): Promise<StreamTextResult> {
    const startTime = Date.now()
    const agentName = this.agentNameOf(options)

    const controller = new AbortController()
    const signal = options.abortSignal
      ? AbortSignal.any([options.abortSignal, controller.signal])
      : controller.signal

    let settleUsage: (usage: TokenUsage) => void = () => {}
    const usagePromise = new Promise<TokenUsage>((resolve) => {
      settleUsage = resolve
    })

    const { result: raw, provider, model } = await this.executeWithFallback(
      { ...options, abortSignal: signal },
      async ({ getModel, modelName, providerName, breakerKey, state }) => {
        const pricingReady = this.warmPricing(providerName, modelName)
        const languageModel = await getModel()

        let attemptFailed = false
        let accounted = false
        let streamStarted = false

        const finish = (usage: TokenUsage, text: string, finishReason?: string): void => {
          if (attemptFailed || accounted) return
          accounted = true
          void (async () => {
            let costUsd: number | undefined
            if (usage.totalTokens > 0) {
              costUsd = await this.recordCost(
                agentName,
                providerName,
                modelName,
                usage,
                Date.now() - startTime,
                pricingReady,
                { finishReason, ...options.metadata }
              )
              this.warnIfOverBudget(agentName, usage.totalTokens, costUsd)
            }
            settleUsage(usage)
            try {
              options.onFinish?.({ text, usage, costUsd })
            } catch (err) {
              this.logger?.warn?.(`[AiManager] onFinish callback failed: ${String(err)}`)
            }
          })()
        }

        const params = this.buildTextParams(options, languageModel, state, signal)
        const stream = streamText({
          ...params,
          ...(options.schema ? { output: Output.object({ schema: options.schema }) } : {}),
          onChunk: ({ chunk }) => {
            if (chunk.type === 'text-delta') options.onChunk?.(chunk.text)
          },
          onError: ({ error }) => {
            if (!streamStarted) return // surfaced through the first-part check below
            this.logger?.warn?.(`[AiManager] Stream error on "${breakerKey}": ${String(error)}`)
            if (classifyError(error, signal).countsAsFailure) {
              this.circuitBreaker.recordFailure(breakerKey, error)
            }
            finish(EMPTY_USAGE, '')
          },
          onEnd: (event) => finish(normalizeUsage(event.totalUsage), event.text, event.finishReason),
          onAbort: (event) => finish(sumUsage(event.steps.map((s) => s.usage)), ''),
        } as StreamCallParams)

        // Wait for the first meaningful part so early provider errors reject this attempt.
        const iterator = stream.fullStream[Symbol.asyncIterator]()
        try {
          for (;;) {
            const { value, done } = await iterator.next()
            if (done) break
            if (value.type === 'error') throw value.error
            if (value.type === 'abort') {
              throw Object.assign(new Error('Generation aborted'), { name: 'AbortError' })
            }
            if (value.type === 'start' || value.type === 'start-step') continue
            break
          }
        } catch (err) {
          attemptFailed = true
          throw err
        } finally {
          // Release only our peek branch; other consumers read their own tee of the stream.
          await iterator.return?.()
        }
        streamStarted = true
        return stream
      }
    )

    // Without a schema the SDK's `output` rejects; expose `undefined` instead.
    const output: Promise<unknown> = options.schema ? Promise.resolve(raw.output) : Promise.resolve(undefined)
    output.catch(() => {}) // a never-read rejection must not surface as unhandled

    return {
      textStream: raw.textStream,
      fullStream: raw.fullStream,
      provider,
      model,
      usage: usagePromise,
      output,
      toTextStreamResponse: (headers) => raw.toTextStreamResponse({ headers }),
      toUIMessageStreamResponse: (opts) => raw.toUIMessageStreamResponse(opts),
      toDataStreamResponse: (headers) => raw.toUIMessageStreamResponse({ headers }),
      consume: async () => {
        const text = await raw.text
        const usage = await usagePromise
        return {
          text,
          usage,
          finishReason: (await raw.finishReason) ?? 'stop',
          provider,
          model,
          durationMs: Date.now() - startTime,
        }
      },
      abort: (reason?: unknown) => controller.abort(reason),
      rawStream: raw,
    }
  }

  /**
   * Generates a typed structured object conforming to a Zod schema
   * (via `generateText` with `Output.object`, as `generateObject` is deprecated in AI SDK v7).
   */
  async generateObject<T>(options: GenerateObjectOptions<T>): Promise<GenerateObjectResult<T>> {
    const { result, provider, model, usage, durationMs, costUsd } = await this.generateAndRecord(
      this.agentNameOf(options),
      options,
      Output.object({
        schema: options.schema,
        name: options.schemaName,
        description: options.schemaDescription,
      }),
      () => ({ mode: 'structured_object' })
    )

    return {
      object: result.output as T,
      usage,
      costUsd,
      provider,
      model,
      durationMs,
    }
  }

  /** Budget attribution name: the caller's agent, else the configured default. */
  private agentNameOf(options: { agentName?: string }): string {
    return options.agentName ?? this.config.budget?.defaultAgentName ?? 'default-agent'
  }

  /**
   * Runs one text generation through the fallback chain, then records its usage and cost.
   * `generateText` and `generateObject` share this and differ only in the output spec and the
   * cost metadata.
   */
  private async generateAndRecord(
    agentName: string,
    options: GenerateTextOptions,
    output: ReturnType<typeof Output.object> | undefined,
    costMetadata: (result: TextCallResult) => Record<string, unknown>
  ) {
    const startTime = Date.now()
    const { result, provider, model } = await this.executeWithFallback(
      options,
      async ({ getModel, modelName, providerName, state }) => {
        void this.warmPricing(providerName, modelName)
        const languageModel = await getModel()
        const params = this.buildTextParams(options, languageModel, state, options.abortSignal)
        return generateText({ ...params, ...(output ? { output } : {}) } as TextCallParams)
      }
    )

    const durationMs = Date.now() - startTime
    // `totalUsage` sums every step of a tool loop; `usage` is the last step only.
    const usage = normalizeUsage(result.totalUsage ?? result.usage)
    const costUsd = await this.recordCost(
      agentName,
      provider,
      model,
      usage,
      durationMs,
      this.warmPricing(provider, model),
      costMetadata(result)
    )

    return { result, provider, model, usage, durationMs, costUsd }
  }

  /**
   * Fluent conversation builder (Laravel AI / Prism syntax style).
   */
  chat() {
    const messages: ChatMessage[] = []
    let systemPrompt: string | undefined
    let providerOverride: string | undefined
    let modelOverride: string | undefined
    let temperatureVal: number | undefined
    let agentNameVal: string | undefined
    let toolsVal: ToolSet | undefined

    const builder = {
      system: (prompt: string) => {
        systemPrompt = prompt
        return builder
      },
      user: (content: string) => {
        messages.push({ role: 'user', content })
        return builder
      },
      assistant: (content: string) => {
        messages.push({ role: 'assistant', content })
        return builder
      },
      provider: (name: string) => {
        providerOverride = name
        return builder
      },
      model: (name: string) => {
        modelOverride = name
        return builder
      },
      temperature: (val: number) => {
        temperatureVal = val
        return builder
      },
      agent: (name: string) => {
        agentNameVal = name
        return builder
      },
      tools: (tools: ToolSet) => {
        toolsVal = tools
        return builder
      },
      generate: () =>
        this.generateText({
          system: systemPrompt,
          messages: messages as ModelMessage[],
          provider: providerOverride,
          model: modelOverride,
          temperature: temperatureVal,
          agentName: agentNameVal,
          tools: toolsVal,
        }),
      stream: () =>
        this.streamText({
          system: systemPrompt,
          messages: messages as ModelMessage[],
          provider: providerOverride,
          model: modelOverride,
          temperature: temperatureVal,
          agentName: agentNameVal,
          tools: toolsVal,
        }),
    }

    return builder
  }

  /**
   * Driver factory for OpenAI, Anthropic, Google/Gemini, Groq, Ollama, ACP, and Custom providers.
   */
  private async createDriver(name: string, config: ProviderConfig): Promise<AiDriver> {
    switch (config.driver) {
      case 'acp': {
        const { createAcpDriver } = await import('./acp/provider.js')
        return createAcpDriver(name, config as AcpProviderConfig, {
          logger: this.logger,
          confirmation: this.confirmation,
        })
      }

      case 'custom': {
        const customModel = await config.factory(config)
        const defaultModel = config.defaultModel ?? 'custom'
        return {
          name,
          defaultModel,
          getModel: (m) =>
            typeof customModel === 'function' ? customModel(m ?? defaultModel) : customModel,
        }
      }

      default: {
        const spec = Object.hasOwn(SDK_DRIVERS, config.driver) ? SDK_DRIVERS[config.driver] : undefined
        if (!spec) {
          throw new ProviderConfigError(name, `Unsupported driver type: "${config.driver}"`)
        }
        return this.sdkDriver(name, spec, config)
      }
    }
  }

  /** Loads a built-in SDK package, builds its client, and wraps it as a driver. */
  private async sdkDriver(name: string, spec: SdkDriverSpec, config: ProviderConfig): Promise<AiDriver> {
    const sdk = await this.safeImport<Record<string, ClientFactory>>(
      spec.pkg,
      `${spec.label} driver requires package "${spec.pkg}"`
    )
    const client = sdk[spec.factory](spec.settings(config))
    const defaultModel = config.defaultModel ?? spec.defaultModel
    return {
      name,
      defaultModel,
      getModel: (m) => client(m ?? defaultModel),
    }
  }

  private async safeImport<T>(pkgName: string, helpMsg: string): Promise<T> {
    try {
      return (await import(pkgName)) as T
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      throw new AiException(`${helpMsg}. Error: ${message}`, 'E_AI_MISSING_DEPENDENCY', e)
    }
  }
}
