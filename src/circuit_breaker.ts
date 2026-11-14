import { ProviderUnavailableError } from './errors.js'
import type { CircuitBreakerConfig, CircuitBreakerState, CircuitBreakerStats } from './types.js'

interface InternalStats {
  state: CircuitBreakerState
  failures: number
  successes: number
  inFlightProbes: number
  /** Bumped on every state change and reset; a permit from an older epoch no longer owns a probe slot. */
  epoch: number
  lastFailureTime: number | null
  nextAttemptAllowedAt: number | null
}

const DEFAULT_MAX_KEYS = 10_000

/**
 * A reservation obtained from `CircuitBreaker.acquire()`. It settles exactly once: after the first
 * `success()`, `failure()` or `release()`, further calls do nothing.
 */
export interface BreakerPermit {
  readonly key: string
  /** True when this permit occupies a half-open probe slot. */
  readonly isProbe: boolean
  /** Records a success (`recordSuccess`) and frees the probe slot. */
  success(): void
  /** Records a failure (`recordFailure`) and frees the probe slot. */
  failure(error?: unknown): void
  /** Frees the probe slot without recording anything (the outcome does not count). */
  release(): void
}

/**
 * Resilient Circuit Breaker to prevent cascading failures of upstream LLM APIs.
 * Supports CLOSED, OPEN, and HALF_OPEN state transitions.
 *
 * State is tracked per breaker key. `AiManager` uses `provider:model`, so one misbehaving model
 * does not take the whole provider down. A plain provider name works as a key too.
 */
export class CircuitBreaker {
  /** Insertion order is the recency order: the first entry is the least recently touched. */
  private stats: Map<string, InternalStats> = new Map()
  private failureThreshold: number
  private recoveryTimeoutMs: number
  private halfOpenMaxAttempts: number
  private halfOpenMaxConcurrent: number
  private maxKeys: number
  private onStateChange?: (key: string, from: CircuitBreakerState, to: CircuitBreakerState) => void

  constructor(config: CircuitBreakerConfig = {}) {
    this.failureThreshold = Math.max(1, config.failureThreshold ?? 5)
    this.recoveryTimeoutMs = Math.max(0, config.recoveryTimeoutMs ?? 30_000)
    this.halfOpenMaxAttempts = Math.max(1, config.halfOpenMaxAttempts ?? 2)
    this.halfOpenMaxConcurrent = Math.max(1, config.halfOpenMaxConcurrent ?? 1)
    this.maxKeys =
      Number.isInteger(config.maxKeys) && config.maxKeys! >= 1 ? config.maxKeys! : DEFAULT_MAX_KEYS
    this.onStateChange = config.onStateChange
  }

  private newStats(): InternalStats {
    return {
      state: 'closed',
      failures: 0,
      successes: 0,
      inFlightProbes: 0,
      epoch: 0,
      lastFailureTime: null,
      nextAttemptAllowedAt: null,
    }
  }

  /**
   * Returns the entry for `key`, creating it when missing, and marks it as the most recently used.
   * Only the calls that change or reserve state touch a key; read-only calls never do.
   */
  private touch(key: string): InternalStats {
    const existing = this.stats.get(key)
    if (existing) {
      this.stats.delete(key)
      this.stats.set(key, existing)
      return existing
    }
    const created = this.newStats()
    this.stats.set(key, created)
    // Only a new key can push the map over the limit, so only then is there something to evict.
    if (this.stats.size > this.maxKeys) this.evict(key)
    return created
  }

  /**
   * Drops the least recently used healthy keys until the map fits `maxKeys`. A key that is open,
   * half-open, has failures or has a probe in flight is kept, so the map may stay above the limit
   * while every key is unhealthy.
   */
  private evict(keep: string): void {
    for (const [key, s] of this.stats) {
      if (this.stats.size <= this.maxKeys) return
      if (key === keep) continue
      if (s.state === 'closed' && s.failures === 0 && s.inFlightProbes === 0) this.stats.delete(key)
    }
  }

  getState(key: string): CircuitBreakerState {
    const s = this.stats.get(key)
    if (!s) return 'closed'
    if (s.state === 'open' && s.nextAttemptAllowedAt !== null && Date.now() >= s.nextAttemptAllowedAt) {
      this.transition(key, s, 'half_open')
    }
    return s.state
  }

  /** Non-acquiring availability check (a half-open breaker is available while probe slots remain). */
  isAvailable(key: string): boolean {
    const state = this.getState(key)
    if (state === 'closed') return true
    if (state === 'half_open') {
      return (this.stats.get(key)?.inFlightProbes ?? 0) < this.halfOpenMaxConcurrent
    }
    return false
  }

  /**
   * Synchronously reserves a call slot. Returns `null` when the breaker is open or every half-open
   * probe slot is taken. Unlike `isAvailable()`, a half-open permit holds a probe slot until settled.
   */
  acquire(key: string): BreakerPermit | null {
    const s = this.touch(key)
    const state = this.getState(key)
    if (state === 'open') return null

    const isProbe = state === 'half_open'
    if (isProbe) {
      if (s.inFlightProbes >= this.halfOpenMaxConcurrent) return null
      s.inFlightProbes++
    }

    const epoch = s.epoch
    let settled = false
    const settle = (): boolean => {
      if (settled) return false
      settled = true
      if (isProbe && s.epoch === epoch) s.inFlightProbes = Math.max(0, s.inFlightProbes - 1)
      return true
    }

    return {
      key,
      isProbe,
      success: () => {
        if (settle()) this.recordSuccess(key)
      },
      failure: (error?: unknown) => {
        if (settle()) this.recordFailure(key, error)
      },
      release: () => {
        settle()
      },
    }
  }

  /**
   * Runs `action` through the breaker.
   *
   * `isFailure` decides whether a thrown error counts against the breaker; errors that are the
   * caller's fault (bad request, abort, validation) should not trip it.
   */
  async execute<T>(
    key: string,
    action: () => Promise<T>,
    isFailure: (error: unknown) => boolean = () => true
  ): Promise<T> {
    const permit = this.acquire(key)

    if (!permit) {
      if (this.getState(key) === 'open') {
        const s = this.stats.get(key)
        const remainingMs = s?.nextAttemptAllowedAt
          ? Math.max(0, s.nextAttemptAllowedAt - Date.now())
          : this.recoveryTimeoutMs
        throw new ProviderUnavailableError(
          key,
          `Circuit breaker is OPEN. Cooldown remaining: ${Math.ceil(remainingMs / 1000)}s`
        )
      }
      throw new ProviderUnavailableError(key, 'Circuit breaker is HALF-OPEN and probe limit is reached')
    }

    try {
      const result = await action()
      permit.success()
      return result
    } catch (error) {
      if (isFailure(error)) permit.failure(error)
      else permit.release()
      throw error
    } finally {
      // Covers a throwing `isFailure`; a no-op once the permit has been settled.
      permit.release()
    }
  }

  recordSuccess(key: string): void {
    const s = this.touch(key)
    if (s.state === 'half_open') {
      s.successes++
      if (s.successes >= this.halfOpenMaxAttempts) {
        s.failures = 0
        s.successes = 0
        s.lastFailureTime = null
        s.nextAttemptAllowedAt = null
        this.transition(key, s, 'closed')
      }
    } else if (s.state === 'closed') {
      s.failures = 0
    }
  }

  recordFailure(key: string, _error?: unknown): void {
    const s = this.touch(key)
    s.lastFailureTime = Date.now()

    if (s.state === 'closed') {
      s.failures++
      if (s.failures >= this.failureThreshold) {
        this.open(key, s)
      }
    } else if (s.state === 'half_open') {
      this.open(key, s)
    }
  }

  reset(key: string): void {
    const s = this.stats.get(key)
    if (!s) return
    const prev = s.state
    s.failures = 0
    s.successes = 0
    s.inFlightProbes = 0
    s.epoch++
    s.lastFailureTime = null
    s.nextAttemptAllowedAt = null
    this.transition(key, s, 'closed', prev)
  }

  resetAll(): void {
    for (const key of [...this.stats.keys()]) this.reset(key)
  }

  getStats(key: string): CircuitBreakerStats {
    const s = this.stats.get(key) ?? this.newStats()
    const state = this.getState(key)
    return {
      state,
      failures: s.failures,
      successes: s.successes,
      lastFailureTime: s.lastFailureTime,
      nextAttemptAllowedAt: s.nextAttemptAllowedAt,
    }
  }

  getAllStats(): Record<string, CircuitBreakerStats> {
    return Object.fromEntries([...this.stats.keys()].map((key) => [key, this.getStats(key)]))
  }

  /**
   * Moves to OPEN with a fresh counter set. All state is written BEFORE the user callback runs,
   * so a throwing `onStateChange` can never leave the breaker without a cooldown deadline.
   */
  private open(key: string, s: InternalStats): void {
    s.successes = 0
    s.inFlightProbes = 0
    s.nextAttemptAllowedAt = Date.now() + this.recoveryTimeoutMs
    this.transition(key, s, 'open')
  }

  private transition(
    key: string,
    stats: InternalStats,
    to: CircuitBreakerState,
    from: CircuitBreakerState = stats.state
  ): void {
    if (from === to) return
    stats.state = to
    stats.epoch++
    if (to === 'half_open') {
      stats.successes = 0
      stats.inFlightProbes = 0
    }
    try {
      this.onStateChange?.(key, from, to)
    } catch {
      // A faulty observer must not break request handling or leave the breaker inconsistent.
    }
  }
}
