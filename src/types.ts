import type { z } from 'zod'
import type {
  LanguageModel,
  ModelMessage,
  PrepareStepFunction,
  StepResult,
  StopCondition,
  StreamTextResult as AiStreamTextResult,
  TextStreamPart,
  ToolCallRepairFunction,
  ToolSet,
} from 'ai'
import type { ModelPricing } from './budget/types.js'
import type { ActionGuard, ToolPermission } from './guard/types.js'
import type { ConfirmationService } from './guard/confirmation.js'
import type { AcpProviderConfig } from './acp/types.js'
import type { ModelResolver } from './models/catalog_resolver.js'
import type { FallbackEvent } from './models/model_chain.js'
import type { LanguageModelSource, ResolvedModel } from './models/types.js'
import type { ConversationCallOptions, ConversationStore } from './conversations/types.js'

export type CircuitBreakerState = 'closed' | 'open' | 'half_open'

export interface CircuitBreakerConfig {
  /**
   * Number of consecutive failures before opening the circuit breaker.
   * Default: 5
   */
  failureThreshold?: number
  /**
   * Cooldown period in milliseconds before attempting recovery.
   * Default: 30000 (30 seconds)
   */
  recoveryTimeoutMs?: number
  /**
   * Number of SUCCESSFUL probe requests in half-open state required to close the circuit.
   * Default: 2
   */
  halfOpenMaxAttempts?: number
  /**
   * Maximum number of probe requests allowed in flight at the same time while half-open.
   * Further requests are rejected until a probe finishes. Default: 1
   */
  halfOpenMaxConcurrent?: number
  /**
   * Optional callback when circuit breaker state changes. Errors thrown here are swallowed.
   * The first argument is the breaker key (`provider:model`).
   */
  onStateChange?: (key: string, from: CircuitBreakerState, to: CircuitBreakerState) => void
}

export interface CircuitBreakerStats {
  state: CircuitBreakerState
  failures: number
  successes: number
  lastFailureTime: number | null
  nextAttemptAllowedAt: number | null
}

export interface BaseProviderConfig {
  defaultModel?: string
  headers?: Record<string, string>
  baseURL?: string
}

export interface OpenAIProviderConfig extends BaseProviderConfig {
  driver: 'openai'
  apiKey?: string
  organization?: string
  project?: string
}

export interface AnthropicProviderConfig extends BaseProviderConfig {
  driver: 'anthropic'
  apiKey?: string
}

export interface GoogleProviderConfig extends BaseProviderConfig {
  driver: 'google' | 'gemini'
  apiKey?: string
}

export interface GroqProviderConfig extends BaseProviderConfig {
  driver: 'groq'
  apiKey?: string
}

export interface OllamaProviderConfig extends BaseProviderConfig {
  driver: 'ollama'
  baseURL?: string
}

export interface CustomProviderConfig extends BaseProviderConfig {
  driver: 'custom'
  /** Returns an AI SDK language model, or a function `(modelId) => LanguageModel`. */
  factory: (
    config: CustomProviderConfig
  ) => Promise<LanguageModel | ((modelId: string) => LanguageModel)> | LanguageModel | ((modelId: string) => LanguageModel)
}

export type {
  AcpProviderConfig,
  AcpMcpServerConfig,
  AcpAgentConfig,
  AcpAgentRuntimeConfig,
  AcpPermissionPolicy,
} from './acp/types.js'

export type ProviderConfig =
  | OpenAIProviderConfig
  | AnthropicProviderConfig
  | GoogleProviderConfig
  | GroqProviderConfig
  | OllamaProviderConfig
  | AcpProviderConfig
  | CustomProviderConfig

export interface BudgetConfig {
  maxTokensPerRequest?: number
  maxCostPerRequestUsd?: number
  defaultAgentName?: string
  pricing?: Record<string, ModelPricing>
}

export interface CatalogConfig {
  /**
   * Whether to prefer cached models.dev catalog if available.
   * Default: true
   */
  preferCache?: boolean
  /**
   * Custom path to models.dev.json cache file.
   */
  cachePath?: string
  /**
   * Custom path to override models catalog json file.
   */
  overridePath?: string
  /**
   * Which system providers to inject into the catalog when missing: built-in
   * `fallback` providers (openai / anthropic / google) and `acp` agents (`acp-<id>`).
   * Both default to true.
   */
  systemProviders?: { fallback?: boolean; acp?: boolean }
  /**
   * Whether to automatically fetch and update model pricing from models.dev into the budget tracker.
   * Default: true
   */
  autoPricing?: boolean
  /**
   * How long a cached catalog (memory and disk) stays fresh before it is refreshed, in ms.
   * Default: 24 hours
   */
  ttlMs?: number
}

export interface AiConfig {
  /**
   * Default provider key (e.g. 'openai')
   */
  default: string
  /**
   * Configured providers
   */
  providers: Record<string, ProviderConfig>
  /**
   * Ordered list of provider keys to try if the primary provider fails.
   * Only providers listed here are used as fallbacks; ACP agents (local CLIs with shell/file
   * access) are never added automatically.
   */
  fallbackCascade?: string[]
  /**
   * Model to use on a given fallback provider. When absent, the fallback provider's own
   * `defaultModel` is used; the model requested for the primary provider is never forwarded.
   */
  fallbackModels?: Record<string, string>
  /**
   * Resilience circuit breaker configuration
   */
  circuitBreaker?: CircuitBreakerConfig
  /**
   * Token and cost budget configuration
   */
  budget?: BudgetConfig
  /**
   * models.dev catalog discovery & metadata caching configuration
   */
  catalog?: CatalogConfig
  /**
   * Path to agent configuration markdown files directory (defaults to resources/agent-configs)
   */
  agentConfigsDir?: string
  /**
   * Path to agent skills markdown files directory (defaults to resources/agent-skills)
   */
  agentSkillsDir?: string
  /**
   * Whether to log detailed AI calls
   */
  logging?: boolean
  /** Resolves string entries of a call's `models` chain. Required to use model references there. */
  resolver?: ModelResolver
  /**
   * Builds language models for `models` chains. Defaults to a `LanguageModelFactory` created lazily;
   * `fakeLanguageModels()` (from `adonis-ai-kit/testing`) is a test replacement.
   */
  languageModels?: LanguageModelSource
  /** Conversation history (see `adonis-ai-kit/conversations`). Without `store`, an in-memory store is used. */
  conversations?: { store?: ConversationStore }
}

/** Options shared by calls that can run over a dynamic model chain. */
export interface ModelChainCallOptions {
  /**
   * Ordered chain of models (resolved models or references). When non-empty, the provider cascade
   * is not used: each entry is tried in order with its own per-credential circuit breaker.
   */
  models?: Array<ResolvedModel | string>
  /** Called when a model failed with a retryable error, or could not be attempted (missing provider package, config error, open breaker), and the next entry is about to be tried. */
  onFallback?: (event: FallbackEvent) => unknown
}

export interface AiDriver {
  readonly name: string
  readonly defaultModel: string
  getModel(modelName?: string): LanguageModel | Promise<LanguageModel>
  ping?(): Promise<{ ok: boolean; latencyMs: number; error?: string }>
  /** Releases resources held by the driver (e.g. child processes). */
  shutdown?(): Promise<void> | void
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

/** Chat messages use the AI SDK's `ModelMessage` shape. */
export type ChatMessage = ModelMessage

/**
 * Token usage normalized from AI SDK v7 (`inputTokens` / `outputTokens` / `*TokenDetails`).
 * `inputTokens` includes cached tokens; `outputTokens` includes reasoning tokens.
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  /** @deprecated Alias of `inputTokens` (AI SDK v4 name). */
  promptTokens: number
  /** @deprecated Alias of `outputTokens` (AI SDK v4 name). */
  completionTokens: number
}

export interface ToolGuardOptions {
  guard?: ActionGuard
  confirmation?: ConfirmationService
  sessionId?: string
  /** Confirmation timeout for `ask` tools, in ms. */
  timeoutMs?: number
}

/** Provider-specific call options keyed by provider name, e.g. `{ anthropic: { ... } }`. */
export type ProviderOptions = Record<string, Record<string, unknown>>

/** Cache lifetime of an Anthropic prompt-cache breakpoint. */
export type CacheTtl = '5m' | '1h'

/** Anthropic prompt-cache markers. Each key adds one breakpoint; at most four are sent. */
export interface PromptCacheOptions {
  /** Marks the system prompt (`instructions`). */
  instructions?: CacheTtl
  /** Marks the last tool, with the tools sorted by name so the cached prefix stays stable. */
  tools?: CacheTtl
}

export interface GenerateTextOptions extends ModelChainCallOptions {
  prompt?: string
  messages?: ModelMessage[]
  system?: string
  provider?: string
  model?: string
  temperature?: number
  /** Maximum number of tokens to generate (AI SDK v7 `maxOutputTokens`). */
  maxOutputTokens?: number
  /** @deprecated Use `maxOutputTokens`. */
  maxTokens?: number
  topP?: number
  tools?: ToolSet
  /**
   * Per-tool permissions applied by the manager. `deny` tools are dropped, `ask` tools need a
   * human confirmation, tools not listed are `allow`.
   */
  toolPermissions?: Record<string, ToolPermission>
  /** Maximum number of model steps in a tool loop (mapped to `stopWhen: stepCountIs(n)`). */
  maxSteps?: number
  /** Custom stop condition(s) for the tool loop. Takes precedence over `maxSteps`. */
  stopWhen?: StopCondition<ToolSet> | StopCondition<ToolSet>[]
  /** Structured output schema; the parsed value is exposed as `output`. Works together with `tools`. */
  schema?: z.ZodType
  /** Provider call retries performed by the AI SDK (SDK default applies when omitted). */
  maxRetries?: number
  /** Called after every model step. Callback errors are logged and ignored. */
  onStepFinish?: (step: StepResult<ToolSet>) => void | Promise<void>
  agentName?: string
  abortSignal?: AbortSignal
  metadata?: Record<string, unknown>
  toolGuard?: ToolGuardOptions
  /**
   * Runs before each step of the tool loop (AI SDK `prepareStep`). Its `model` is ignored with a warning:
   * fallback, the circuit breaker and cost stay bound to the attempt's model. Tools cannot be added here,
   * only narrowed with `activeTools`.
   */
  prepareStep?: PrepareStepFunction<ToolSet>
  /** Only these tools are offered to the model, in every step. Denied tools stay denied. */
  activeTools?: string[]
  /** Provider-specific call options (AI SDK `providerOptions`). Passed through as is. */
  providerOptions?: ProviderOptions
  /** Anthropic prompt-cache breakpoints for the system prompt and the tools. */
  promptCache?: PromptCacheOptions
  /** Repairs a tool call that names an unknown tool or has invalid input (AI SDK `repairToolCall`). */
  repairToolCall?: ToolCallRepairFunction<ToolSet>
  /**
   * Strips prose around the JSON answer before it is parsed with `schema` (see `extractFirstJsonValue`).
   * Off by default. Not applied to string models or ACP agents.
   */
  jsonRecovery?: boolean
  /**
   * Continues a stored conversation: the history is sent before this call's messages, and the turn is stored
   * after the model answered. The owner is checked on every call.
   */
  conversation?: ConversationCallOptions
}

export interface GenerateTextResult {
  text: string
  usage: TokenUsage
  costUsd?: number
  finishReason: string
  provider: string
  model: string
  toolCalls?: unknown[]
  toolResults?: unknown[]
  steps?: unknown[]
  /** Parsed structured output, present when `schema` was given. */
  output?: unknown
  /** Provider response metadata (`result.response` of the AI SDK). */
  rawResponse?: unknown
  /** The messages the model produced in this call (assistant and tool messages). */
  responseMessages: ModelMessage[]
  /** Set when the call continued a conversation: its id and the version after this turn was stored. */
  conversation?: { id: string; version: number }
  durationMs: number
}

export interface StreamTextOptions extends GenerateTextOptions {
  /** Called for every text delta once the stream is consumed. */
  onChunk?: (chunk: string) => void
  onFinish?: (result: { text: string; usage: TokenUsage; costUsd?: number }) => void
}

export type AiStreamPart = TextStreamPart<ToolSet>

export interface StreamTextResult {
  textStream: AsyncIterable<string>
  fullStream: AsyncIterable<AiStreamPart>
  provider: string
  model: string
  /** Resolves when the stream ends, is aborted, or fails (never rejects, never hangs forever). */
  usage: Promise<TokenUsage>
  /**
   * Parsed structured output. Resolves to `undefined` when no `schema` was given; may reject when the
   * stream fails or is aborted, or when the output does not match the schema. With `schema`, the stream
   * is consumed to completion in the background so this settles even if nothing else reads the stream.
   */
  output: Promise<unknown>
  toTextStreamResponse(headers?: Record<string, string>): Response
  /** AI SDK UI message stream (compatible with `useChat`). */
  toUIMessageStreamResponse(
    options?: Parameters<AiStreamTextResult<ToolSet, any, any>['toUIMessageStreamResponse']>[0]
  ): Response
  /** @deprecated `toDataStreamResponse` was removed in AI SDK v5; alias of `toUIMessageStreamResponse`. */
  toDataStreamResponse(headers?: Record<string, string>): Response
  consume(): Promise<GenerateTextResult>
  /** Cancels the underlying generation (e.g. when the HTTP client disconnected). */
  abort(reason?: unknown): void
  rawStream: AiStreamTextResult<ToolSet, any, any>
}

export interface GenerateObjectOptions<T> extends ModelChainCallOptions {
  prompt?: string
  messages?: ModelMessage[]
  system?: string
  provider?: string
  model?: string
  schema: z.ZodType<T>
  schemaName?: string
  schemaDescription?: string
  agentName?: string
  temperature?: number
  maxOutputTokens?: number
  /** @deprecated Use `maxOutputTokens`. */
  maxTokens?: number
  abortSignal?: AbortSignal
  /** Strips prose around the JSON answer before parsing (see `extractFirstJsonValue`). Off by default. */
  jsonRecovery?: boolean
}

export interface GenerateObjectResult<T> {
  object: T
  usage: TokenUsage
  costUsd?: number
  provider: string
  model: string
  durationMs: number
}

export interface StreamAIOptions {
  /**
   * `sse`  - legacy `event: message` frames with JSON `{type:'chunk',text}` and a `[DONE]` sentinel
   * `ui`   - AI SDK UI message stream (use with `useChat`)
   * `text` - raw text chunks
   */
  mode?: 'sse' | 'ui' | 'text'
  event?: string
  onChunk?: (chunk: string) => void
  onFinish?: (fullText: string) => void
  onError?: (error: Error) => void
  headers?: Record<string, string>
  /** Interval of SSE keep-alive comments in ms. 0 disables. Default: 15000 */
  heartbeatMs?: number
  /** Include `error.message` in SSE error events. Default: false (generic message). */
  exposeErrors?: boolean
}
