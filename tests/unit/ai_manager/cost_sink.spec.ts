import { test } from '@japa/runner'
import { MockLanguageModelV4 } from 'ai/test'
import { AiManager } from '../../../src/ai_manager.js'
import { defineConfig } from '../../../src/define_config.js'
import type { AgentCostRecord } from '../../../src/budget/types.js'
import type { BudgetConfig } from '../../../src/types.js'

const usage = (inp: number, out: number) => ({
  inputTokens: { total: inp, noCache: inp, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: out, text: out, reasoning: 0 },
})

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

const manager = (budget: BudgetConfig) => {
  const warnings: string[] = []
  const model = new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'm',
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'hi' }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: usage(30, 20),
      warnings: [],
    }),
  })
  const ai = new AiManager(
    defineConfig({
      default: 'main',
      providers: { main: { driver: 'custom', factory: () => model, defaultModel: 'm' } },
      catalog: { autoPricing: false },
      budget,
    } as any),
    { info() {}, warn: (m: string) => void warnings.push(m), error() {}, debug() {} }
  )
  return { ai, warnings }
}

test.group('AiManager cost sink from config', () => {
  test('config.budget.sink receives one record per call with provider and model', async ({ assert }) => {
    const records: AgentCostRecord[] = []
    const { ai } = manager({ sink: (record) => void records.push(record) })

    await ai.generateText({ prompt: 'hi', agentName: 'writer', maxRetries: 0 })

    assert.lengthOf(records, 1)
    assert.equal(records[0]!.agentName, 'writer')
    assert.equal(records[0]!.model, 'm')
    assert.equal(records[0]!.metadata?.provider, 'main')
    assert.equal(records[0]!.totalTokens, 50)
  })

  test('a throwing sink does not fail generateText', async ({ assert }) => {
    const { ai, warnings } = manager({
      sink: () => {
        throw new Error('boom')
      },
    })

    const result = await ai.generateText({ prompt: 'hi', agentName: 'writer', maxRetries: 0 })

    assert.equal(result.text, 'hi')
    assert.isTrue(warnings.some((w) => w.includes('Sink failed')))
  })

  test('a rejecting async sink is logged and does not fail', async ({ assert }) => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const { ai, warnings } = manager({ sink: () => Promise.reject(new Error('db down')) })

      const result = await ai.generateText({ prompt: 'hi', agentName: 'writer', maxRetries: 0 })
      await flush()

      assert.equal(result.text, 'hi')
      assert.lengthOf(unhandled, 0)
      assert.isTrue(warnings.some((w) => w.includes('Sink failed')))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  test('config.budget.maxRecords: 0 keeps aggregates only', async ({ assert }) => {
    const { ai } = manager({ maxRecords: 0 })

    await ai.generateText({ prompt: 'hi', agentName: 'writer', maxRetries: 0 })

    const tracker = ai.getCostTracker()
    assert.lengthOf(tracker.getRecords(), 0)
    assert.equal(tracker.getTotalCalls(), 1)
    assert.equal(tracker.getTotalTokens(), 50)
  })

  test('config.budget.maxRecords bounds the records kept', async ({ assert }) => {
    const { ai } = manager({ maxRecords: 2 })

    for (let i = 0; i < 3; i++) await ai.generateText({ prompt: 'hi', agentName: 'writer', maxRetries: 0 })

    const tracker = ai.getCostTracker()
    assert.lengthOf(tracker.getRecords(), 2)
    assert.equal(tracker.getTotalCalls(), 3)
  })
})

test.group('usage helpers export', () => {
  test('normalizeUsage, sumUsage and EMPTY_USAGE are exported from the package root', async ({ assert }) => {
    const root = await import('../../../src/index.js')

    assert.isFunction(root.normalizeUsage)
    assert.isFunction(root.sumUsage)
    assert.equal(root.EMPTY_USAGE.totalTokens, 0)
    assert.equal(root.sumUsage([{ inputTokens: 1, outputTokens: 2 }, { inputTokens: 3 }]).totalTokens, 6)
  })
})
