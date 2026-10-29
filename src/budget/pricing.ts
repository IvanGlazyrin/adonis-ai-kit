import type { ModelPricing, TokenUsageDetails } from './types.js'

/**
 * Default pricing catalog for popular LLM models (USD per 1M tokens).
 *
 * Prices drift: treat this table as a fallback and prefer `CostTracker.setPricing()` /
 * `registerPricingLoader()` (e.g. backed by models.dev) for authoritative values.
 *
 * This is an offline fallback, not a source of truth. With `catalog.autoPricing` on (the default),
 * models.dev prices are loaded at runtime and take priority over this table. Do not add new models
 * here; a model with no price anywhere is costed at $0 with a one-time warning.
 */
export const DEFAULT_MODEL_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  // OpenAI
  'gpt-4.1': { input: 2.0, output: 8.0, cacheReadCostPer1M: 0.5 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cacheReadCostPer1M: 0.1 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4, cacheReadCostPer1M: 0.025 },
  'gpt-4o': { input: 2.5, output: 10.0, cacheReadCostPer1M: 1.25 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheReadCostPer1M: 0.075 },
  'gpt-4-turbo': { input: 10.0, output: 30.0 },
  'o1': { input: 15.0, output: 60.0, cacheReadCostPer1M: 7.5 },
  'o1-mini': { input: 1.1, output: 4.4, cacheReadCostPer1M: 0.55 },
  'o3': { input: 2.0, output: 8.0, cacheReadCostPer1M: 0.5 },
  'o3-mini': { input: 1.1, output: 4.4, cacheReadCostPer1M: 0.55 },
  'o4-mini': { input: 1.1, output: 4.4, cacheReadCostPer1M: 0.275 },

  // Anthropic (cache read = 0.1x input, 5-minute cache write = 1.25x input)
  'claude-opus-4-1': { input: 15.0, output: 75.0, cacheReadCostPer1M: 1.5, cacheWriteCostPer1M: 18.75 },
  'claude-opus-4': { input: 15.0, output: 75.0, cacheReadCostPer1M: 1.5, cacheWriteCostPer1M: 18.75 },
  'claude-sonnet-4-5': { input: 3.0, output: 15.0, cacheReadCostPer1M: 0.3, cacheWriteCostPer1M: 3.75 },
  'claude-sonnet-4': { input: 3.0, output: 15.0, cacheReadCostPer1M: 0.3, cacheWriteCostPer1M: 3.75 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheReadCostPer1M: 0.1, cacheWriteCostPer1M: 1.25 },
  'claude-3-7-sonnet': { input: 3.0, output: 15.0, cacheReadCostPer1M: 0.3, cacheWriteCostPer1M: 3.75 },
  'claude-3-5-sonnet': { input: 3.0, output: 15.0, cacheReadCostPer1M: 0.3, cacheWriteCostPer1M: 3.75 },
  'claude-3-5-haiku': { input: 0.8, output: 4.0, cacheReadCostPer1M: 0.08, cacheWriteCostPer1M: 1.0 },
  'claude-haiku-3.5': { input: 0.8, output: 4.0, cacheReadCostPer1M: 0.08, cacheWriteCostPer1M: 1.0 },
  'claude-3-opus': { input: 15.0, output: 75.0, cacheReadCostPer1M: 1.5, cacheWriteCostPer1M: 18.75 },

  // Google (prices for prompts <= 200k tokens; reasoning is billed as output)
  'gemini-2.5-pro': { input: 1.25, output: 10.0, cacheReadCostPer1M: 0.31 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheReadCostPer1M: 0.075 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4, cacheReadCostPer1M: 0.025 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4, cacheReadCostPer1M: 0.025 },
  'gemini-2.0-flash-lite': { input: 0.075, output: 0.3 },
  'gemini-1.5-pro': { input: 1.25, output: 5.0 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },

  // Groq / Open-source / Meta
  'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
  'llama-3.3-70b': { input: 0.59, output: 0.79 },
  'llama-3.1-70b': { input: 0.59, output: 0.79 },
  'llama-3.1-8b': { input: 0.05, output: 0.08 },

  // DeepSeek
  'deepseek-chat': { input: 0.14, output: 0.28 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
} satisfies Record<string, ModelPricing>)

/**
 * Extracts normalized model name (removes provider prefix like 'openai/gpt-4o' -> 'gpt-4o').
 */
export function normalizeModelName(model: string): string {
  if (!model) return ''
  return model.split('/').pop() ?? model
}

/**
 * Candidate pricing keys for a model id, from most to least specific:
 * `claude-3-7-sonnet-20250219` -> `claude-3-7-sonnet`, `gpt-4o-2024-08-06` -> `gpt-4o`,
 * `claude-3-7-sonnet-latest` -> `claude-3-7-sonnet`.
 */
export function pricingKeyCandidates(model: string): string[] {
  const short = normalizeModelName(model)
  const candidates = [model, short]
  const stripped = short
    .replace(/-latest$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/@\d{8}$/, '')
  if (stripped !== short) candidates.push(stripped)
  return [...new Set(candidates.filter(Boolean))]
}

/**
 * Looks up pricing in `table`, tolerating dated/`-latest` variants of a known model.
 * Uses own-property lookups only, so keys like `__proto__` or `constructor` never match.
 */
export function lookupPricing(
  model: string,
  table: ReadonlyMap<string, ModelPricing> | Readonly<Record<string, ModelPricing>>
): ModelPricing | undefined {
  const get = (key: string): ModelPricing | undefined =>
    table instanceof Map
      ? table.get(key)
      : Object.hasOwn(table, key)
        ? (table as Record<string, ModelPricing>)[key]
        : undefined

  const candidates = pricingKeyCandidates(model)
  for (const key of candidates) {
    const hit = get(key)
    if (hit) return hit
  }

  // Longest known key that is a dash-delimited prefix of the model (e.g. `gpt-4.1-2025-04-14`).
  const short = candidates[candidates.length - 1]
  const keys = table instanceof Map ? [...table.keys()] : Object.keys(table)
  let best: string | undefined
  for (const key of keys) {
    if (short.startsWith(`${key}-`) && (!best || key.length > best.length)) best = key
  }
  return best ? get(best) : undefined
}

/** Coerces untrusted numbers (NaN, Infinity, negatives, non-numbers) to a safe non-negative value. */
export function toSafeTokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Computes USD cost for a call.
 *
 * `inputTokens` is the total input (cache reads/writes included) and `outputTokens` is the total
 * output (reasoning included), matching the AI SDK usage convention. Cached tokens are billed at
 * their dedicated rates and removed from the regular input charge; reasoning tokens are billed at
 * `reasoningCostPer1M` when set, otherwise at the output rate.
 */
export function computeCost(
  pricing: ModelPricing,
  inputTokens: number,
  outputTokens: number,
  details: TokenUsageDetails = {}
): number {
  const input = toSafeTokens(inputTokens)
  const output = toSafeTokens(outputTokens)
  const cacheRead = Math.min(toSafeTokens(details.cacheReadTokens), input)
  const cacheWrite = Math.min(toSafeTokens(details.cacheWriteTokens), input - cacheRead)
  const reasoning = Math.min(toSafeTokens(details.reasoningTokens), output)

  const cacheReadRate = pricing.cacheReadCostPer1M ?? pricing.cacheRead ?? pricing.input
  const cacheWriteRate = pricing.cacheWriteCostPer1M ?? pricing.cacheWrite ?? pricing.input
  const reasoningRate = pricing.reasoningCostPer1M ?? pricing.output

  const plainInput = input - cacheRead - cacheWrite
  const plainOutput = output - reasoning

  const total =
    plainInput * pricing.input +
    cacheRead * cacheReadRate +
    cacheWrite * cacheWriteRate +
    plainOutput * pricing.output +
    reasoning * reasoningRate

  return total / 1_000_000
}
