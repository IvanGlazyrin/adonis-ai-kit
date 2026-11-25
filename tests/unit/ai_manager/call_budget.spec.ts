import { test } from '@japa/runner'
import { z } from 'zod'
import { AiManager } from '../../../src/ai_manager.js'
import { BudgetEnforcer } from '../../../src/budget/budget_enforcer.js'
import { defineConfig } from '../../../src/define_config.js'
import { classifyError } from '../../../src/error_classifier.js'
import { BudgetExceededError } from '../../../src/errors.js'
import { fakeApiError, fakeModel, fakeProvider, fakeTools, type FakeModel, type FakeScriptEntry } from '../../../src/testing/index.js'

const makeManager = (model: FakeModel, extra: Record<string, unknown> = {}) =>
  new AiManager(
    defineConfig({
      default: 'main',
      providers: { main: fakeProvider(model) },
      catalog: { autoPricing: false },
      ...extra,
    }),
    { info() {}, warn() {}, error() {}, debug() {} }
  )

const stepEntry = (input: number, output: number, toolName = 'lookup'): FakeScriptEntry => ({
  toolCalls: [{ name: toolName, input: {} }],
  usage: { input, output },
})

test.group('AiManager call budget', () => {
  test('an exhausted budget refuses the call before the model is called', async ({ assert }) => {
    const model = fakeModel([{ text: 'unreachable' }])
    const ai = makeManager(model)
    const enforcer = new BudgetEnforcer({ perAgentMaxTokens: 100 })
    enforcer.recordAgentUsage('a', 100)

    let caught: unknown
    try {
      await ai.generateText({ prompt: 'hi', agentName: 'a', maxRetries: 0, budget: { enforcer } })
    } catch (err) {
      caught = err
    }

    assert.instanceOf(caught, BudgetExceededError)
    assert.equal((caught as BudgetExceededError).code, 'E_AI_BUDGET_EXCEEDED')
    assert.equal(classifyError(caught).kind, 'fatal')
    model.assertCalledTimes(0)
  })

  test('usage is settled into the enforcer', async ({ assert }) => {
    const model = fakeModel([{ text: 'ok' }])
    const ai = makeManager(model)
    const enforcer = new BudgetEnforcer({ perAgentMaxTokens: 100 })

    await ai.generateText({ prompt: 'hi', agentName: 'a', budget: { enforcer } })

    assert.equal(enforcer.getAgentTokensUsed('a'), 20)
    assert.equal(enforcer.getSessionTokensUsed(), 20)
  })

  test('the tool loop stops after the step that exhausts the budget', async ({ assert }) => {
    const model = fakeModel([
      stepEntry(50, 50),
      stepEntry(50, 50),
      stepEntry(50, 50),
      { text: 'unreachable' },
    ])
    const ai = makeManager(model)
    const tools = fakeTools({ lookup: () => ({ ok: true }) })
    const enforcer = new BudgetEnforcer({ perAgentMaxTokens: 150 })

    await ai.generateText({
      prompt: 'hi',
      agentName: 'a',
      tools: tools.tools,
      maxSteps: 5,
      budget: { enforcer },
    })

    model.assertCalledTimes(2)
    assert.equal(enforcer.getAgentTokensUsed('a'), 200)
  })

  test('a projected hold is not double-counted when checking the tool loop', async ({ assert }) => {
    const model = fakeModel([
      stepEntry(50, 50),
      stepEntry(50, 50),
      stepEntry(50, 50),
    ])
    const ai = makeManager(model)
    const tools = fakeTools({ lookup: () => ({ ok: true }) })
    const enforcer = new BudgetEnforcer({ perAgentMaxTokens: 150 })

    await ai.generateText({
      prompt: 'hi',
      agentName: 'a',
      tools: tools.tools,
      maxSteps: 5,
      budget: { enforcer, projectedTokens: 50 },
    })

    model.assertCalledTimes(2)
    assert.equal(enforcer.getAgentTokensUsed('a'), 200)
  })

  test('a failed call without tokens releases the reservation', async ({ assert }) => {
    const model = fakeModel([{ error: fakeApiError(400, 'bad request') }])
    const ai = makeManager(model)
    const enforcer = new BudgetEnforcer({ perAgentMaxTokens: 100 })

    await assert.rejects(() =>
      ai.generateText({
        prompt: 'hi',
        agentName: 'a',
        maxRetries: 0,
        budget: { enforcer, projectedTokens: 50 },
      })
    )

    assert.equal(enforcer.getAgentTokensUsed('a'), 0)
    assert.isNotNull(enforcer.reserve('a', 99))
  })

  test("budget.agentName overrides the call's agent name", async ({ assert }) => {
    const model = fakeModel([{ text: 'ok' }])
    const ai = makeManager(model)
    const enforcer = new BudgetEnforcer({ perAgentMaxTokens: 100 })

    await ai.generateText({
      prompt: 'hi',
      agentName: 'caller',
      budget: { enforcer, agentName: 'bucket' },
    })

    assert.equal(enforcer.getAgentTokensUsed('bucket'), 20)
    assert.equal(enforcer.getAgentTokensUsed('caller'), 0)
  })

  test('a consumed stream settles its usage', async ({ assert }) => {
    const model = fakeModel([{ text: 'streamed' }])
    const ai = makeManager(model)
    const enforcer = new BudgetEnforcer({ perAgentMaxTokens: 100 })

    const stream = await ai.streamText({ prompt: 'hi', agentName: 'a', budget: { enforcer } })
    await stream.consume()

    assert.equal(enforcer.getAgentTokensUsed('a'), 20)
    assert.equal(enforcer.getSessionTokensUsed(), 20)
  })

  test('generateObject settles usage and checks the budget before calling the model', async ({ assert }) => {
    const model = fakeModel([{ object: { ok: true } }])
    const ai = makeManager(model)
    const enforcer = new BudgetEnforcer({ perAgentMaxTokens: 25 })

    await ai.generateObject({
      prompt: 'hi',
      agentName: 'a',
      schema: z.object({ ok: z.boolean() }),
      budget: { enforcer },
    })

    assert.equal(enforcer.getAgentTokensUsed('a'), 20)

    await assert.rejects(
      () =>
        ai.generateObject({
          prompt: 'hi',
          agentName: 'a',
          schema: z.object({ ok: z.boolean() }),
          budget: { enforcer, projectedTokens: 10 },
        }),
      /Budget exhausted/
    )
    model.assertCalledTimes(1)
  })
})
