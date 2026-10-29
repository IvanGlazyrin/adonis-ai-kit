import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { MockLanguageModelV4 } from 'ai/test'
import { AiManager } from '../../../src/ai_manager.js'
import { defineConfig } from '../../../src/define_config.js'

const usage = (inp: number, out: number) => ({
  inputTokens: { total: inp, noCache: inp, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: out, text: out, reasoning: 0 },
})

/** A catalog file with one priced model under the provider id the custom driver maps to. */
const catalogFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'adonis-ai-pricing-'))
  const overridePath = join(dir, 'override.json')
  writeFileSync(
    overridePath,
    JSON.stringify({
      custom: {
        id: 'custom',
        name: 'Custom',
        env: [],
        models: {
          'priced-model': {
            id: 'priced-model',
            name: 'Priced',
            tool_call: true,
            cost: { input: 2, output: 4 },
          },
        },
      },
    })
  )
  return { overridePath, cachePath: join(dir, 'cache.json') }
}

const manager = (catalog: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const model = new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'priced-model',
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'hi' }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: usage(1_000_000, 0),
      warnings: [],
    }),
  })
  return new AiManager(
    defineConfig({
      default: 'main',
      catalog,
      ...extra,
      providers: {
        main: { driver: 'custom', factory: () => model, defaultModel: 'priced-model' },
        ...((extra.providers as object) ?? {}),
      },
    } as any),
    { info() {}, warn() {}, error() {}, debug() {} }
  )
}

test.group('AiManager catalog pricing', () => {
  test('a call is costed from the catalog price for its model', async ({ assert }) => {
    const ai = manager(catalogFile())

    const result = await ai.generateText({ prompt: 'hi', maxRetries: 0 })

    assert.closeTo(result.costUsd!, 2, 1e-9)
  })

  test('with autoPricing off the catalog price is not used', async ({ assert }) => {
    const ai = manager({ ...catalogFile(), autoPricing: false })

    const result = await ai.generateText({ prompt: 'hi', maxRetries: 0 })

    assert.notEqual(result.costUsd, 2)
  })

  test('a failing catalog lookup does not fail the call', async ({ assert }) => {
    const ai = manager(catalogFile())
    ;(ai as any).catalog.getModelPricing = async () => {
      throw new Error('catalog unreachable')
    }

    const result = await ai.generateText({ prompt: 'hi', maxRetries: 0 })

    assert.equal(result.text, 'hi')
  })

  test('concurrent warm-ups for one model share a single lookup', async ({ assert }) => {
    const ai = manager(catalogFile())
    let lookups = 0
    const catalog = (ai as any).catalog
    const original = catalog.getModelPricing.bind(catalog)
    catalog.getModelPricing = async (...args: unknown[]) => {
      lookups++
      return original(...args)
    }

    const first = (ai as any).warmPricing('main', 'priced-model')
    const second = (ai as any).warmPricing('main', 'priced-model')
    await Promise.all([first, second])

    assert.strictEqual(first, second)
    assert.equal(lookups, 1)
  })

  test('an ACP-backed provider is never priced from the catalog', async ({ assert }) => {
    const ai = manager(catalogFile(), {
      providers: { acpish: { driver: 'acp', agentId: 'claude-code', defaultModel: 'x' } },
    })
    let lookups = 0
    ;(ai as any).catalog.getModelPricing = async () => {
      lookups++
      return undefined
    }

    await (ai as any).warmPricing('acpish', 'x')

    assert.equal(lookups, 0)
  })
})
