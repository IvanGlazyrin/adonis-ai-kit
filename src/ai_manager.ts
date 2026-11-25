import { generateText, Output, type LanguageModel, type StopCondition, type ToolSet } from 'ai'
import type { AgentLoader, AgentPromptConfig } from './agents/loader.js'
import { AgentRunner, type AgentRunnerOptions } from './agents/agent_runner.js'
import { ApprovalSignatureError } from './approvals/errors.js'
import { type ApprovalRun, approvalsFromMessages, asJson, pendingViews, toolMessageOf } from './approvals/resumable.js'
import type { ApprovalSecret } from './approvals/secret.js'
import { CallBudgetHold } from './budget/call_budget.js'
import { CostTracker } from './budget/cost_tracker.js'
import { stopOnBudget } from './budget/stop_condition.js'
import { CallEvents, deliverEvent, observerSink } from './call_events.js'
import { type ModelsDevSource, resolveCatalogProviderId } from './catalog/source.js'
import { CircuitBreaker } from './circuit_breaker.js'
import { Conversations, type ConversationTurn } from './conversations/conversations.js'
import { AiException, BudgetExceededError, ProviderConfigError } from './errors.js'
import type { AiObserver } from './events/types.js'
import { ConfirmationService } from './guard/confirmation.js'
import { ToolRegistry } from './guard/registry.js'
import type { Logger } from './logger.js'
import {
  DEFAULT_APPROVAL_TTL_MS,
  PRICING_WAIT_MS,
  type ResumeContext,
  type TextCallParams,
  type TextCallResult,
  approvalFailure,
  approvalSecretOf,
  assertNoApprovalParts,
  assertPromptIsString,
  buildTextParams as buildCallTextParams,
  closeApprovalStep,
  defaultAgentLoader,
  defaultCatalog,
  inputMessages,
  pricingMapOf,
  settleUnavailableApprovals,
  sleep,
  withHistory,
  withJsonRecovery,
} from './manager/call_helpers.js'
import { createChatBuilder } from './manager/chat_builder.js'
import { type AttemptContext, type ChainRequest, executeWithFallback } from './manager/fallback.js'
import { createDriver as buildDriver } from './manager/sdk_drivers.js'
import { runStreamCall } from './manager/stream_call.js'
import { type ApprovalContext, type AttemptState, approvalExecution as runApprovalExecution, toolPermission } from './manager/tool_preparation.js'
import type { ToolDefinition } from './guard/types.js'
import { McpTools } from './mcp/mcp_tools.js'
import { LanguageModelFactory, type LanguageModelSource } from './models/index.js'
import { validatePromptCache } from './prompt_cache.js'
import type {
  AiConfig,
  AiDriver,
  GenerateObjectOptions,
  GenerateObjectResult,
  GenerateTextOptions,
  GenerateTextResult,
  ProviderConfig,
  StreamTextOptions,
  StreamTextResult,
  TokenUsage,
} from './types.js'
import { normalizeUsage } from './usage.js'

/** @deprecated Use Logger */
export type LoggerContract = Logger

/** Services an `AiManager` uses instead of creating its own. Every field is optional. */
export interface AiManagerOptions {
  logger?: Logger
  costTracker?: CostTracker
  toolRegistry?: ToolRegistry
  catalog?: ModelsDevSource
  agentLoader?: AgentLoader
  confirmation?: ConfirmationService
  mcp?: McpTools
  /**
   * The breaker every call goes through. Share one with code that runs `runModelChain` itself, so both see the same
   * failures. Default: a new breaker built from `config.circuitBreaker`.
   */
  circuitBreaker?: CircuitBreaker
  /**
   * Receives the lifecycle events of every call (see `AiEvent`). The service provider passes one that forwards them
   * to the AdonisJS emitter as `ai:<type>`.
   */
  observer?: AiObserver
}

/** Whether a value is a logger (it has an `info` method) rather than an options object. */
function isLogger(value: unknown): value is Logger {
  return typeof value === 'object' && value !== null && typeof (value as { info?: unknown }).info === 'function'
}

/**
 * The constructor's arguments after `config`, as options. One plain object is the options form; anything else
 * (a logger, `undefined` followed by more arguments, or several arguments) is the positional form.
 */
function managerOptionsOf(rest: unknown[]): AiManagerOptions {
  const [first] = rest
  const optionsForm = rest.length <= 1 && (first === undefined || (typeof first === 'object' && first !== null && !isLogger(first)))
  if (optionsForm) return (first as AiManagerOptions | undefined) ?? {}
  const [logger, costTracker, toolRegistry, catalog, agentLoader, confirmation, mcp] = rest as [
    Logger?, CostTracker?, ToolRegistry?, ModelsDevSource?, AgentLoader?, ConfirmationService?, McpTools?,
  ]
  return { logger, costTracker, toolRegistry, catalog, agentLoader, confirmation, mcp }
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
  private conversationService?: Conversations
  private approvalSecret?: ApprovalSecret
  private mcpTools?: McpTools
  private observer?: AiObserver

  constructor(config: AiConfig, options?: AiManagerOptions)
  /** @deprecated Pass the services as an options object: `new AiManager(config, { logger, costTracker, ... })`. */
  constructor(
    config: AiConfig,
    logger?: Logger,
    costTracker?: CostTracker,
    toolRegistry?: ToolRegistry,
    catalog?: ModelsDevSource,
    agentLoader?: AgentLoader,
    confirmation?: ConfirmationService,
    mcp?: McpTools
  )
  constructor(config: AiConfig, ...rest: unknown[]) {
    const { logger, costTracker, toolRegistry, catalog, agentLoader, confirmation, mcp, circuitBreaker, observer } =
      managerOptionsOf(rest)
    this.observer = observer
    // The secret is kept as an ApprovalSecret, which redacts itself, so `getConfig()` never shows it in clear.
    this.approvalSecret = approvalSecretOf(config)
    this.config =
      this.approvalSecret && config.approvals
        ? { ...config, approvals: { ...config.approvals, secret: this.approvalSecret } }
        : config
    this.logger = logger
    this.circuitBreaker = circuitBreaker ?? new CircuitBreaker(this.breakerConfigOf(config))
    this.costTracker =
      costTracker ??
      new CostTracker({
        pricing: config.budget?.pricing,
        logger: this.logger,
        sink: config.budget?.sink,
        maxRecords: config.budget?.maxRecords,
      })
    this.toolRegistry = toolRegistry ?? new ToolRegistry({ logger: this.logger })
    this.confirmation = confirmation ?? new ConfirmationService({ logger: this.logger })
    this.catalog = catalog ?? defaultCatalog(config, this.logger)
    this.agentLoader = agentLoader ?? defaultAgentLoader(config, this.logger)
    this.mcpTools = mcp ?? (config.mcp ? new McpTools(config.mcp, { logger: this.logger }) : undefined)
    this.registerCatalogPricing()
  }

  getConfig(): AiConfig {
    return this.config
  }

  /** The configured breaker settings, with state changes also reported as `breaker:state` events. */
  private breakerConfigOf(config: AiConfig): AiConfig['circuitBreaker'] {
    return {
      ...config.circuitBreaker,
      onStateChange: (key, from, to) => {
        deliverEvent({ type: 'breaker:state', key, from, to }, [observerSink(this.observer)], this.logger)
        config.circuitBreaker?.onStateChange?.(key, from, to)
      },
    }
  }

  /**
   * The call's hold on its `budget`, or `undefined` without one. Throws `BudgetExceededError` when the agent or the
   * session has nothing left, before any model is called.
   */
  private openBudget(options: { budget?: GenerateTextOptions['budget']; agentName?: string }): CallBudgetHold | undefined {
    if (!options.budget) return undefined
    const hold = CallBudgetHold.open(options.budget, this.agentNameOf(options))
    if (!hold) {
      const agentName = options.budget.agentName ?? this.agentNameOf(options)
      throw new BudgetExceededError(`Budget exhausted for agent "${agentName}": the call was not made`, {
        agentName,
        summary: options.budget.enforcer.getSummary(),
      })
    }
    return hold
  }

  /** With `budget.enforce`, a stop condition for the per-request limits of the config. */
  private requestLimitStop(): StopCondition<ToolSet> | undefined {
    const budget = this.config.budget
    if (!budget?.enforce) return undefined
    if (budget.maxTokensPerRequest === undefined && budget.maxCostPerRequestUsd === undefined) return undefined
    return stopOnBudget({ maxTokens: budget.maxTokensPerRequest, maxCostUsd: budget.maxCostPerRequestUsd }, this.costTracker)
  }

  /** The events of a new call, sent to the call's `onEvent` and to the manager's observer. */
  private callEventsFor(options: { agentName?: string; onEvent?: GenerateTextOptions['onEvent'] }): CallEvents {
    return new CallEvents(this.agentNameOf(options), [options.onEvent, observerSink(this.observer)], this.logger)
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
   * MCP servers as tools: `ai.mcp.registerTools(ai.getToolRegistry())` connects them and registers their tools
   * (denied until a permission is given). Closed by `shutdown()`.
   */
  get mcp(): McpTools {
    return (this.mcpTools ??= new McpTools(this.config.mcp, { logger: this.logger }))
  }

  /**
   * Service that answers `ask` tool permissions and ACP agent permission requests.
   * Subscribe with `onActionCreated()` and call `approve()` / `reject()` from your UI.
   */
  getConfirmationService(): ConfirmationService {
    return this.confirmation
  }

  /**
   * Conversation store and API (`start`, `get`, `list`, `delete`). Created on first use; an in-memory store unless
   * `config.conversations.store` is set.
   */
  get conversations(): Conversations {
    return (this.conversationService ??= new Conversations({
      store: this.config.conversations?.store,
      logger: this.logger,
      now: () => this.approvalNow(),
      runner: { generate: (options, resume) => this.observedTextTurn(options, resume) },
    }))
  }

  private approvalNow(): Date {
    return this.config.approvals?.now ? this.config.approvals.now() : new Date()
  }

  /** The approval mode of a call: its own, else the config's, else `blocking`. */
  private approvalModeOf(options: GenerateTextOptions): 'blocking' | 'resumable' {
    return options.approvals ?? this.config.approvals?.mode ?? 'blocking'
  }

  /**
   * The approval context of a call, or `undefined` in `blocking` mode. A `resumable` call needs a conversation, a
   * secret, and a durable store (or `allowVolatileStore`); otherwise it is a config error, before the model is called.
   */
  private approvalContextOf(options: GenerateTextOptions, resume?: ResumeContext): ApprovalContext | undefined {
    if (this.approvalModeOf(options) !== 'resumable') return undefined
    if (!options.conversation) {
      throw new AiException('approvals: "resumable" needs a conversation (conversation: { id, owner })', 'E_AI_CONFIG_ERROR')
    }
    if (!this.approvalSecret) {
      throw new AiException('approvals: "resumable" needs approvals.secret (at least 32 bytes)', 'E_AI_CONFIG_ERROR')
    }
    if (!this.conversations.store.durable && this.config.approvals?.allowVolatileStore !== true) {
      throw new AiException(
        'approvals: "resumable" needs a durable conversation store. Set approvals.allowVolatileStore to use the in-memory store (tests and development only).',
        'E_AI_CONFIG_ERROR'
      )
    }
    // A provider runs its own tools and does not sign approval requests, so an `ask` on one cannot be verified.
    for (const [name, tool] of Object.entries(options.tools ?? {})) {
      if (toolPermission(options.toolPermissions, name, tool) === 'ask' && (tool as { type?: string }).type === 'provider') {
        throw new AiException(
          `Tool "${name}" is executed by the provider and cannot ask for approval in "resumable" mode`,
          'E_AI_CONFIG_ERROR'
        )
      }
    }
    return { secret: this.approvalSecret, run: resume?.run }
  }

  /** The time a new pending approval expires. */
  private approvalExpiry(): string {
    const ttl = this.config.approvals?.ttlMs ?? DEFAULT_APPROVAL_TTL_MS
    return new Date(this.approvalNow().getTime() + ttl).toISOString()
  }

  getCatalog(): ModelsDevSource {
    return this.catalog
  }

  getAgentLoader(): AgentLoader {
    return this.agentLoader
  }

  /** Instantiates an executable AgentRunner by loading its markdown manifest and skills. */
  async agent(name: string, options?: AgentRunnerOptions): Promise<AgentRunner> {
    const promptConfig = await this.agentLoader.loadAgentPrompt(name)
    return new AgentRunner(this, promptConfig, options)
  }

  /** Loads all agent prompt configurations from the configured directory. */
  async loadAgents(configsDir?: string, skillsDir?: string): Promise<Record<string, AgentPromptConfig>> {
    return this.agentLoader.loadAllAgentPrompts(configsDir, skillsDir)
  }

  /**
   * Dynamically resolves a model reference string (e.g. 'openai/gpt-6-sol', 'claude-sonnet-5-5')
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

  /** Alias for use() matching AdonisJS convention. */
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
    await this.mcpTools?.close()
    this.confirmation.dispose()
  }

  private get languageModels(): LanguageModelSource {
    return (
      this.config.languageModels ??
      (this.lazyLanguageModels ??= new LanguageModelFactory({
        logger: this.logger,
        acp: { confirmation: this.confirmation },
      }))
    )
  }

  /** Starts loading catalog pricing for a model in the background (deduplicated). */
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

  private executeWithFallback<T>(
    request: ChainRequest,
    operation: (ctx: AttemptContext) => Promise<T>
  ): Promise<{ result: T; provider: string; model: string }> {
    return executeWithFallback(
      {
        config: this.config,
        logger: this.logger,
        circuitBreaker: this.circuitBreaker,
        costTracker: this.costTracker,
        languageModels: () => this.languageModels,
        use: (name) => this.use(name),
        warmPricing: (provider, model) => this.warmPricing(provider, model),
        recordCost: (agent, provider, model, usage, durationMs, pricingReady, metadata) =>
          this.recordCost(agent, provider, model, usage, durationMs, pricingReady, metadata),
        agentNameOf: (opts) => this.agentNameOf(opts),
      },
      request,
      operation
    )
  }

  private buildTextParams(
    options: GenerateTextOptions,
    model: LanguageModel,
    state: AttemptState,
    signal?: AbortSignal,
    approval?: ApprovalContext
  ) {
    return buildCallTextParams(
      options,
      model,
      state,
      {
        toolRegistry: this.toolRegistry,
        confirmation: this.confirmation,
        logger: this.logger,
        requestLimitStop: this.requestLimitStop(),
      },
      signal,
      approval
    )
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

  /** Prices models from the catalog in the background, unless auto-pricing is off. */
  private registerCatalogPricing(): void {
    if (this.config.catalog?.autoPricing === false) return
    this.costTracker.registerPricingLoader(async () => pricingMapOf(await this.catalog.listModels()))
  }

  private warnIfOverBudget(agentName: string, totalTokens: number, costUsd?: number): void {
    this.warnIfOverTokenLimit(agentName, totalTokens)
    if (costUsd !== undefined) this.warnIfOverCostLimit(agentName, costUsd)
  }

  private warnIfOverTokenLimit(agentName: string, totalTokens: number): void {
    const limit = this.config.budget?.maxTokensPerRequest
    if (limit && totalTokens > limit) {
      this.logger?.warn?.(`[AiManager] Token limit exceeded for ${agentName}: ${totalTokens} > ${limit}`)
    }
  }

  private warnIfOverCostLimit(agentName: string, costUsd: number): void {
    const limit = this.config.budget?.maxCostPerRequestUsd
    if (limit && costUsd > limit) {
      this.logger?.warn?.(`[AiManager] Cost limit exceeded for ${agentName}: $${costUsd} > $${limit}`)
    }
  }

  /** Generates text using the configured LLM provider with fallback, budget accounting, and tool guard. */
  async generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
    return this.observedTextTurn(options)
  }

  /** A text turn with its call events: `call:started`, then exactly one `call:completed` or `call:failed`. */
  private async observedTextTurn(options: GenerateTextOptions, resume?: ResumeContext): Promise<GenerateTextResult> {
    const events = this.callEventsFor(options)
    events.started('text', options.metadata)
    let budgetHold: CallBudgetHold | undefined
    try {
      budgetHold = this.openBudget(options)
      const result = await this.generateTextTurn(options, resume, events, budgetHold)
      events.completed({
        provider: result.provider,
        model: result.model,
        usage: result.usage,
        costUsd: result.costUsd,
        finishReason: result.finishReason,
        status: result.status,
      })
      return result
    } catch (err) {
      events.failed(err)
      throw err
    } finally {
      budgetHold?.close()
    }
  }

  /**
   * `generateText` for a call, or for the call that continues a paused step (`resume`, from `ai.conversations`).
   * A `resumable` run that stops at an approval stores its state and returns `status: 'awaiting-approval'`.
   */
  private async generateTextTurn(
    options: GenerateTextOptions,
    resume?: ResumeContext,
    events?: CallEvents,
    budgetHold?: CallBudgetHold
  ): Promise<GenerateTextResult> {
    assertPromptIsString(options.prompt)
    if (!resume) assertNoApprovalParts(options.messages)
    const agentName = this.agentNameOf(options)
    const approval = this.approvalContextOf(options, resume)
    let turn: ConversationTurn | undefined
    let callOptions = options
    if (resume && options.conversation) {
      await settleUnavailableApprovals(resume.run, options)
      const input = [toolMessageOf(resume.run.approvals)]
      turn = await this.conversations.openTurn(options.conversation, input, resume.run)
      callOptions = withHistory(options, turn.history, input)
    } else if (options.conversation) {
      const input = inputMessages(options)
      turn = await this.conversations.openTurn(options.conversation, input)
      callOptions = withHistory(options, turn.history, input)
    }

    const outcome = await this.generateAndRecord(
      agentName,
      callOptions,
      options.schema ? Output.object({ schema: options.schema }) : undefined,
      (done) => ({ finishReason: done.finishReason, ...options.metadata }),
      approval,
      events,
      budgetHold
    ).catch(async (err: unknown) => {
      if (resume && turn && err instanceof ApprovalSignatureError) await closeApprovalStep(turn, resume.run)
      throw err
    })
    const { result, provider, model, usage, durationMs, costUsd } = outcome

    const pending = approval ? approvalsFromMessages(result.response.messages, this.approvalExpiry()) : []
    const awaiting = pending.length > 0
    // The turn is stored only now, after the model answered; a call that failed above stored nothing.
    const conversation = turn
      ? {
          id: turn.id,
          version: await turn.commit(result.response.messages, {
            ...(resume ? { input: [toolMessageOf(resume.run.approvals)] } : {}),
            ...(awaiting ? { state: asJson({ approvals: pending }) } : resume ? { state: null } : {}),
          }),
        }
      : undefined
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
      responseMessages: result.response.messages,
      conversation,
      status: awaiting ? 'awaiting-approval' : 'completed',
      pendingApprovals: awaiting ? pendingViews(result.response.messages, pending) : [],
      expiredApprovalIds: resume?.expiredApprovalIds ?? [],
      durationMs,
    }
  }

  /**
   * Streams text from LLM. Initial provider failures (429, 5xx, network) are detected before this
   * method returns, so they trigger fallback and the HTTP layer can still send proper headers.
   * Token usage is recorded when the stream ends or is aborted.
   */
  async streamText(options: StreamTextOptions): Promise<StreamTextResult> {
    const events = this.callEventsFor(options)
    events.started('stream', options.metadata)
    let budgetHold: CallBudgetHold | undefined
    try {
      budgetHold = this.openBudget(options)
      return await runStreamCall(
        {
          logger: this.logger,
          circuitBreaker: this.circuitBreaker,
          conversations: () => this.conversations,
          agentNameOf: (opts) => this.agentNameOf(opts),
          approvalContextOf: (opts) => this.approvalContextOf(opts),
          approvalExpiry: () => this.approvalExpiry(),
          executeWithFallback: (req, op) => this.executeWithFallback(req, op),
          warmPricing: (p, m) => this.warmPricing(p, m),
          recordCost: (agent, p, m, usage, ms, ready, meta) => this.recordCost(agent, p, m, usage, ms, ready, meta),
          warnIfOverBudget: (agent, tokens, cost) => this.warnIfOverBudget(agent, tokens, cost),
          buildTextParams: (opts, lm, state, signal, approval) => this.buildTextParams(opts, lm, state, signal, approval),
        },
        options,
        events,
        budgetHold
      )
    } catch (err) {
      events.failed(err)
      // The stream never started, so nothing else will settle the hold.
      budgetHold?.close()
      throw err
    }
  }

  /**
   * Generates a typed structured object conforming to a Zod schema
   * (via `generateText` with `Output.object`, as `generateObject` is deprecated in AI SDK v7).
   */
  async generateObject<T>(options: GenerateObjectOptions<T>): Promise<GenerateObjectResult<T>> {
    const events = this.callEventsFor(options)
    events.started('object')
    let budgetHold: CallBudgetHold | undefined
    try {
      budgetHold = this.openBudget(options)
      const generated = await this.generateObjectCall(options, events, budgetHold)
      events.completed({
        provider: generated.provider,
        model: generated.model,
        usage: generated.usage,
        costUsd: generated.costUsd,
        finishReason: generated.finishReason,
        status: 'completed',
      })
      const { finishReason: _finishReason, ...result } = generated
      return result
    } catch (err) {
      events.failed(err)
      throw err
    } finally {
      budgetHold?.close()
    }
  }

  private async generateObjectCall<T>(
    options: GenerateObjectOptions<T>,
    events: CallEvents,
    budgetHold?: CallBudgetHold
  ): Promise<GenerateObjectResult<T> & { finishReason: string }> {
    assertPromptIsString(options.prompt)
    assertNoApprovalParts(options.messages)
    const agentName = this.agentNameOf(options)
    const { result, provider, model, usage, durationMs, costUsd } = await this.generateAndRecord(
      agentName,
      options,
      Output.object({
        schema: options.schema,
        name: options.schemaName,
        description: options.schemaDescription,
      }),
      () => ({ mode: 'structured_object' }),
      undefined,
      events,
      budgetHold
    )

    return {
      object: result.output as T,
      usage,
      costUsd,
      provider,
      model,
      durationMs,
      finishReason: result.finishReason ?? 'stop',
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
    costMetadata: (result: TextCallResult) => Record<string, unknown>,
    approval?: ApprovalContext,
    events?: CallEvents,
    budgetHold?: CallBudgetHold
  ) {
    validatePromptCache(options)
    const startTime = Date.now()
    const { result, provider, model } = await this.executeWithFallback(
      { ...options, events, budgetHold },
      async ({ getModel, modelName, providerName, state, acp }) => {
        void this.warmPricing(providerName, modelName)
        const languageModel = withJsonRecovery(await getModel(), options, acp)
        const params = this.buildTextParams(options, languageModel, state, options.abortSignal, approval)
        try {
          return await generateText({ ...params, ...(output ? { output } : {}) } as TextCallParams)
        } catch (err) {
          throw approvalFailure(err, this.logger)
        }
      }
    )

    const durationMs = Date.now() - startTime
    // `usage` is the sum over every step of a tool loop (AI SDK 7); `totalUsage` is its deprecated alias.
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
    budgetHold?.add(usage.totalTokens, costUsd ?? 0)

    return { result, provider, model, usage, durationMs, costUsd }
  }

  /** Fluent conversation builder (Laravel AI / Prism syntax style). */
  chat() {
    return createChatBuilder({
      generateText: (opts) => this.generateText(opts),
      streamText: (opts) => this.streamText(opts),
    })
  }

  /** Driver factory for OpenAI, Anthropic, Google/Gemini, Groq, Ollama, ACP, and Custom providers. */
  private async createDriver(name: string, config: ProviderConfig): Promise<AiDriver> {
    return buildDriver(name, config, { logger: this.logger, confirmation: this.confirmation })
  }

  private approvalExecution(tool: ToolDefinition, run: ApprovalRun): ToolDefinition {
    return runApprovalExecution(tool, run)
  }
}
