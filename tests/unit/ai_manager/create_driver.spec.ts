import { test } from '@japa/runner'
import { MockLanguageModelV4 } from 'ai/test'
import { AiManager } from '../../../src/ai_manager.js'
import { defineConfig } from '../../../src/define_config.js'

const manager = () =>
  new AiManager(
    defineConfig({
      default: 'main',
      providers: { main: { driver: 'custom', factory: () => new MockLanguageModelV4({ provider: 'm', modelId: 'm', doGenerate: async () => { throw new Error('unused') } }), defaultModel: 'm' } },
      catalog: { autoPricing: false },
    }),
    { info() {}, warn() {}, error() {}, debug() {} }
  )

/** Builds a driver through the same private factory the manager uses for every provider. */
const build = (config: Record<string, unknown>, name = 'p') => (manager() as any).createDriver(name, config)

test.group('AiManager createDriver', () => {
  test('openai uses its built-in default model, and getModel honours a per-call model', async ({ assert }) => {
    const driver = await build({ driver: 'openai', apiKey: 'k' }, 'openai')

    assert.equal(driver.name, 'openai')
    assert.equal(driver.defaultModel, 'gpt-6-sol')
    assert.equal(driver.getModel().modelId, 'gpt-6-sol')
    assert.equal(driver.getModel('gpt-x').modelId, 'gpt-x')
  })

  test('openai honours a configured defaultModel', async ({ assert }) => {
    const driver = await build({ driver: 'openai', apiKey: 'k', defaultModel: 'my-model' })
    assert.equal(driver.defaultModel, 'my-model')
    assert.equal(driver.getModel().modelId, 'my-model')
  })

  test('anthropic uses its built-in default model', async ({ assert }) => {
    const driver = await build({ driver: 'anthropic', apiKey: 'k' })
    assert.equal(driver.defaultModel, 'claude-sonnet-5-5')
    assert.equal(driver.getModel().modelId, 'claude-sonnet-5-5')
  })

  test('a missing SDK package is reported with the package name and the error code', async ({ assert }) => {
    try {
      await build({ driver: 'groq', apiKey: 'k' })
      assert.fail('expected groq to fail without @ai-sdk/groq installed')
    } catch (e: any) {
      assert.equal(e.code, 'E_AI_MISSING_DEPENDENCY')
      assert.include(e.message, 'Groq driver requires package "@ai-sdk/groq"')
    }
  })

  test('google and gemini share one driver and one missing-package message', async ({ assert }) => {
    for (const driver of ['google', 'gemini']) {
      try {
        await build({ driver, apiKey: 'k' })
        assert.fail(`expected ${driver} to fail without @ai-sdk/google installed`)
      } catch (e: any) {
        assert.include(e.message, 'Google/Gemini driver requires package "@ai-sdk/google"')
      }
    }
  })

  test('ollama reports its missing compatibility package', async ({ assert }) => {
    try {
      await build({ driver: 'ollama' })
      assert.fail('expected ollama to fail without @ai-sdk/openai-compatible installed')
    } catch (e: any) {
      assert.include(e.message, 'Ollama driver requires package "@ai-sdk/openai-compatible"')
    }
  })

  test('an unknown driver is a configuration error', async ({ assert }) => {
    try {
      await build({ driver: 'nope' })
      assert.fail('expected an unsupported driver to throw')
    } catch (e: any) {
      assert.equal(e.code, 'E_AI_CONFIG_ERROR')
      assert.include(e.message, 'Unsupported driver type: "nope"')
    }
  })

  test('custom returns a model factory result and defaults the model name to "custom"', async ({ assert }) => {
    const model = new MockLanguageModelV4({ provider: 'x', modelId: 'fixed', doGenerate: async () => { throw new Error('unused') } })
    const fixed = await build({ driver: 'custom', factory: () => model })
    assert.equal(fixed.defaultModel, 'custom')
    assert.strictEqual(fixed.getModel(), model)

    const perCall = await build({
      driver: 'custom',
      factory: () => (id: string) => new MockLanguageModelV4({ provider: 'x', modelId: id, doGenerate: async () => { throw new Error('unused') } }),
      defaultModel: 'base',
    })
    assert.equal(perCall.defaultModel, 'base')
    assert.equal(perCall.getModel().modelId, 'base')
    assert.equal(perCall.getModel('other').modelId, 'other')
  })
})
