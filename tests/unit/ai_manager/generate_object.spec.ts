import { test } from '@japa/runner'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import { AiManager } from '../../../src/ai_manager.js'
import { defineConfig } from '../../../src/define_config.js'

const usage = (inp: number, out: number) => ({
  inputTokens: { total: inp, noCache: inp, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: out, text: out, reasoning: 0 },
})
const finish = () => ({ unified: 'stop' as const, raw: 'stop' })

const textModel = (text: string) =>
  new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'm',
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: finish(),
      usage: usage(10, 5),
      warnings: [],
    }),
  })

const manager = (model: MockLanguageModelV4) =>
  new AiManager(
    defineConfig({
      default: 'main',
      providers: { main: { driver: 'custom', factory: () => model, defaultModel: 'm' } },
      catalog: { autoPricing: false },
    }),
    { info() {}, warn() {}, error() {}, debug() {} }
  )

test.group('AiManager generateObject', () => {
  test('returns the parsed object with usage, provider and model', async ({ assert }) => {
    const result = await manager(textModel('{"n":7}')).generateObject({
      prompt: 'x',
      schema: z.object({ n: z.number() }),
    })

    assert.deepEqual(result.object, { n: 7 })
    assert.equal(result.provider, 'main')
    assert.equal(result.model, 'm')
    assert.equal(result.usage.totalTokens, 15)
  })

  test('generateText without a schema exposes no structured output', async ({ assert }) => {
    const result = await manager(textModel('hello')).generateText({ prompt: 'x' })

    assert.equal(result.text, 'hello')
    assert.isUndefined(result.output)
  })
})
