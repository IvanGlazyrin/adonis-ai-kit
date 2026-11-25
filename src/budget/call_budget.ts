import type { StepResult, StopCondition, ToolSet } from 'ai'
import type { BudgetEnforcer, BudgetReservation } from './budget_enforcer.js'
import type { CostTracker } from './cost_tracker.js'
import { loopSpend } from './stop_condition.js'

/** A model call checked and charged against a `BudgetEnforcer` (pass it as the call's `budget`). */
export interface CallBudget {
  enforcer: BudgetEnforcer
  /** The budget row the call is charged to. Default: the call's `agentName`. */
  agentName?: string
  /**
   * Held for the duration of the call, so concurrent calls cannot overspend together. Default 0: the call is refused
   * only when the budget is already used up.
   */
  projectedTokens?: number
  projectedCostUsd?: number
}

/**
 * One call's hold on a budget: the reservation taken before the model is called, the spend of every attempt, and the
 * settlement when the call ends. Used by `AiManager`; usable on its own around any model call.
 */
export class CallBudgetHold {
  private tokens = 0
  private costUsd = 0
  private closed = false

  private constructor(
    private readonly budget: CallBudget,
    readonly agentName: string,
    private readonly reservation: BudgetReservation
  ) {}

  /** Reserves the projected amounts, or returns `null` when the agent or the session has no budget left. */
  static open(budget: CallBudget, agentName: string): CallBudgetHold | null {
    const name = budget.agentName ?? agentName
    const reservation = budget.enforcer.reserve(name, budget.projectedTokens ?? 0, budget.projectedCostUsd ?? 0)
    return reservation ? new CallBudgetHold(budget, name, reservation) : null
  }

  /** Adds the spend of one attempt (a failed attempt still used tokens). */
  add(tokens: number, costUsd = 0): void {
    this.tokens += Math.max(0, tokens)
    this.costUsd += Math.max(0, costUsd)
  }

  /** Replaces the reservation with the actual spend, or frees it when nothing was spent. Runs once. */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.tokens > 0) this.budget.enforcer.settle(this.reservation, this.tokens, this.costUsd)
    else this.budget.enforcer.release(this.reservation)
  }

  /**
   * Ends the tool loop after the step that uses up the agent's or the session's budget. The steps' spend beyond the
   * reserved amounts is checked, so the reservation is not counted twice.
   */
  stopCondition(costTracker: CostTracker): StopCondition<ToolSet> {
    return ({ steps }: { steps: Array<StepResult<ToolSet>> }) => {
      const spend = loopSpend(steps, costTracker)
      const extraTokens = Math.max(0, this.tokens + spend.tokens - (this.budget.projectedTokens ?? 0))
      const extraCost = Math.max(0, this.costUsd + spend.costUsd - (this.budget.projectedCostUsd ?? 0))
      const enforcer = this.budget.enforcer
      return !enforcer.canAgentContinue(this.agentName, extraTokens, extraCost) || !enforcer.canSessionContinue(extraTokens, extraCost)
    }
  }
}
