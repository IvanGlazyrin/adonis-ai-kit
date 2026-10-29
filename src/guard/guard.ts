import type { ActionGuard, ExecutionReconciliation } from './types.js'

export interface ParameterRule<T = unknown> {
  field: string
  validate: (value: T, allArgs: Record<string, unknown>) => string | null
}

export interface PolicyGuardOptions {
  maxCalls?: number
  allowedTools?: string[]
  rules?: Record<string, ParameterRule[]>
}

/**
 * Flexible policy guard for constraining tool arguments and invocation counts.
 *
 * `check()` reserves a call slot when it allows a call, so parallel tool calls cannot all pass
 * the `maxCalls` check before any of them is recorded. The slot is turned into a counted call by
 * `record()`, or given back by `release()`.
 */
export class PolicyGuard implements ActionGuard {
  private callCount = 0
  private successfulCalls = 0
  private inFlight = 0
  private maxCalls: number
  private allowedTools?: Set<string>
  private rules: Map<string, ParameterRule[]> = new Map()

  constructor(opts: PolicyGuardOptions = {}) {
    this.maxCalls = opts.maxCalls ?? Infinity
    if (opts.allowedTools) {
      this.allowedTools = new Set(opts.allowedTools)
    }
    if (opts.rules) {
      for (const [tool, rules] of Object.entries(opts.rules)) {
        this.rules.set(tool, [...rules])
      }
    }
  }

  addRule(toolName: string, rule: ParameterRule): this {
    const existing = this.rules.get(toolName) ?? []
    existing.push(rule)
    this.rules.set(toolName, existing)
    return this
  }

  check(toolName: string, args: unknown): string | null {
    const violation =
      this.refuseDisallowedTool(toolName) ??
      this.refuseWhenFull() ??
      this.refuseFailingRule(toolName, args)
    if (violation) return violation

    this.inFlight += 1
    return null
  }

  private refuseDisallowedTool(toolName: string): string | null {
    if (this.allowedTools && !this.allowedTools.has(toolName)) {
      return `Tool "${toolName}" is not permitted by policy`
    }
    return null
  }

  private refuseWhenFull(): string | null {
    if (this.callCount + this.inFlight >= this.maxCalls) {
      return `Maximum allowed calls (${this.maxCalls}) exceeded for policy`
    }
    return null
  }

  /** Runs the tool's parameter rules; the first violation wins. Fail-closed on non-object arguments. */
  private refuseFailingRule(toolName: string, args: unknown): string | null {
    const toolRules = this.rules.get(toolName)
    if (!toolRules || toolRules.length === 0) return null

    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return `Arguments for "${toolName}" must be an object to be validated by policy`
    }
    const record = args as Record<string, unknown>
    for (const rule of toolRules) {
      const violation = rule.validate(record[rule.field], record)
      if (violation) return violation
    }
    return null
  }

  record(_toolName: string, result: unknown): void {
    this.inFlight = Math.max(0, this.inFlight - 1)
    this.callCount += 1
    if (
      result &&
      typeof result === 'object' &&
      'error' in result &&
      (result as { error: unknown }).error
    ) {
      // Failed call
      return
    }
    this.successfulCalls += 1
  }

  release(_toolName: string): void {
    this.inFlight = Math.max(0, this.inFlight - 1)
  }

  get totalCalls(): number {
    return this.callCount
  }

  get acceptedCalls(): number {
    return this.successfulCalls
  }

  summary(): Record<string, unknown> {
    return {
      totalCalls: this.callCount,
      acceptedCalls: this.successfulCalls,
      maxCalls: this.maxCalls,
    }
  }
}

/**
 * Reconciles the number of claims made by an LLM with the verified executions in the guard.
 */
export function reconcileExecutionClaims(
  claimedCount: unknown,
  guard?: ActionGuard
): ExecutionReconciliation {
  const parsed = Number(claimedCount ?? 0)
  const claimed = Number.isFinite(parsed) ? parsed : 0
  const summary = guard?.summary?.()
  const verified = typeof summary?.acceptedCalls === 'number' ? summary.acceptedCalls : 0

  return {
    claimed,
    verified,
    mismatch: claimed !== verified,
  }
}

/**
 * Creates a numeric range validation rule.
 * Only real numbers (or numeric strings) pass: `''`, `null`, booleans and arrays are rejected.
 */
export function rangeRule(
  field: string,
  min: number,
  max: number,
  label: string = field
): ParameterRule<unknown> {
  return {
    field,
    validate: (val) => {
      const isNumeric =
        typeof val === 'number' || (typeof val === 'string' && val.trim() !== '')
      const num = isNumeric ? Number(val) : Number.NaN
      if (!Number.isFinite(num)) {
        return `${label} must be a valid number`
      }
      if (num < min || num > max) {
        return `${label} ${num} is out of permitted range [${min}, ${max}]`
      }
      return null
    },
  }
}

/**
 * Creates an allowed values enum validation rule.
 */
export function enumRule<T extends string>(
  field: string,
  allowed: readonly T[],
  label: string = field
): ParameterRule<unknown> {
  return {
    field,
    validate: (val) => {
      if (typeof val !== 'string' || !allowed.includes(val as T)) {
        return `${label} "${String(val)}" is not allowed. Permitted: ${allowed.join(', ')}`
      }
      return null
    },
  }
}
