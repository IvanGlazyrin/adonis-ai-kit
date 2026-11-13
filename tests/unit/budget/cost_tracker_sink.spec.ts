import { test } from '@japa/runner'
import { CostTracker } from '../../../src/budget/cost_tracker.js'

const entry = { agentName: 'a', model: 'm', inputTokens: 1, outputTokens: 1, totalTokens: 2, durationMs: 1 }

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

test.group('CostTracker sink', () => {
  test('a rejecting async sink is logged with warn and is not awaited', async ({ assert }) => {
    const warnings: unknown[][] = []
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const tracker = new CostTracker({
        logger: { info() {}, error() {}, debug() {}, warn: (...args: unknown[]) => void warnings.push(args) },
        sink: () => Promise.reject(new Error('db down')),
      })

      const cost = tracker.record(entry)
      await flush()

      assert.isNumber(cost)
      assert.lengthOf(unhandled, 0)
      const sinkWarnings = warnings.filter((w) => String(w[0]).includes('Sink failed'))
      assert.lengthOf(sinkWarnings, 1)
      assert.equal((sinkWarnings[0]![1] as Error).message, 'db down')
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  test('a throwing sink is logged and does not fail record', ({ assert }) => {
    const warnings: unknown[][] = []
    const tracker = new CostTracker({
      logger: { info() {}, error() {}, debug() {}, warn: (...args: unknown[]) => void warnings.push(args) },
      sink: () => {
        throw new Error('boom')
      },
    })

    tracker.record(entry)

    assert.lengthOf(warnings.filter((w) => String(w[0]).includes('Sink failed')), 1)
    assert.equal(tracker.getTotalCalls(), 1)
  })

  test('a slow async sink does not delay record', ({ assert }) => {
    const tracker = new CostTracker({ sink: () => new Promise<void>(() => {}) })

    assert.isNumber(tracker.record(entry))
    assert.equal(tracker.getTotalCalls(), 1)
  })
})
