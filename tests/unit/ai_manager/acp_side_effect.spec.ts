import { test } from '@japa/runner'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AiManager } from '../../../src/ai_manager.js'
import { defineConfig } from '../../../src/define_config.js'
import { fakeLanguageModels, fakeModel } from '../../../src/testing/index.js'
import type { ResolvedModel } from '../../../src/models/index.js'

/**
 * Empirical check of D2.3 (phase 6). A fake ACP-like agent performs a side effect (appends a line to a file in a
 * temp directory), then fails with a retryable timeout. The next model in the chain performs the same side effect
 * if it runs. The number of lines in the file is the observed number of side effects.
 */

const ACP_NPM = '@mcpc-tech/acp-ai-provider'
const quiet = { info() {}, warn() {}, error() {}, debug() {} }

const entry = (modelID: string, npm?: string): ResolvedModel => ({
  providerID: npm ? 'acp' : 'mock',
  modelID,
  npm,
  credentialKey: `key:${modelID}`,
})

/** Runs the two-model chain (`first`, then `next`) and reports what happened, without throwing. */
async function runChain(first: ResolvedModel, logFile: string) {
  const agent = fakeModel(
    [
      (): { error: Error } => {
        appendFileSync(logFile, 'side effect\n')
        return { error: new Error('agent request timeout after 30s') }
      },
    ],
    { provider: 'acp', modelId: 'agent' }
  )
  const next = fakeModel(
    [
      () => {
        appendFileSync(logFile, 'side effect\n')
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
      languageModels: fakeLanguageModels({ [`${first.providerID}/${first.modelID}`]: agent, 'mock/next': next }),
    } as never),
    quiet
  )

  let outcome: string
  try {
    const result = await manager.generateText({
      prompt: 'do the task',
      maxRetries: 0,
      models: [first, entry('next')],
    })
    outcome = `answered by ${result.provider}/${result.model}`
  } catch (err) {
    outcome = `thrown: ${(err as Error).message}`
  }
  const sideEffects = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length
  return { outcome, sideEffects, nextCalls: next.calls.length }
}

test.group('D2.3 empirical check: ACP side effects on fallback', () => {
  test('an ACP agent that ran a side effect then timed out is not retried on the next model', async ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-probe-'))
    try {
      const logFile = join(dir, 'side_effects.log')
      const observed = await runChain(entry('agent', ACP_NPM), logFile)
      // Recorded in the design spec (phase 6). With D2.3 the chain stops at the agent.
      assert.equal(observed.sideEffects, 1, `side effects observed: ${observed.sideEffects} (${observed.outcome})`)
      assert.equal(observed.nextCalls, 0, `next model calls: ${observed.nextCalls}`)
      assert.match(observed.outcome, /^thrown:/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('control: the same timeout on a non-ACP model falls back, and the next model repeats the side effect', async ({
    assert,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-probe-'))
    try {
      const logFile = join(dir, 'side_effects.log')
      const observed = await runChain(entry('agent'), logFile)
      assert.equal(observed.nextCalls, 1, `next model calls: ${observed.nextCalls} (${observed.outcome})`)
      assert.equal(observed.sideEffects, 2, `side effects observed: ${observed.sideEffects}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
