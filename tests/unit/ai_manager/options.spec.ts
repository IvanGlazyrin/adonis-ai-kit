import { test } from '@japa/runner'
import { AiManager } from '../../../src/ai_manager.js'
import { CircuitBreaker } from '../../../src/circuit_breaker.js'
import { CostTracker } from '../../../src/budget/cost_tracker.js'
import { defineConfig } from '../../../src/define_config.js'
import type { Logger } from '../../../src/logger.js'
import { fakeApiError, fakeModel, fakeProvider } from '../../../src/testing/index.js'

const config = (script: Parameters<typeof fakeModel>[0]) =>
  defineConfig({
    default: 'main',
    providers: { main: fakeProvider(fakeModel(script)) },
    catalog: { autoPricing: false },
  })

/** A logger that records its warnings. */
function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = []
  return { warnings, info: () => {}, warn: (message: string) => warnings.push(message), error: () => {} }
}

test.group('AiManager constructor options', () => {
  test('the options object sets the cost tracker and the breaker', ({ assert }) => {
    const costTracker = new CostTracker()
    const circuitBreaker = new CircuitBreaker()

    const ai = new AiManager(config([{ text: 'ok' }]), { costTracker, circuitBreaker })

    assert.strictEqual(ai.getCostTracker(), costTracker)
    assert.strictEqual(ai.getCircuitBreaker(), circuitBreaker)
  })

  test("an injected breaker records the manager's failures", async ({ assert }) => {
    const circuitBreaker = new CircuitBreaker()
    const ai = new AiManager(config([{ error: fakeApiError(503) }]), { circuitBreaker })

    await assert.rejects(() => ai.generateText({ prompt: 'hi', maxRetries: 0 }))

    assert.equal(circuitBreaker.getStats('main:fake-model').failures, 1)
  })

  test('the positional form still works', async ({ assert }) => {
    const logger = recordingLogger()
    const costTracker = new CostTracker()
    const ai = new AiManager(config([{ error: fakeApiError(503) }]), logger, costTracker)

    assert.strictEqual(ai.getCostTracker(), costTracker)
    await assert.rejects(() => ai.generateText({ prompt: 'hi', maxRetries: 0 }))
    assert.isTrue(logger.warnings.some((message) => message.includes('[AiManager]')))
  })

  test('a logger passed as the second argument is not read as options', async ({ assert }) => {
    const logger = recordingLogger()
    const ai = new AiManager(config([{ error: fakeApiError(503) }]), logger)

    await assert.rejects(() => ai.generateText({ prompt: 'hi', maxRetries: 0 }))

    assert.isTrue(logger.warnings.some((message) => message.includes('[AiManager]')))
  })

  test('undefined as the second argument with positional arguments after it is positional', ({ assert }) => {
    const costTracker = new CostTracker()
    const ai = new AiManager(config([{ text: 'ok' }]), undefined, costTracker)

    assert.strictEqual(ai.getCostTracker(), costTracker)
  })

  test('the options object sets the logger', async ({ assert }) => {
    const logger = recordingLogger()
    const ai = new AiManager(config([{ error: fakeApiError(503) }]), { logger })

    await assert.rejects(() => ai.generateText({ prompt: 'hi', maxRetries: 0 }))

    assert.isTrue(logger.warnings.some((message) => message.includes('[AiManager]')))
  })
})
