import { test } from '@japa/runner'
import { BudgetAllocator, atLeastRule, equalsRule } from '../../../src/budget/budget_allocator.js'

test.group('BudgetAllocator', () => {
  test('with no modifiers the defaults are allocated as the base', ({ assert }) => {
    const alloc = new BudgetAllocator().compute()

    assert.equal(alloc.perAgent, 50_000)
    assert.equal(alloc.perSession, 200_000)
    assert.deepEqual(alloc.modifiers, [])
    assert.equal(alloc.totalModifierPct, 0)
    assert.equal(alloc.reason, 'base allocation (no modifiers)')
  })

  test('non-finite settings fall back to defaults and negative bases clamp to zero', ({ assert }) => {
    const bases = new BudgetAllocator({ basePerAgent: Number.NaN, maxPerAgent: Infinity })
    assert.equal(bases.compute().perAgent, 50_000)

    const negative = new BudgetAllocator({ basePerAgent: -5, basePerSession: -1 })
    assert.equal(negative.compute().perAgent, 0)
    assert.equal(negative.compute().perSession, 0)
  })

  test('a minimum modifier above the maximum is rejected', ({ assert }) => {
    assert.throws(
      () => new BudgetAllocator({ minModifierPct: 10, maxModifierPct: -10 }),
      /minModifierPct must be <= maxModifierPct/
    )
  })

  test('explicit modifiers come before rule modifiers and add up', ({ assert }) => {
    const alloc = new BudgetAllocator<{ tier: string }>()
      .addRule(equalsRule('tier', 'pro', 20))
      .compute({ tier: 'pro' }, [{ factor: 'custom', pctChange: 10 }])

    assert.equal(alloc.totalModifierPct, 30)
    assert.equal(alloc.perAgent, 65_000)
    assert.equal(alloc.reason, 'custom (+10%), tier = pro (+20%)')
  })

  test('a negative modifier is shown without a plus sign', ({ assert }) => {
    const alloc = new BudgetAllocator().compute({}, [{ factor: 'cheap', pctChange: -20 }])

    assert.equal(alloc.perAgent, 40_000)
    assert.equal(alloc.reason, 'cheap (-20%)')
  })

  test('a total above the maximum is capped and the reason says so', ({ assert }) => {
    const alloc = new BudgetAllocator().compute({}, [
      { factor: 'a', pctChange: 40 },
      { factor: 'b', pctChange: 40 },
    ])

    assert.equal(alloc.totalModifierPct, 50)
    assert.equal(alloc.perAgent, 75_000)
    assert.equal(alloc.perSession, 300_000)
    assert.equal(alloc.reason, 'a (+40%), b (+40%) → capped at +50%')
  })

  test('a total below the minimum is capped and the reason says so', ({ assert }) => {
    const alloc = new BudgetAllocator().compute({}, [{ factor: 'x', pctChange: -80 }])

    assert.equal(alloc.totalModifierPct, -50)
    assert.equal(alloc.perAgent, 25_000)
    assert.equal(alloc.reason, 'x (-80%) → capped at -50%')
  })

  test('a minimum of -100 allows the allocation to reach zero but never below', ({ assert }) => {
    const alloc = new BudgetAllocator({ minModifierPct: -100 }).compute({}, [
      { factor: 'gone', pctChange: -150 },
    ])

    assert.equal(alloc.totalModifierPct, -100)
    assert.equal(alloc.perAgent, 0)
  })

  test('rules may return a list, nothing, or a modifier with a non-finite change', ({ assert }) => {
    const alloc = new BudgetAllocator<{ n: number }>()
      .addRule({
        name: 'many',
        evaluate: () => [
          { factor: 'one', pctChange: 5 },
          { factor: 'two', pctChange: 5 },
        ],
      })
      .addRule({ name: 'none', evaluate: () => null })
      .addRule({ name: 'bad', evaluate: () => ({ factor: 'nan', pctChange: Number.NaN }) })
      .compute({ n: 1 })

    assert.equal(alloc.totalModifierPct, 10)
    assert.deepEqual(
      alloc.modifiers.map((m) => m.factor),
      ['one', 'two']
    )
  })

  test('a threshold rule only applies at or above its threshold', ({ assert }) => {
    const allocator = new BudgetAllocator<{ turns: number }>().addRule(atLeastRule('turns', 10, 25))

    assert.equal(allocator.compute({ turns: 9 }).totalModifierPct, 0)
    assert.equal(allocator.compute({ turns: 10 }).totalModifierPct, 25)
  })
})
