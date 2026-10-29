import type { BreakerPermit, CircuitBreaker } from '../circuit_breaker.js'
import { classifyError, type ErrorClass, type ErrorClassification } from '../error_classifier.js'
import { ProviderConfigError, ProviderUnavailableError } from '../errors.js'
import type { Logger } from '../logger.js'
import type { ModelResolver } from './catalog_resolver.js'
import { breakerKeyFor, modelKeyFor } from './keys.js'
import type { ResolvedModel } from './types.js'

export type ChainCandidate =
  | { kind: 'resolved'; model: ResolvedModel; key: string }
  | { kind: 'ref'; ref: string; key: string }

/**
 * Builds the ordered candidate list. A non-empty `chain` is authoritative: it already encodes the
 * caller's chosen order, so `primary` and `defaults` are not appended (falling through to a model
 * nobody picked would trade a visible failure for a silent one). An empty chain counts as absent.
 */
export function buildChainCandidates(input: {
  chain?: ResolvedModel[]
  primary?: ResolvedModel | string
  defaults?: string[]
}): ChainCandidate[] {
  if (input.chain && input.chain.length > 0) return chainCandidates(input.chain)
  return primaryAndDefaultCandidates(input.primary, input.defaults ?? [])
}

/** An explicit chain, de-duplicated on entry identity: one credential appears once per model it serves. */
function chainCandidates(chain: ResolvedModel[]): ChainCandidate[] {
  const candidates: ChainCandidate[] = []
  const seenEntries = new Set<string>()
  for (const model of chain) {
    const key = breakerKeyFor(model)
    const entryId = `${key}|${modelKeyFor(model)}`
    if (seenEntries.has(entryId)) continue
    seenEntries.add(entryId)
    candidates.push({ kind: 'resolved', model, key })
  }
  return candidates
}

/** The primary, then the defaults that are not already the primary. */
function primaryAndDefaultCandidates(
  primary: ResolvedModel | string | undefined,
  defaults: string[]
): ChainCandidate[] {
  const candidates: ChainCandidate[] = []
  const seenKeys = new Set<string>()
  if (typeof primary === 'string') {
    if (primary) {
      candidates.push({ kind: 'ref', ref: primary, key: primary })
      seenKeys.add(primary)
    }
  } else if (primary) {
    const key = breakerKeyFor(primary)
    candidates.push({ kind: 'resolved', model: primary, key })
    seenKeys.add(key)
  }

  for (const ref of defaults) {
    if (!ref || seenKeys.has(ref)) continue
    candidates.push({ kind: 'ref', ref, key: ref })
    seenKeys.add(ref)
  }
  return candidates
}

export interface FallbackEvent {
  fromModel: string
  toModel: string
  error: unknown
  errorClass: ErrorClass
}

export interface ChainAttempt {
  model: ResolvedModel
  key: string
  isFallback: boolean
  /** Call once a tool has run: the chain will not fall back after that, so side effects are not repeated. */
  markToolsExecuted(): void
}

export interface ModelChainOptions {
  breaker?: CircuitBreaker
  /** Required when a candidate is a `ref`. */
  resolver?: ModelResolver
  abortSignal?: AbortSignal
  /** Exceptions thrown or rejected by the handler are swallowed (logged as a warning); it is not awaited. */
  onFallback?: (event: FallbackEvent) => unknown
  logger?: Logger
}

/**
 * Runs `attempt` against each candidate in order until one succeeds. Each candidate is guarded by a
 * per-credential circuit breaker; a retryable failure, or a candidate that cannot be attempted (missing provider
 * package, config error, open breaker), moves on to the next candidate; anything else, any failure after tools ran
 * and any caller abort is thrown. An exhausted chain rethrows the last error.
 */
export async function runModelChain<T>(
  candidates: ChainCandidate[],
  attempt: (a: ChainAttempt) => Promise<T>,
  options: ModelChainOptions = {}
): Promise<{ result: T; model: ResolvedModel; key: string }> {
  const { breaker, resolver, abortSignal, logger } = options
  assertResolverPresent(candidates, resolver)

  let lastError: unknown
  let hasError = false
  let attempted = 0

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]

    // Acquired synchronously, before the first await of this attempt, so concurrent callers
    // cannot both claim the same half-open probe slot.
    const acquired = acquireCandidate(candidate, breaker, logger)
    if (!acquired) continue
    const { permit } = acquired

    try {
      const model = await resolveCandidate(candidate, resolver)
      attempted++
      let toolsExecuted = false
      try {
        const result = await attempt({
          model,
          key: candidate.key,
          isFallback: attempted > 1,
          markToolsExecuted: () => {
            toolsExecuted = true
          },
        })
        permit?.success()
        return { result, model, key: candidate.key }
      } catch (error) {
        lastError = error
        hasError = true
        const classification = classifyError(error, abortSignal)
        settlePermitAfterFailure(permit, classification.countsAsFailure, error)

        const next = fallbackTarget({
          candidate,
          classification,
          toolsExecuted,
          next: nextAvailable(candidates, i + 1, breaker),
          error,
          logger,
        })
        logger?.warn(
          `[model-chain] ${candidate.key} failed with ${classification.errorClass}; falling back to ${next.key}`
        )
        notifyFallback(options.onFallback, logger, {
          fromModel: candidate.key,
          toModel: next.key,
          error,
          errorClass: classification.errorClass,
        })
      }
    } finally {
      // Safety net for every exit path; a no-op once the permit has been settled.
      permit?.release()
    }
  }

  if (hasError) throw lastError
  throw new ProviderUnavailableError('model-chain', 'no candidate model is available')
}

/**
 * The breaker permit for a candidate: `{ permit: null }` when there is no breaker, the permit when it is
 * granted, and `null` when the breaker refuses the candidate (the caller skips it).
 */
function acquireCandidate(
  candidate: ChainCandidate,
  breaker: CircuitBreaker | undefined,
  logger: Logger | undefined
): { permit: BreakerPermit | null } | null {
  if (!breaker) return { permit: null }
  const permit = breaker.acquire(candidate.key)
  if (permit) return { permit }
  logger?.warn(`[model-chain] circuit breaker is not accepting calls for ${candidate.key}, skipping`)
  return null
}

/**
 * The candidate to fall back to. Throws the attempt's own error, after logging why, when the failure
 * may not fall back: a non-retryable failure, a failure after tools ran, or no candidate left.
 */
function fallbackTarget(input: {
  candidate: ChainCandidate
  classification: ErrorClassification
  toolsExecuted: boolean
  next: ChainCandidate | null
  error: unknown
  logger: Logger | undefined
}): ChainCandidate {
  const { candidate, classification, toolsExecuted, next, error, logger } = input
  const canFallBack = classification.kind === 'retryable' || classification.kind === 'skip'
  if (canFallBack && !toolsExecuted && next) return next

  logger?.warn(
    `[model-chain] ${candidate.key} failed with ${classification.errorClass}; not falling back ` +
      `(kind=${classification.kind}, toolsExecuted=${toolsExecuted}, hasNext=${Boolean(next)})`
  )
  throw error
}

/** A ref candidate needs a resolver; a configuration error is raised before any attempt. */
function assertResolverPresent(candidates: ChainCandidate[], resolver?: ModelResolver): void {
  const unresolved = candidates.find((c): c is { kind: 'ref'; ref: string; key: string } => c.kind === 'ref')
  if (unresolved && !resolver) {
    throw new ProviderConfigError('model-chain', `a resolver is required to resolve "${unresolved.ref}"`)
  }
}

function resolveCandidate(candidate: ChainCandidate, resolver?: ModelResolver): Promise<ResolvedModel> {
  return candidate.kind === 'resolved' ? Promise.resolve(candidate.model) : resolver!.resolve(candidate.ref)
}

/** A failure the breaker counts is recorded on the permit; any other failure gives the permit back. */
function settlePermitAfterFailure(permit: BreakerPermit | null, countsAsFailure: boolean, error: unknown): void {
  if (countsAsFailure) permit?.failure(error)
  else permit?.release()
}

/**
 * Hands a fallback to the caller's handler. A throwing or rejecting handler is logged and never
 * changes the outcome of the chain.
 */
function notifyFallback(
  handler: ModelChainOptions['onFallback'],
  logger: Logger | undefined,
  event: FallbackEvent
): void {
  try {
    const pending = handler?.(event)
    if (pending && typeof (pending as PromiseLike<void>).then === 'function') {
      Promise.resolve(pending).catch((handlerError) => {
        logger?.warn(`[model-chain] onFallback handler rejected: ${String(handlerError)}`)
      })
    }
  } catch (handlerError) {
    logger?.warn(`[model-chain] onFallback handler threw: ${String(handlerError)}`)
  }
}

function nextAvailable(
  candidates: ChainCandidate[],
  from: number,
  breaker?: CircuitBreaker
): ChainCandidate | null {
  for (let i = from; i < candidates.length; i++) {
    if (!breaker || breaker.isAvailable(candidates[i].key)) return candidates[i]
  }
  return null
}
