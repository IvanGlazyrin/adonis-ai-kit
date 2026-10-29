import { test } from '@japa/runner'
import { computeCost, toSafeTokens } from '../../../src/budget/pricing.js'

const M = 1_000_000

test.group('computeCost', () => {
  test('plain input and output are billed at their per-million rates', ({ assert }) => {
    assert.closeTo(computeCost({ input: 2, output: 8 }, M, M / 2), 6, 1e-9)
  })

  test('cache reads are billed at their own rate and removed from plain input', ({ assert }) => {
    const cost = computeCost({ input: 2, output: 8, cacheReadCostPer1M: 0.5 }, M, 0, { cacheReadTokens: 400_000 })
    assert.closeTo(cost, 600_000 * 2 / M + 400_000 * 0.5 / M, 1e-9)
  })

  test('cache rates fall back to the legacy cacheRead field, then to the input rate', ({ assert }) => {
    const legacy = computeCost({ input: 2, output: 8, cacheRead: 0.25 } as any, M, 0, { cacheReadTokens: M })
    assert.closeTo(legacy, 0.25, 1e-9)

    const none = computeCost({ input: 2, output: 8 }, M, 0, { cacheReadTokens: M })
    assert.closeTo(none, 2, 1e-9)
  })

  test('cache writes are capped at the input left after cache reads', ({ assert }) => {
    const cost = computeCost(
      { input: 2, output: 8, cacheWriteCostPer1M: 10 },
      100_000,
      0,
      { cacheReadTokens: 60_000, cacheWriteTokens: 100_000 }
    )
    // 0 plain input, 60k reads at the input rate, 40k writes (capped) at 10/M
    assert.closeTo(cost, (60_000 * 2 + 40_000 * 10) / M, 1e-9)
  })

  test('reasoning tokens use their own rate when set and the output rate otherwise', ({ assert }) => {
    const own = computeCost({ input: 0, output: 8, reasoningCostPer1M: 20 }, 0, 100_000, { reasoningTokens: 30_000 })
    assert.closeTo(own, (70_000 * 8 + 30_000 * 20) / M, 1e-9)

    const shared = computeCost({ input: 0, output: 8 }, 0, 100_000, { reasoningTokens: 30_000 })
    assert.closeTo(shared, 100_000 * 8 / M, 1e-9)
  })

  test('reasoning tokens cannot exceed the output they belong to', ({ assert }) => {
    const cost = computeCost({ input: 0, output: 8, reasoningCostPer1M: 20 }, 0, 10, { reasoningTokens: 999 })
    assert.closeTo(cost, 10 * 20 / M, 1e-9)
  })

  test('invalid token counts are treated as zero', ({ assert }) => {
    assert.equal(computeCost({ input: 2, output: 8 }, -5, Number.NaN), 0)
  })
})

test.group('toSafeTokens', () => {
  test('keeps positive finite numbers and zeroes everything else', ({ assert }) => {
    assert.equal(toSafeTokens(5), 5)
    assert.equal(toSafeTokens(0), 0)
    assert.equal(toSafeTokens(-1), 0)
    assert.equal(toSafeTokens(Infinity), 0)
    assert.equal(toSafeTokens('7'), 0)
    assert.equal(toSafeTokens(undefined), 0)
  })
})
