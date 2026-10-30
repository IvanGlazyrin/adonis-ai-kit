import type { StopCondition, StepResult, ToolSet } from 'ai'
import type { CostTracker } from './cost_tracker.js'

export interface StopOnBudgetLimits {
  /** Stop once the tool loop has used more than this many tokens in total (all steps). */
  maxTokens?: number
  /** Stop once the tool loop has cost more than this many USD in total (all steps), priced by the cost tracker. */
  maxCostUsd?: number
}

/** Tokens and USD spent outside this tool loop, for example by sub-agents (see `SubAgentSpend`). */
export interface BudgetSpend {
  tokens(): number
  costUsd(): number
}

export interface StopOnBudgetOptions {
  /** Added to the loop's own totals. Without it the condition counts only the loop's steps. */
  extra?: BudgetSpend
}

/**
 * A `stopWhen` condition for `generateText` / `streamText` that ends the tool loop after the step that exceeds a
 * limit. Tokens are summed from each step's usage; cost is priced per step by the model that ran it, using the
 * cost tracker's pricing table. Pass it as `stopWhen`, with `maxSteps` as the upper bound.
 */
export function stopOnBudget(
  limits: StopOnBudgetLimits,
  costTracker: CostTracker,
  options: StopOnBudgetOptions = {}
): StopCondition<ToolSet> {
  return ({ steps }: { steps: Array<StepResult<ToolSet>> }) => {
    let tokens = options.extra?.tokens() ?? 0
    let costUsd = options.extra?.costUsd() ?? 0
    for (const step of steps) {
      const input = step.usage.inputTokens ?? 0
      const output = step.usage.outputTokens ?? 0
      tokens += step.usage.totalTokens ?? input + output
      costUsd += costTracker.calculateCost(step.model.modelId, input, output, {
        cacheReadTokens: step.usage.inputTokenDetails?.cacheReadTokens ?? 0,
        cacheWriteTokens: step.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
        reasoningTokens: step.usage.outputTokenDetails?.reasoningTokens ?? 0,
      })
    }
    if (limits.maxTokens !== undefined && tokens > limits.maxTokens) return true
    if (limits.maxCostUsd !== undefined && costUsd > limits.maxCostUsd) return true
    return false
  }
}
