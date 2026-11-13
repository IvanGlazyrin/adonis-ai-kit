import type {
  AgentCostRecord,
  AgentCostSummary,
  Logger,
  ModelPricing,
  TokenUsageDetails,
} from './types.js'
import {
  DEFAULT_MODEL_PRICING,
  computeCost,
  lookupPricing,
  normalizeModelName,
  toSafeTokens,
} from './pricing.js'

export interface CostTrackerOptions {
  pricing?: Record<string, ModelPricing>
  logger?: Logger
  pricingLoader?: () => Promise<Record<string, ModelPricing>>
  /**
   * Maximum number of individual records kept in memory (oldest are evicted first).
   * Aggregates (totals, per-agent, per-model) are maintained incrementally and are NOT
   * affected by eviction. Use `0` to keep aggregates only.
   * Default: 10_000
   */
  maxRecords?: number
  /**
   * Called for every recorded entry, e.g. to persist it to a database. It may be async, but the
   * tracker never awaits it. A thrown error or a rejected promise is logged and never breaks the caller.
   */
  sink?: (record: AgentCostRecord) => void | Promise<void>
}

interface Aggregate {
  tokens: number
  cost: number
  calls: number
  totalDurationMs: number
}

const DEFAULT_MAX_RECORDS = 10_000
const MAX_WARNED_MODELS = 1_000

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function newAggregate(): Aggregate {
  return { tokens: 0, cost: 0, calls: 0, totalDurationMs: 0 }
}

function addTo(agg: Aggregate, record: AgentCostRecord): void {
  agg.tokens += record.totalTokens
  agg.cost += record.costUsd
  agg.calls += 1
  agg.totalDurationMs += record.durationMs
}

/**
 * Tracks token usage and monetary cost per agent, model, and session.
 * Provides aggregations and logging without framework dependencies.
 *
 * All keyed state uses `Map`, so agent/model names such as `__proto__` or `constructor`
 * cannot pollute prototypes. Memory is bounded by `maxRecords`.
 */
export class CostTracker {
  private ring: (AgentCostRecord | undefined)[] = []
  private ringStart = 0
  private ringSize = 0
  private maxRecords: number
  private sink?: (record: AgentCostRecord) => void | Promise<void>

  private byAgent = new Map<string, Aggregate>()
  private byModel = new Map<string, Aggregate>()
  private total: Aggregate = newAggregate()

  private customPricing = new Map<string, ModelPricing>()
  private defaultPricing = new Map<string, ModelPricing>(Object.entries(DEFAULT_MODEL_PRICING))
  private warnedModels = new Set<string>()
  private logger?: Logger
  private pricingLoader?: () => Promise<Record<string, ModelPricing>>

  constructor(opts: CostTrackerOptions = {}) {
    const max = opts.maxRecords ?? DEFAULT_MAX_RECORDS
    if (!Number.isInteger(max) || max < 0) {
      throw new RangeError(`[CostTracker] maxRecords must be a non-negative integer, got ${max}`)
    }
    this.maxRecords = max
    this.sink = opts.sink
    if (opts.pricing) {
      this.setPricing(opts.pricing)
    }
    this.logger = opts.logger
    this.pricingLoader = opts.pricingLoader
  }

  setLogger(logger: Logger): void {
    this.logger = logger
  }

  setPricing(pricing: Record<string, ModelPricing>): void {
    for (const [model, price] of Object.entries(pricing)) {
      this.customPricing.set(model, price)
    }
  }

  registerPricingLoader(loader: () => Promise<Record<string, ModelPricing>>): void {
    this.pricingLoader = loader
  }

  async loadPricing(): Promise<void> {
    if (!this.pricingLoader) return
    try {
      const loaded = await this.pricingLoader()
      this.setPricing(loaded)
    } catch (err) {
      this.logger?.warn?.('[CostTracker] Failed to load dynamic pricing:', err)
    }
  }

  /**
   * Backwards-compatible initialization alias.
   */
  async initFromCatalog(): Promise<void> {
    return this.loadPricing()
  }

  record(entry: Omit<AgentCostRecord, 'costUsd' | 'timestamp'>): number {
    const inputTokens = toSafeTokens(entry.inputTokens)
    const outputTokens = toSafeTokens(entry.outputTokens)
    const details: TokenUsageDetails = {
      cacheReadTokens: toSafeTokens(entry.cacheReadTokens),
      cacheWriteTokens: toSafeTokens(entry.cacheWriteTokens),
      reasoningTokens: toSafeTokens(entry.reasoningTokens),
    }
    const costUsd = this.calculateCost(entry.model, inputTokens, outputTokens, details)

    const record: AgentCostRecord = {
      ...entry,
      agentName: String(entry.agentName || 'unknown'),
      inputTokens,
      outputTokens,
      cacheReadTokens: details.cacheReadTokens,
      cacheWriteTokens: details.cacheWriteTokens,
      reasoningTokens: details.reasoningTokens,
      totalTokens: toSafeTokens(entry.totalTokens) || inputTokens + outputTokens,
      durationMs: toSafeTokens(entry.durationMs),
      costUsd,
      timestamp: Date.now(),
    }

    this.aggregate(record)
    this.store(record)

    if (this.sink) {
      try {
        const pending = this.sink(record)
        // Not awaited: a slow database must not slow down the model call.
        if (isPromiseLike(pending)) {
          Promise.resolve(pending).catch((err) => {
            this.logger?.warn?.('[CostTracker] Sink failed:', err)
          })
        }
      } catch (err) {
        this.logger?.warn?.('[CostTracker] Sink failed:', err)
      }
    }
    return costUsd
  }

  /**
   * Cost in USD. `inputTokens` is the total input (cached included), `outputTokens` the total
   * output (reasoning included); `details` carves cache/reasoning tokens out at their own rates.
   */
  calculateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    details: TokenUsageDetails = {}
  ): number {
    const pricing =
      lookupPricing(model, this.customPricing) ?? lookupPricing(model, this.defaultPricing)

    if (!pricing) {
      const shortModel = normalizeModelName(model)
      if (!this.warnedModels.has(shortModel) && this.warnedModels.size < MAX_WARNED_MODELS) {
        this.warnedModels.add(shortModel)
        this.logger?.warn?.(
          `[CostTracker] Unknown model "${shortModel}" (full: "${model}"). Cost tracking will report $0. Consider configuring pricing.`
        )
      }
      return 0
    }

    return computeCost(pricing, inputTokens, outputTokens, details)
  }

  getByAgent(): Record<string, AgentCostSummary> {
    return Object.fromEntries(
      [...this.byAgent].map(([name, v]) => [
        name,
        {
          tokens: v.tokens,
          cost: v.cost,
          calls: v.calls,
          avgDurationMs: v.calls > 0 ? Math.round(v.totalDurationMs / v.calls) : 0,
          totalDurationMs: v.totalDurationMs,
        },
      ])
    )
  }

  getByModel(): Record<string, { tokens: number; cost: number; calls: number }> {
    return Object.fromEntries(
      [...this.byModel].map(([model, v]) => [
        model,
        { tokens: v.tokens, cost: v.cost, calls: v.calls },
      ])
    )
  }

  getTotalCost(): number {
    return this.total.cost
  }

  getTotalTokens(): number {
    return this.total.tokens
  }

  getTotalCalls(): number {
    return this.total.calls
  }

  /** Most recent records (at most `maxRecords`), oldest first. */
  getRecords(): readonly AgentCostRecord[] {
    const out: AgentCostRecord[] = []
    for (let i = 0; i < this.ringSize; i++) {
      out.push(this.ring[(this.ringStart + i) % this.maxRecords]!)
    }
    return out
  }

  reset(): void {
    this.ring = []
    this.ringStart = 0
    this.ringSize = 0
    this.byAgent.clear()
    this.byModel.clear()
    this.total = newAggregate()
    this.warnedModels.clear()
  }

  toLogString(): string {
    const byAgent = this.getByAgent()
    const lines = Object.entries(byAgent).map(
      ([name, { tokens, cost, calls, avgDurationMs }]) =>
        `  ${name}: ${calls} calls, ${tokens} tokens, $${cost.toFixed(4)}, avg ${avgDurationMs}ms`
    )
    lines.push(
      `  TOTAL: ${this.total.calls} calls, ${this.getTotalTokens()} tokens, $${this.getTotalCost().toFixed(4)}`
    )
    return lines.join('\n')
  }

  private aggregate(record: AgentCostRecord): void {
    addTo(this.total, record)

    let agent = this.byAgent.get(record.agentName)
    if (!agent) this.byAgent.set(record.agentName, (agent = newAggregate()))
    addTo(agent, record)

    const modelKey = normalizeModelName(record.model)
    let model = this.byModel.get(modelKey)
    if (!model) this.byModel.set(modelKey, (model = newAggregate()))
    addTo(model, record)
  }

  private store(record: AgentCostRecord): void {
    if (this.maxRecords === 0) return
    if (this.ringSize < this.maxRecords) {
      this.ring[(this.ringStart + this.ringSize) % this.maxRecords] = record
      this.ringSize++
      return
    }
    this.ring[this.ringStart] = record
    this.ringStart = (this.ringStart + 1) % this.maxRecords
  }
}
