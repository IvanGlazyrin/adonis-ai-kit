import { AiException, ProviderUnavailableError } from './errors.js'

/**
 * - `retryable`: transient upstream failure; try the next provider
 * - `skip`:      this provider cannot serve the request (open breaker, missing package/config);
 *                try the next provider but do not count it against the breaker
 * - `fatal`:     the request itself is wrong or was cancelled; fail immediately, no fallback
 *
 * Whether a failure also counts against the circuit breaker is a separate question,
 * answered by {@link ErrorClassification.countsAsFailure}.
 */
export type ErrorKind = 'retryable' | 'skip' | 'fatal'

export interface ErrorClassification {
  kind: ErrorKind
  reason: string
  /** Fine-grained cause; `unknown` for skip / abort / validation outcomes. */
  errorClass: ErrorClass
  /** Whether the failure says something about upstream health and should count against the circuit breaker. */
  countsAsFailure: boolean
}

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

const FATAL_NAMES = new Set([
  'AI_TypeValidationError',
  'AI_InvalidPromptError',
  'AI_InvalidArgumentError',
  'AI_NoObjectGeneratedError',
  'AI_NoSuchToolError',
  'AI_InvalidToolInputError',
  'AI_JSONParseError',
  'AI_UnsupportedFunctionalityError',
  'AI_LoadAPIKeyError',
  'ZodError',
])

const NETWORK_MESSAGE = /fetch failed|network|socket hang up|timed? ?out|connection (reset|refused|closed)/i

/**
 * Returns the first value `pick` extracts from the error or from its `cause` / `lastError`
 * chain (AI SDK `RetryError` keeps the real failure in `lastError`), looking at most `depth` levels down.
 */
function findErrorField<T>(
  error: unknown,
  pick: (node: Record<string, any>) => T | undefined,
  depth = 5
): T | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const node = error as Record<string, any>
  const own = pick(node)
  if (own !== undefined) return own
  if (depth <= 0) return undefined
  return findErrorField(node.cause, pick, depth - 1) ?? findErrorField(node.lastError, pick, depth - 1)
}

const asNumber = (v: unknown) => (typeof v === 'number' ? v : undefined)

function statusOf(error: unknown): number | undefined {
  return findErrorField(
    error,
    (n) => asNumber(n.statusCode) ?? asNumber(n.status) ?? asNumber(n.response?.status)
  )
}

function codeOf(error: unknown): string | undefined {
  return findErrorField(error, (n) => (typeof n.code === 'string' ? n.code : undefined))
}

/**
 * Fine-grained taxonomy of an LLM API failure.
 *
 * `ErrorKind` answers "should we fall back to the next provider?".
 * `ErrorClass` answers "what actually went wrong?", which is what belongs in logs,
 * dashboards and user-facing messages.
 */
export type ErrorClass =
  | 'rate_limit' // 429
  | 'overloaded' // 529, 409, 425
  | 'timeout' // 408
  | 'auth_error' // 401, 403
  | 'model_not_found' // 404
  | 'prompt_too_long' // 400 + specific message
  | 'invalid_request' // 400 other
  | 'server_error' // 5xx
  | 'network_error' // connection refused, DNS
  | 'no_output_generated' // AI SDK: model produced no output (transient)
  | 'unknown'

/** Statuses with one class each; 400 and 5xx are decided by the message or the range. */
const CLASS_BY_EXACT_STATUS: Record<number, ErrorClass> = {
  429: 'rate_limit',
  529: 'overloaded',
  409: 'overloaded',
  425: 'overloaded',
  408: 'timeout',
  401: 'auth_error',
  403: 'auth_error',
  404: 'model_not_found',
}

const PROMPT_TOO_LONG_STATUS_HINTS = ['too long', 'max_tokens', 'context length']

function classByStatusCode(status: number, message: string): ErrorClass {
  const exact = CLASS_BY_EXACT_STATUS[status]
  if (exact) return exact
  if (status === 400) {
    return PROMPT_TOO_LONG_STATUS_HINTS.some((hint) => message.includes(hint))
      ? 'prompt_too_long'
      : 'invalid_request'
  }
  if (status >= 500) return 'server_error'
  return 'unknown'
}

const NO_OUTPUT_ERROR_NAMES: ReadonlySet<unknown> = new Set([
  'AI_NoOutputGeneratedError',
  'NoOutputGeneratedError',
])

/** The AI SDK reports no output; the message may still carry the upstream status. */
function classifyNoOutput(message: string): ErrorClass {
  if (message.includes('403') || message.includes('401')) return 'auth_error'
  if (message.includes('429')) return 'rate_limit'
  if (message.includes('500') || message.includes('502') || message.includes('503')) return 'server_error'
  return 'no_output_generated'
}

/** Network and timeout hints in the message, for errors that carry no status or code. */
function classifyByMessage(message: string): ErrorClass | undefined {
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED') || message.includes('ENOTFOUND')) {
    return 'network_error'
  }
  if (message.includes('timeout') || message.includes('ETIMEDOUT')) return 'timeout'
  if (message.includes('too long') || message.includes('context length')) return 'prompt_too_long'
  return undefined
}

/**
 * Classifies an error into the fine-grained {@link ErrorClass} taxonomy.
 * The HTTP status and error code are looked up through the `cause` / `lastError` chain.
 */
export function classifyErrorClass(error: unknown): ErrorClass {
  const isObject = error !== null && typeof error === 'object'
  const name = isObject ? (error as { name?: unknown }).name : undefined
  const message = isObject ? String((error as { message?: unknown }).message ?? '') : ''

  const status = statusOf(error)
  if (status !== undefined) return classByStatusCode(status, message)
  if (NO_OUTPUT_ERROR_NAMES.has(name)) return classifyNoOutput(message)
  if (name === 'TimeoutError') return 'timeout'

  const code = codeOf(error)
  if (code && NETWORK_CODES.has(code)) return 'network_error'

  return classifyByMessage(message) ?? 'unknown'
}

const RETRYABLE_ERROR_CLASSES: ReadonlySet<ErrorClass> = new Set([
  'rate_limit',
  'overloaded',
  'timeout',
  'server_error',
  'network_error',
  'prompt_too_long',
  'no_output_generated',
])

/**
 * Whether an error class is transient and therefore eligible for fallback routing.
 */
export function isRetryableError(errorClass: ErrorClass): boolean {
  return RETRYABLE_ERROR_CLASSES.has(errorClass)
}

const BREAKER_ERROR_CLASSES: ReadonlySet<ErrorClass> = new Set([
  'rate_limit',
  'overloaded',
  'timeout',
  'server_error',
  'network_error',
])

/**
 * Whether an error class reflects upstream health and should count against the circuit breaker.
 * `prompt_too_long` and `no_output_generated` fall back to another model but never open the breaker.
 */
export function countsAsBreakerFailure(errorClass: ErrorClass): boolean {
  return BREAKER_ERROR_CLASSES.has(errorClass)
}

/**
 * Classifies an error for fallback / circuit-breaker decisions.
 * `abortSignal` is the caller's signal: when it is aborted the failure is the caller's doing.
 */
export function classifyError(error: unknown, abortSignal?: AbortSignal): ErrorClassification {
  const outcome = (kind: ErrorKind, reason: string, errorClass: ErrorClass = 'unknown'): ErrorClassification => ({
    kind,
    reason,
    errorClass,
    countsAsFailure: kind === 'retryable' && countsAsBreakerFailure(errorClass),
  })

  if (abortSignal?.aborted) return outcome('fatal', 'aborted by caller')

  if (error instanceof ProviderUnavailableError) return outcome('skip', 'circuit breaker open')
  if (
    error instanceof AiException &&
    (error.code === 'E_AI_MISSING_DEPENDENCY' || error.code === 'E_AI_CONFIG_ERROR')
  ) {
    return outcome('skip', error.code)
  }

  if (error === null || typeof error !== 'object') return outcome('fatal', 'unknown error')
  const err = error as Record<string, any>

  if (err.name === 'AbortError') return outcome('fatal', 'aborted')
  if (FATAL_NAMES.has(err.name)) return outcome('fatal', `validation (${err.name})`)

  const errorClass = classifyErrorClass(error)
  if (isRetryableError(errorClass)) return outcome('retryable', errorClass, errorClass)
  if (errorClass !== 'unknown') return outcome('fatal', errorClass, errorClass)

  // Unclassified: keep the loose heuristics, but never override an explicit HTTP status.
  if (statusOf(error) === undefined) {
    if (NETWORK_MESSAGE.test(typeof err.message === 'string' ? err.message : '')) {
      return outcome('retryable', 'network', 'network_error')
    }
    if (err.isRetryable === true) return outcome('retryable', 'provider marked retryable')
  }

  return outcome('fatal', 'unclassified error')
}

const FRIENDLY_MESSAGES: Record<ErrorClass, string> = {
  rate_limit: 'Rate limited by API provider',
  overloaded: 'API provider overloaded',
  timeout: 'API request timed out',
  auth_error: 'API authentication failed — check API key',
  model_not_found: 'Model not found — check LLM_MODEL config',
  prompt_too_long: 'Context too large for model — consider compaction',
  invalid_request: 'Invalid API request',
  server_error: 'API server error',
  network_error: 'Network error — check connectivity',
  no_output_generated: 'Model produced no output — transient error, will retry',
  unknown: 'Unknown API error',
}

/**
 * Human-readable message for an error class, safe to show to an operator.
 */
export function getUserFriendlyMessage(errorClass: ErrorClass): string {
  return Object.hasOwn(FRIENDLY_MESSAGES, errorClass) ? FRIENDLY_MESSAGES[errorClass] : FRIENDLY_MESSAGES.unknown
}
