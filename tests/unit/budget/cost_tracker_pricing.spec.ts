import { test } from '@japa/runner'
import { CostTracker } from '../../../src/budget/cost_tracker.js'
import { DEFAULT_MODEL_PRICING } from '../../../src/budget/pricing.js'

const M = 1_000_000

function recordingLogger() {
  const warnings: string[] = []
  return { warnings, logger: { info() {}, warn: (msg: string) => warnings.push(msg), error() {}, debug() {} } }
}

test.group('CostTracker pricing sources', () => {
  test('a model in the built-in table is priced from it', ({ assert }) => {
    const tracker = new CostTracker()
    const { input, output } = DEFAULT_MODEL_PRICING['gpt-4o']

    assert.closeTo(tracker.calculateCost('gpt-4o', M, M), input + output, 1e-9)
  })

  test('a price set at runtime (as models.dev pricing is) wins over the table', ({ assert }) => {
    const tracker = new CostTracker()
    tracker.setPricing({ 'gpt-4o': { input: 1, output: 3 } })

    assert.closeTo(tracker.calculateCost('gpt-4o', M, M), 4, 1e-9)
  })

  test('a model priced nowhere costs $0 and warns once', ({ assert }) => {
    const { warnings, logger } = recordingLogger()
    const tracker = new CostTracker({ logger: logger as any })

    assert.equal(tracker.calculateCost('openai/not-a-real-model', M, M), 0)
    assert.equal(tracker.calculateCost('openai/not-a-real-model', M, M), 0)

    assert.lengthOf(warnings, 1)
    assert.include(warnings[0], 'Unknown model "not-a-real-model"')
  })

  test('recording an unpriced model keeps its tokens and a $0 cost', ({ assert }) => {
    const tracker = new CostTracker()

    const cost = tracker.record({
      agentName: 'a',
      model: 'not-a-real-model',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      durationMs: 1,
    })

    assert.equal(cost, 0)
    assert.equal(tracker.getTotalTokens(), 15)
  })
})
