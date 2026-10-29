import { test } from '@japa/runner'
import { BudgetEnforcer } from '../../../src/budget/budget_enforcer.js'

test.group('BudgetEnforcer limits', () => {
  test('limits must be non-negative numbers, and Infinity means unlimited', ({ assert }) => {
    assert.throws(() => new BudgetEnforcer({ perAgentMaxTokens: -1 }), /perAgentMaxTokens must be a number >= 0/)
    assert.throws(() => new BudgetEnforcer({ perSessionMaxCostUsd: Number.NaN }), /perSessionMaxCostUsd/)
    assert.doesNotThrow(() => new BudgetEnforcer({ perAgentMaxCostUsd: Infinity }))
  })

  test('the agent may continue only while usage stays strictly below its limit', ({ assert }) => {
    const enforcer = new BudgetEnforcer({ perAgentMaxTokens: 100, perSessionMaxTokens: 1_000 })

    enforcer.recordAgentUsage('a', 99)
    assert.isTrue(enforcer.canAgentContinue('a'))
    enforcer.recordAgentUsage('a', 1)
    assert.isFalse(enforcer.canAgentContinue('a'))
  })

  test('projected amounts count toward the check', ({ assert }) => {
    const enforcer = new BudgetEnforcer({ perSessionMaxTokens: 100 })

    assert.isTrue(enforcer.canSessionContinue(99))
    assert.isFalse(enforcer.canSessionContinue(100))
  })

  test('applyAllocation and the limit setters replace the limits', ({ assert }) => {
    const enforcer = new BudgetEnforcer({ perAgentMaxTokens: 10 })
    enforcer.applyAllocation({ perAgent: 500, perSession: 900, modifiers: [], totalModifierPct: 0, reason: '' })
    enforcer.setTokenLimits({ perAgentMaxTokens: 600 })
    enforcer.setCostLimits({ perAgentMaxCostUsd: 2 })

    assert.isTrue(enforcer.canAgentContinue('a', 599))
    assert.isFalse(enforcer.canAgentContinue('a', 600))
    assert.isTrue(enforcer.canAgentContinue('a', 0, 1.99))
    assert.isFalse(enforcer.canAgentContinue('a', 0, 2))
  })
})

test.group('BudgetEnforcer reservations', () => {
  test('a reservation counts against the budget until it is settled or released', ({ assert }) => {
    const enforcer = new BudgetEnforcer({ perAgentMaxTokens: 100, perSessionMaxTokens: 100 })

    const first = enforcer.reserve('a', 80)
    assert.isNotNull(first)
    assert.isNull(enforcer.reserve('a', 30), 'the held 80 leaves too little for 30 more')
    assert.isNull(enforcer.reserve('b', 30), 'the session is held too')
  })

  test('the session limit blocks a different agent that is itself within budget', ({ assert }) => {
    const enforcer = new BudgetEnforcer({ perAgentMaxTokens: 1_000, perSessionMaxTokens: 100 })
    enforcer.recordAgentUsage('a', 90)

    assert.isNull(enforcer.reserve('b', 20))
    assert.isNotNull(enforcer.reserve('b', 5))
  })

  test('settle records the actual usage, frees the hold, and can run only once', ({ assert }) => {
    const enforcer = new BudgetEnforcer({ perAgentMaxTokens: 100, perSessionMaxTokens: 100 })
    const reservation = enforcer.reserve('a', 80)!

    enforcer.settle(reservation, 30)
    enforcer.settle(reservation, 500)

    assert.equal(enforcer.getAgentTokensUsed('a'), 30)
    assert.equal(enforcer.getSessionTokensUsed(), 30)
    assert.isNotNull(enforcer.reserve('a', 69))
  })

  test('release frees the hold without recording usage, and can run only once', ({ assert }) => {
    const enforcer = new BudgetEnforcer({ perAgentMaxTokens: 100, perSessionMaxTokens: 100 })
    const reservation = enforcer.reserve('a', 80)!

    enforcer.release(reservation)
    enforcer.release(reservation)

    assert.equal(enforcer.getAgentTokensUsed('a'), 0)
    assert.isNotNull(enforcer.reserve('a', 99))
  })

  test('invalid projected amounts are treated as zero', ({ assert }) => {
    const enforcer = new BudgetEnforcer({ perAgentMaxTokens: 10, perSessionMaxTokens: 10 })
    const reservation = enforcer.reserve('a', Number.NaN)

    assert.equal(reservation?.tokens, 0)
  })

  test('cost is reserved and settled alongside tokens', ({ assert }) => {
    const enforcer = new BudgetEnforcer({ perSessionMaxCostUsd: 1 })
    const reservation = enforcer.reserve('a', 0, 0.75)!

    assert.isNull(enforcer.reserve('a', 0, 0.5))
    enforcer.settle(reservation, 0, 0.25)
    assert.closeTo(enforcer.getSessionCostUsd(), 0.25, 1e-9)
    assert.isNotNull(enforcer.reserve('a', 0, 0.5))
  })
})

test.group('BudgetEnforcer summary', () => {
  test('the log line names the session and shows no per-agent lines before any usage', ({ assert }) => {
    const line = new BudgetEnforcer({ perSessionMaxTokens: 200, perSessionMaxCostUsd: 1 }).toLogString()

    assert.equal(line, 'Session: 0/200 tokens (0.0%) | Cost: $0.0000 / $1.0000 USD (0.0%)')
  })

  test('the log line reports usage percentages and each agent', ({ assert }) => {
    const enforcer = new BudgetEnforcer({ perSessionMaxTokens: 200, perSessionMaxCostUsd: 1 })
    enforcer.recordAgentUsage('writer', 50, 0.25)

    assert.equal(
      enforcer.toLogString(),
      'Session: 50/200 tokens (25.0%) | Cost: $0.2500 / $1.0000 USD (25.0%)\nPer-agent:\n  writer: 50 tokens ($0.2500 USD)'
    )
  })

  test('an unlimited cost is shown as unlimited with no percentage', ({ assert }) => {
    const line = new BudgetEnforcer({ perSessionMaxTokens: 100 }).toLogString()

    assert.equal(line, 'Session: 0/100 tokens (0.0%) | Cost: $0.0000 / unlimited USD')
  })

  test('a zero token limit shows 0.0% instead of dividing by zero', ({ assert }) => {
    assert.include(new BudgetEnforcer({ perSessionMaxTokens: 0 }).toLogString(), '(0.0%)')
  })
})
