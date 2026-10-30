import { test } from '@japa/runner'
import { tool } from 'ai'
import { z } from 'zod'
import { AiManager } from '../../../src/ai_manager.js'
import { AgentRunner } from '../../../src/agents/agent_runner.js'
import type { AgentPromptConfig } from '../../../src/agents/loader.js'
import { agentAsTool, SubAgentSpend } from '../../../src/agents/sub_agent.js'
import { AcpCallFailedError, AiException, SubAgentApprovalError } from '../../../src/errors.js'
import { defineConfig } from '../../../src/define_config.js'
import { stopOnBudget } from '../../../src/budget/stop_condition.js'
import { classifyError } from '../../../src/error_classifier.js'
import { ConfirmationService } from '../../../src/guard/confirmation.js'
import { ToolRegistry } from '../../../src/guard/registry.js'
import { fakeApiError, fakeModel, fakeProvider, type FakeModel } from '../../../src/testing/index.js'
import type { ResolvedModel } from '../../../src/models/index.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

const managerFor = (model: FakeModel) =>
  new AiManager(
    defineConfig({
      default: 'main',
      providers: { main: fakeProvider(model) },
      catalog: { autoPricing: false },
    }),
    quiet
  )

const agentConfig = (overrides: Partial<AgentPromptConfig> = {}): AgentPromptConfig => ({
  id: 'researcher',
  description: 'Researches a topic',
  mode: 'subagent',
  stopSteps: 4,
  skills: [],
  skillLoading: 'eager',
  systemPrompt: 'RESEARCHER-PROMPT',
  eagerSystemPrompt: 'RESEARCHER-PROMPT',
  body: '',
  skillPrompts: {},
  skillEntries: [],
  permissions: {},
  phases: [],
  ...overrides,
})

const parentConfig = agentConfig({ id: 'parent', description: '', mode: 'primary', systemPrompt: 'PARENT-PROMPT', eagerSystemPrompt: 'PARENT-PROMPT' })

const named = (name: string) => tool({ description: name, inputSchema: z.object({}), execute: async () => name })

test.group('sub-agent isolation', () => {
  test('sub-agent sees only its task', async ({ assert }) => {
    const sub = fakeModel([{ text: 'researched' }])
    const parent = fakeModel([
      { toolCalls: [{ name: 'researcher', input: { task: 'T' } }] },
      { text: 'parent done' },
    ])
    const researcher = new AgentRunner(managerFor(sub), agentConfig())

    const result = await new AgentRunner(managerFor(parent), parentConfig).run({
      messages: [
        { role: 'user', content: 'PARENT-ONE' },
        { role: 'assistant', content: 'PARENT-TWO' },
        { role: 'user', content: 'PARENT-THREE' },
      ],
      tools: { researcher: agentAsTool(researcher) },
    })

    assert.equal(result.text, 'parent done')
    sub.assertCalledTimes(1)
    const prompt = sub.calls[0].prompt
    assert.deepEqual(prompt.map((message) => message.role), ['system', 'user'])
    assert.include(JSON.stringify(prompt[1].content), '"text":"T"')
    assert.include(JSON.stringify(prompt[0].content), 'RESEARCHER-PROMPT')
    assert.notInclude(JSON.stringify(prompt), 'PARENT-')
  })

  test('tool description says the sub-agent has no parent history', ({ assert }) => {
    const researcher = new AgentRunner(managerFor(fakeModel([])), agentConfig())

    const description = String(agentAsTool(researcher).description)

    assert.include(description, 'Researches a topic')
    assert.match(description, /history/i)
    assert.match(description, /only the task/i)
  })

  test('sub-agent offers only tools allowed by its manifest', async ({ assert }) => {
    const sub = fakeModel([{ text: 'ok' }])
    const researcher = new AgentRunner(
      managerFor(sub),
      agentConfig({ permissions: { a: 'allow' } }),
      { tools: { a: named('a'), b: named('b') } }
    )
    const parent = fakeModel([
      { toolCalls: [{ name: 'researcher', input: { task: 'T' } }] },
      { text: 'done' },
    ])

    await new AgentRunner(managerFor(parent), parentConfig).run({
      prompt: 'go',
      tools: { researcher: agentAsTool(researcher) },
    })

    sub.assertToolOffered('a')
    sub.assertToolNotOffered('b')
  })

  test('agentAsTool refuses a manifest with ask tools', ({ assert }) => {
    const researcher = new AgentRunner(
      managerFor(fakeModel([])),
      agentConfig({ permissions: { pay: 'ask' } })
    )

    let error: unknown
    try {
      agentAsTool(researcher)
    } catch (err) {
      error = err
    }

    assert.instanceOf(error, SubAgentApprovalError)
    assert.equal((error as AiException).code, 'E_AI_SUBAGENT_APPROVAL_REQUIRED')
    assert.include((error as Error).message, 'pay')
  })

  test('pre-wrapped ask tool inside a sub-agent fails the parent tool call', async ({ assert }) => {
    const confirmation = new ConfirmationService({ defaultTimeoutMs: 50 })
    const created: unknown[] = []
    confirmation.onActionCreated((action) => void created.push(action))
    let executed = 0
    const pay = tool({
      description: 'pay',
      inputSchema: z.object({}),
      execute: async () => {
        executed++
        return 'paid'
      },
    })
    const wrapped = new ToolRegistry().wrapTool('pay', pay, { permission: 'ask', confirmation, timeoutMs: 50 })

    const sub = fakeModel([{ toolCalls: [{ name: 'pay', input: {} }] }, { text: 'after' }])
    const researcher = new AgentRunner(
      managerFor(sub),
      agentConfig({ permissions: { pay: 'allow' } }),
      { tools: { pay: wrapped as never } }
    )
    const parent = fakeModel([
      { toolCalls: [{ name: 'researcher', input: { task: 'T' } }] },
      { text: 'parent recovered' },
    ])

    const result = await new AgentRunner(managerFor(parent), parentConfig).run({
      prompt: 'go',
      tools: { researcher: agentAsTool(researcher) },
    })

    assert.equal(created.length, 0)
    assert.equal(executed, 0)
    assert.equal(result.text, 'parent recovered')
    parent.assertPromptContains('E_AI_SUBAGENT_APPROVAL_REQUIRED')
    parent.assertPromptContains('pay')
  })

  test('sub-agent failure reaches the parent as a tool error and the parent continues', async ({ assert }) => {
    const sub = fakeModel([{ error: fakeApiError(400) }])
    const researcher = new AgentRunner(managerFor(sub), agentConfig())
    const parent = fakeModel([
      { toolCalls: [{ name: 'researcher', input: { task: 'T' } }] },
      { text: 'parent continues' },
    ])

    const result = await new AgentRunner(managerFor(parent), parentConfig).run({
      prompt: 'go',
      tools: { researcher: agentAsTool(researcher) },
    })

    assert.equal(result.text, 'parent continues')
    parent.assertPromptContains('E_AI_SUBAGENT_FAILED')
  })

  test('AcpCallFailedError is passed through unchanged', async ({ assert }) => {
    const acp = new AcpCallFailedError('claude-code', new Error('timeout'))
    const researcher = new AgentRunner(managerFor(fakeModel([{ error: acp }])), agentConfig())

    const error = await (agentAsTool(researcher).execute as any)({ task: 'T' }, { toolCallId: 't1', messages: [] })
      .then(() => null, (err: unknown) => err)

    assert.instanceOf(error, AcpCallFailedError)
    assert.isTrue((error as AcpCallFailedError).sideEffectsPossible)
  })

  test('sub-agent cost is recorded under its own agent name', async ({ assert }) => {
    const model = fakeModel([
      { toolCalls: [{ name: 'researcher', input: { task: 'T' } }] },
      { text: 'researched' },
      { text: 'parent done' },
    ])
    const manager = managerFor(model)
    const researcher = new AgentRunner(manager, agentConfig())

    await new AgentRunner(manager, parentConfig).run({
      prompt: 'go',
      tools: { researcher: agentAsTool(researcher) },
    })

    const byAgent = manager.getCostTracker().getByAgent()
    assert.isDefined(byAgent.parent)
    assert.isDefined(byAgent.researcher)
  })

  test('stopOnBudget with extra spend stops the parent after an expensive sub-agent', async ({ assert }) => {
    const parent = fakeModel([
      { toolCalls: [{ name: 'researcher', input: { task: 'T' } }], usage: { input: 10, output: 10 } },
      { text: 'never reached' },
    ])
    const sub = fakeModel([{ text: 'researched', usage: { input: 100, output: 100 } }])
    const manager = managerFor(parent)
    const researcher = new AgentRunner(managerFor(sub), agentConfig())
    const spend = new SubAgentSpend()

    await new AgentRunner(manager, parentConfig).run({
      prompt: 'go',
      maxSteps: 5,
      stopWhen: stopOnBudget({ maxTokens: 100 }, manager.getCostTracker(), { extra: spend }),
      tools: { researcher: agentAsTool(researcher, { spend }) },
    })

    assert.equal(spend.tokens(), 200)
    parent.assertCalledTimes(1)
  })

  test('parent does not fall back after a sub-agent ran', async ({ assert }) => {
    const sub = fakeModel([{ text: 'researched' }])
    const researcher = new AgentRunner(managerFor(sub), agentConfig())
    const a = fakeModel([
      { toolCalls: [{ name: 'researcher', input: { task: 'T' } }] },
      { error: fakeApiError(429) },
    ])
    const b = fakeModel([{ text: 'from b' }])
    const chain = new AiManager(
      defineConfig({
        default: 'main',
        providers: { main: fakeProvider(fakeModel([])) },
        catalog: { autoPricing: false },
        languageModels: {
          create: async (model: ResolvedModel) => (model.modelID === 'a' ? a : b),
          shutdown: async () => {},
        },
      } as never),
      quiet
    )
    const models = ['a', 'b'].map((modelID) => ({ providerID: 'mock', modelID, credentialKey: `key:${modelID}` }))

    await assert.rejects(() =>
      new AgentRunner(chain, parentConfig).run({
        prompt: 'go',
        maxRetries: 0,
        models,
        tools: { researcher: agentAsTool(researcher) },
      })
    )
    assert.equal(b.calls.length, 0)
  })

  test('aborting the parent aborts the sub-agent run', async ({ assert }) => {
    const controller = new AbortController()
    const sub = fakeModel([
      () => {
        controller.abort()
        return { text: 'late' }
      },
    ])
    const researcher = new AgentRunner(managerFor(sub), agentConfig())
    const parent = fakeModel([
      { toolCalls: [{ name: 'researcher', input: { task: 'T' } }] },
      { text: 'never reached' },
    ])

    await new AgentRunner(managerFor(parent), parentConfig)
      .run({ prompt: 'go', abortSignal: controller.signal, tools: { researcher: agentAsTool(researcher) } })
      .catch(() => undefined)

    assert.isTrue(sub.calls[0].options.abortSignal?.aborted === true)
  })

  test('agentAsTool refuses a primary agent', ({ assert }) => {
    const primary = new AgentRunner(managerFor(fakeModel([])), agentConfig({ mode: 'primary' }))

    let error: unknown
    try {
      agentAsTool(primary)
    } catch (err) {
      error = err
    }

    assert.instanceOf(error, AiException)
    assert.equal((error as AiException).code, 'E_AI_CONFIG_ERROR')
  })

  test('sub-agent cannot call a sub-agent at depth 2', async ({ assert }) => {
    const leaf = fakeModel([{ text: 'leaf answer' }])
    const leafRunner = new AgentRunner(managerFor(leaf), agentConfig({ id: 'leaf', description: 'Leaf' }))
    const middle = fakeModel([
      { toolCalls: [{ name: 'leaf', input: { task: 'T' } }] },
      { text: 'middle done' },
    ])
    const middleRunner = new AgentRunner(
      managerFor(middle),
      agentConfig({ id: 'middle', description: 'Middle', permissions: { leaf: 'allow' } }),
      { tools: { leaf: agentAsTool(leafRunner) } }
    )
    const parent = fakeModel([
      { toolCalls: [{ name: 'middle', input: { task: 'T' } }] },
      { text: 'parent done' },
    ])

    const result = await new AgentRunner(managerFor(parent), parentConfig).run({
      prompt: 'go',
      tools: { middle: agentAsTool(middleRunner) },
    })

    assert.equal(result.text, 'parent done')
    assert.equal(leaf.calls.length, 0)
    middle.assertPromptContains('E_AI_SUBAGENT_DEPTH')
  })

  test('SubAgentApprovalError is fatal for the error classifier', ({ assert }) => {
    // Its message names the tool and the approval, so it must not be read as a retryable failure.
    const error = new SubAgentApprovalError('researcher', 'pay timed out')

    assert.equal(classifyError(error).kind, 'fatal')
  })
})
