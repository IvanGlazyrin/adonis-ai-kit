import { test } from '@japa/runner'
import { stepCountIs } from 'ai'
import { AiManager } from '../../../src/ai_manager.js'
import { defineConfig } from '../../../src/define_config.js'
import { fakeModel, fakeProvider, fakeTools, type FakeModel, type FakeScriptEntry } from '../../../src/testing/index.js'

const makeManager = (model: FakeModel, budget: Record<string, unknown>) =>
  new AiManager(
    defineConfig({
      default: 'main',
      providers: { main: fakeProvider(model) },
      catalog: { autoPricing: false },
      budget,
    } as any),
    { info() {}, warn() {}, error() {}, debug() {} }
  )

const stepEntry = (input: number, output: number): FakeScriptEntry => ({
  toolCalls: [{ name: 'lookup', input: {} }],
  usage: { input, output },
})

test.group('AiManager budget.enforce', () => {
  test('enforce stops the loop after the step that crosses maxTokensPerRequest', async () => {
    const model = fakeModel([
      stepEntry(50, 50),
      stepEntry(50, 50),
      stepEntry(50, 50),
      { text: 'unreachable' },
    ])
    const ai = makeManager(model, { maxTokensPerRequest: 150, enforce: true })
    const tools = fakeTools({ lookup: () => ({ ok: true }) })

    await ai.generateText({ prompt: 'hi', tools: tools.tools, maxSteps: 5 })

    model.assertCalledTimes(2)
  })

  test('without enforce the loop runs to maxSteps', async () => {
    const model = fakeModel([
      stepEntry(50, 50),
      stepEntry(50, 50),
      stepEntry(50, 50),
    ])
    const ai = makeManager(model, { maxTokensPerRequest: 150 })
    const tools = fakeTools({ lookup: () => ({ ok: true }) })

    await ai.generateText({ prompt: 'hi', tools: tools.tools, maxSteps: 3 })

    model.assertCalledTimes(3)
  })

  test("the caller's stopWhen still applies", async () => {
    const model = fakeModel([
      stepEntry(50, 50),
      stepEntry(50, 50),
    ])
    const ai = makeManager(model, { maxTokensPerRequest: 1000, enforce: true })
    const tools = fakeTools({ lookup: () => ({ ok: true }) })

    await ai.generateText({ prompt: 'hi', tools: tools.tools, stopWhen: stepCountIs(1) })

    model.assertCalledTimes(1)
  })
})
