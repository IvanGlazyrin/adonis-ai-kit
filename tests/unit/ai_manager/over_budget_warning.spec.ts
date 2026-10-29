import { test } from '@japa/runner'
import { MockLanguageModelV4 } from 'ai/test'
import { AiManager } from '../../../src/ai_manager.js'
import { defineConfig } from '../../../src/define_config.js'

const usage = (inp: number, out: number) => ({
  inputTokens: { total: inp, noCache: inp, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: out, text: out, reasoning: 0 },
})

const manager = (budget?: Record<string, number>) => {
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
      ...(budget ? { budget } : {}),
    } as any),
    { info() {}, warn: (m: string) => void warnings.push(m), error() {}, debug() {} }
  )
  return { ai, warnings }
}

test.group('AiManager over-budget warnings', () => {
  test('a call whose total tokens exceed the per-request limit logs a warning', async ({ assert }) => {
    const { ai, warnings } = manager({ maxTokensPerRequest: 40 })

    await ai.generateText({ prompt: 'hi', agentName: 'writer', maxRetries: 0 })

    assert.isTrue(warnings.some((w) => w.includes('Token limit exceeded for writer: 50 > 40')))
  })

  test('a call within the token limit logs nothing', async ({ assert }) => {
    const { ai, warnings } = manager({ maxTokensPerRequest: 500 })

    await ai.generateText({ prompt: 'hi', agentName: 'writer', maxRetries: 0 })

    assert.isFalse(warnings.some((w) => w.includes('limit exceeded')))
  })

  test('a cost above the per-request limit logs a cost warning, and a missing or zero limit never does', ({ assert }) => {
    const { ai, warnings } = manager({ maxCostPerRequestUsd: 0.5 })
    ;(ai as any).warnIfOverBudget('writer', 1, 0.75)
    ;(ai as any).warnIfOverBudget('writer', 1, 0.25)
    ;(ai as any).warnIfOverBudget('writer', 1, undefined)

    assert.deepEqual(warnings, ['[AiManager] Cost limit exceeded for writer: $0.75 > $0.5'])

    const unlimited = manager()
    ;(unlimited.ai as any).warnIfOverBudget('writer', 1e9, 1e9)
    assert.lengthOf(unlimited.warnings, 0)
  })
})
