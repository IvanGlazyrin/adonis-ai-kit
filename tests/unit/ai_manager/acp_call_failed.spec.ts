import { test } from '@japa/runner'
import { AiManager } from '../../../src/ai_manager.js'
import { defineConfig } from '../../../src/define_config.js'
import { classifyError } from '../../../src/error_classifier.js'
import { AcpCallFailedError } from '../../../src/errors.js'
import type { ResolvedModel } from '../../../src/models/index.js'
import { fakeLanguageModels, fakeModel } from '../../../src/testing/index.js'

/**
 * A failed ACP call during a run raises AcpCallFailedError instead of falling back, so the caller decides.
 * A plain (non-ACP) retryable failure still falls back to the next model.
 */

const ACP_NPM = '@mcpc-tech/acp-ai-provider'
const quiet = { info() {}, warn() {}, error() {}, debug() {} }

const entry = (modelID: string, npm?: string): ResolvedModel => ({
  providerID: npm ? 'acp' : 'mock',
  modelID,
  npm,
  credentialKey: `key:${modelID}`,
})

/** Runs `[first, next]` with `first` timing out. Reports the thrown error (if any) and the next-model call count. */
async function runWithFirstTimingOut(first: ResolvedModel) {
  let nextCalls = 0
  const failing = fakeModel([{ error: new Error('request timeout after 30s') }], {
    provider: first.providerID,
    modelId: first.modelID,
  })
  const next = fakeModel(
    [
      () => {
        nextCalls++
        return { text: 'from next' }
      },
    ],
    { provider: 'mock', modelId: 'next' }
  )
  const manager = new AiManager(
    defineConfig({
      default: 'main',
      providers: { main: { driver: 'custom', factory: () => fakeModel([{ text: 'unused' }]), defaultModel: 'm' } },
      catalog: { autoPricing: false },
      languageModels: fakeLanguageModels({
        [`${first.providerID}/${first.modelID}`]: failing,
        'mock/next': next,
      }),
    } as never),
    quiet
  )

  try {
    const result = await manager.generateText({
      prompt: 'do the task',
      maxRetries: 0,
      models: [first, entry('next')],
    })
    return { thrown: undefined, nextCalls, text: result.text }
  } catch (err) {
    return { thrown: err, nextCalls, text: undefined }
  }
}

test.group('ACP call failure during a run', () => {
  test('a retryable ACP failure raises AcpCallFailedError and does not call the next model', async ({ assert }) => {
    const { thrown, nextCalls } = await runWithFirstTimingOut(entry('agent', ACP_NPM))

    assert.instanceOf(thrown, AcpCallFailedError)
    assert.equal((thrown as AcpCallFailedError).code, 'E_AI_ACP_CALL_FAILED')
    assert.isTrue((thrown as AcpCallFailedError).sideEffectsPossible)
    assert.match((thrown as Error).message, /timeout/)
    assert.equal(nextCalls, 0)
  })

  test('the thrown error is not classified as retryable, so outer layers do not fall back on it', async ({ assert }) => {
    const { thrown } = await runWithFirstTimingOut(entry('agent', ACP_NPM))

    assert.notEqual(classifyError(thrown).kind, 'retryable')
  })

  test('a plain retryable failure (no ACP) still falls back to the next model', async ({ assert }) => {
    const { thrown, nextCalls, text } = await runWithFirstTimingOut(entry('plain'))

    assert.isUndefined(thrown)
    assert.equal(nextCalls, 1)
    assert.equal(text, 'from next')
  })
})
