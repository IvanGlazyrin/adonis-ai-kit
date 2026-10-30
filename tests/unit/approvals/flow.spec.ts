import { test } from '@japa/runner'
import { generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { AiManager } from '../../../src/ai_manager.js'
import { toolApprovalFor } from '../../../src/approvals/resumable.js'
import { ApprovalIncompleteError } from '../../../src/approvals/errors.js'
import { ToolRegistry } from '../../../src/guard/registry.js'
import { defineConfig } from '../../../src/define_config.js'
import { AiException } from '../../../src/errors.js'
import { ConversationNotFoundError } from '../../../src/conversations/errors.js'
import { MemoryConversationStore } from '../../../src/conversations/memory_store.js'
import { fakeApiError, fakeLanguageModels, fakeModel, fakeProvider, fakeResolver } from '../../../src/testing/index.js'
import { SECRET, askOnce, dangerTools, managerFor, quiet, rejectionOf } from './helpers.js'

const ASK = { danger: 'ask' as const }

/** A paused run: manager, model, tools and the conversation, with one pending approval for `danger`. */
async function paused(script = askOnce(), options: Parameters<typeof managerFor>[1] = {}) {
  const store = options.store ?? new MemoryConversationStore()
  const model = fakeModel(script)
  const tools = dangerTools()
  const ai = managerFor(model, { ...options, store })
  const conversation = await ai.conversations.start('user:1')
  const turn = await ai.generateText({
    prompt: 'run it',
    tools: tools.tools,
    toolPermissions: ASK,
    approvals: 'resumable',
    conversation: { id: conversation.id, owner: 'user:1' },
  })
  return { ai, model, tools, store, conversation, turn }
}

test('sdk: user-approval stops the loop and the response keeps a signed request', async ({ assert }) => {
  const model = fakeModel(askOnce())
  const tools = dangerTools()
  const result = await generateText({
    model: model as never,
    tools: tools.tools,
    toolApproval: { danger: 'user-approval' },
    experimental_toolApprovalSecret: SECRET,
    prompt: 'go',
  })

  assert.lengthOf(tools.inputs.danger, 0)
  const parts = result.response.messages.flatMap((m) =>
    Array.isArray(m.content) ? (m.content as unknown as Array<{ type: string; signature?: string }>) : []
  )
  const request = parts.find((part) => part.type === 'tool-approval-request')
  assert.isString(request?.signature)
})

test('resumable: ask maps to user-approval, allow to not-applicable, deny is dropped', ({ assert }) => {
  const tools = { ask: {}, allow: {}, deny: {} } as never
  const mapped = toolApprovalFor(tools, { ask: 'ask', allow: 'allow', deny: 'deny' })
  assert.deepEqual(mapped, { ask: 'user-approval', allow: 'not-applicable' })
})

test('resumable: run pauses on an ask tool and stores the pending approval', async ({ assert }) => {
  const store = new MemoryConversationStore()
  const model = fakeModel(askOnce())
  const tools = dangerTools()
  const ai = managerFor(model, { store })
  const created: unknown[] = []
  ai.getConfirmationService().onActionCreated((action) => created.push(action))
  const conversation = await ai.conversations.start('user:1')

  const result = await ai.generateText({
    prompt: 'run it',
    tools: tools.tools,
    toolPermissions: ASK,
    approvals: 'resumable',
    conversation: { id: conversation.id, owner: 'user:1' },
  })

  assert.equal(result.status, 'awaiting-approval')
  assert.lengthOf(result.pendingApprovals, 1)
  const [pending] = result.pendingApprovals
  assert.equal(pending.toolName, 'danger')
  assert.deepEqual(pending.input, { n: 1 })
  assert.instanceOf(pending.expiresAt, Date)
  const stored = await store.load(conversation.id, 'user:1')
  assert.lengthOf((stored?.state as { approvals: unknown[] }).approvals, 1)
  assert.lengthOf(created, 0)
  assert.lengthOf(tools.inputs.danger, 0)
})

test('resumable without conversation is a config error', async ({ assert }) => {
  const model = fakeModel(askOnce())
  const ai = managerFor(model)
  const err = await rejectionOf(() =>
    ai.generateText({ prompt: 'go', tools: dangerTools().tools, toolPermissions: ASK, approvals: 'resumable' })
  )
  assert.equal((err as AiException).code, 'E_AI_CONFIG_ERROR')
  model.assertCalledTimes(0)
})

test('resumable without secret is a config error', async ({ assert }) => {
  const model = fakeModel(askOnce())
  const ai = managerFor(model, { approvals: { secret: undefined } })
  const conversation = await ai.conversations.start('user:1')
  const err = await rejectionOf(() =>
    ai.generateText({
      prompt: 'go',
      tools: dangerTools().tools,
      toolPermissions: ASK,
      approvals: 'resumable',
      conversation: { id: conversation.id, owner: 'user:1' },
    })
  )
  assert.equal((err as AiException).code, 'E_AI_CONFIG_ERROR')
  model.assertCalledTimes(0)
})

test('short secret is rejected', ({ assert }) => {
  const config = defineConfig({
    default: 'main',
    providers: { main: fakeProvider(fakeModel([{ text: 'x' }])) },
    catalog: { autoPricing: false },
    approvals: { secret: 'too-short' },
  } as never)
  let thrown: unknown
  try {
    new AiManager(config, quiet)
  } catch (err) {
    thrown = err
  }
  assert.equal((thrown as AiException)?.code, 'E_AI_CONFIG_ERROR')
})

test('volatile store needs allowVolatileStore', async ({ assert }) => {
  const volatile = await paused(askOnce(), { approvals: { allowVolatileStore: true } })
  assert.equal(volatile.turn.status, 'awaiting-approval')

  const model = fakeModel(askOnce())
  const strict = managerFor(model, { store: new MemoryConversationStore(), approvals: { allowVolatileStore: false } })
  const conversation = await strict.conversations.start('user:1')
  const err = await rejectionOf(() =>
    strict.generateText({
      prompt: 'go',
      tools: dangerTools().tools,
      toolPermissions: ASK,
      approvals: 'resumable',
      conversation: { id: conversation.id, owner: 'user:1' },
    })
  )
  assert.equal((err as AiException).code, 'E_AI_CONFIG_ERROR')
  model.assertCalledTimes(0)
})

test('resolve approved: tool runs once and the model sees its result', async ({ assert }) => {
  const { ai, model, tools, store, conversation, turn } = await paused()
  const approvalId = turn.pendingApprovals[0].approvalId

  const result = await ai.conversations.resolveApprovals(
    conversation.id,
    'user:1',
    [{ approvalId, approved: true }],
    { tools: tools.tools, toolPermissions: ASK }
  )

  assert.lengthOf(tools.inputs.danger, 1)
  assert.equal(result.text, 'done')
  assert.equal(result.status, 'completed')
  assert.include(JSON.stringify(model.calls[1].prompt), '"tool-result"')
  const stored = await store.load(conversation.id, 'user:1')
  assert.isNull(stored?.state)
  assert.deepEqual(
    stored?.messages.map((m) => m.role),
    ['user', 'assistant', 'tool', 'assistant']
  )
})

test('resolve denied: tool never runs, model sees execution-denied with the reason', async ({ assert }) => {
  const { ai, model, tools, conversation, turn } = await paused()
  const approvalId = turn.pendingApprovals[0].approvalId

  await ai.conversations.resolveApprovals(
    conversation.id,
    'user:1',
    [{ approvalId, approved: false, reason: 'not today' }],
    { tools: tools.tools, toolPermissions: ASK }
  )

  assert.lengthOf(tools.inputs.danger, 0)
  const sent = JSON.stringify(model.calls[1].prompt)
  assert.include(sent, 'execution-denied')
  assert.include(sent, 'not today')
})

test('resolve with a foreign owner is not-found and nothing runs', async ({ assert }) => {
  const { ai, model, tools, conversation, turn } = await paused()
  const approvalId = turn.pendingApprovals[0].approvalId

  const err = await rejectionOf(() =>
    ai.conversations.resolveApprovals(conversation.id, 'user:2', [{ approvalId, approved: true }], {
      tools: tools.tools,
      toolPermissions: ASK,
    })
  )

  assert.instanceOf(err, ConversationNotFoundError)
  assert.lengthOf(tools.inputs.danger, 0)
  model.assertCalledTimes(1)
})

test('partial decisions are rejected', async ({ assert }) => {
  const { ai, store, tools, conversation } = await paused(
    [{ toolCalls: [{ name: 'danger', input: { n: 1 } }, { name: 'danger', input: { n: 2 } }] }, { text: 'done' }]
  )
  const before = await store.load(conversation.id, 'user:1')
  const first = (before?.state as { approvals: Array<{ approvalId: string }> }).approvals[0].approvalId

  const err = await rejectionOf(() =>
    ai.conversations.resolveApprovals(conversation.id, 'user:1', [{ approvalId: first, approved: true }], {
      tools: tools.tools,
      toolPermissions: ASK,
    })
  )

  assert.instanceOf(err, ApprovalIncompleteError)
  assert.equal((err as AiException).code, 'E_AI_APPROVAL_INCOMPLETE')
  const after = await store.load(conversation.id, 'user:1')
  assert.equal(after?.version, before?.version)
  assert.lengthOf(tools.inputs.danger, 0)
})

test('expired approval is denied on resume even if approved', async ({ assert }) => {
  let clock = new Date('2030-01-01T00:00:00Z')
  const { ai, model, tools, conversation, turn } = await paused(askOnce(), {
    approvals: { ttlMs: 1000, now: () => clock },
  })
  const approvalId = turn.pendingApprovals[0].approvalId
  clock = new Date(clock.getTime() + 2000)

  const result = await ai.conversations.resolveApprovals(
    conversation.id,
    'user:1',
    [{ approvalId, approved: true }],
    { tools: tools.tools, toolPermissions: ASK }
  )

  assert.lengthOf(tools.inputs.danger, 0)
  assert.deepEqual(result.expiredApprovalIds, [approvalId])
  const sent = JSON.stringify(model.calls[1].prompt)
  assert.include(sent, 'execution-denied')
  assert.include(sent, 'expired')
})

test('stream: pauses and stores pending approvals at the end', async ({ assert }) => {
  const store = new MemoryConversationStore()
  const model = fakeModel(askOnce())
  const tools = dangerTools()
  const ai = managerFor(model, { store })
  const conversation = await ai.conversations.start('user:1')

  const stream = await ai.streamText({
    prompt: 'run it',
    tools: tools.tools,
    toolPermissions: ASK,
    approvals: 'resumable',
    conversation: { id: conversation.id, owner: 'user:1' },
  })
  const outcome = await stream.consume()

  assert.equal(outcome.status, 'awaiting-approval')
  assert.lengthOf(outcome.pendingApprovals, 1)
  assert.lengthOf(tools.inputs.danger, 0)
  const stored = await store.load(conversation.id, 'user:1')
  assert.lengthOf((stored?.state as { approvals: unknown[] }).approvals, 1)
})

test('stream: resume after approval', async ({ assert }) => {
  const store = new MemoryConversationStore()
  const model = fakeModel(askOnce())
  const tools = dangerTools()
  const ai = managerFor(model, { store })
  const conversation = await ai.conversations.start('user:1')
  const stream = await ai.streamText({
    prompt: 'run it',
    tools: tools.tools,
    toolPermissions: ASK,
    approvals: 'resumable',
    conversation: { id: conversation.id, owner: 'user:1' },
  })
  const outcome = await stream.consume()
  const approvalId = outcome.pendingApprovals[0].approvalId

  const done = await ai.conversations.resolveApprovals(
    conversation.id,
    'user:1',
    [{ approvalId, approved: true }],
    { tools: tools.tools, toolPermissions: ASK }
  )

  assert.equal(done.text, 'done')
  assert.lengthOf(tools.inputs.danger, 1)
})

test('no fallback after an approved tool ran', async ({ assert }) => {
  const modelA = fakeModel([{ toolCalls: [{ name: 'danger', input: { n: 1 } }] }, { error: fakeApiError(429) }])
  const modelB = fakeModel([{ text: 'must not run' }])
  const store = new MemoryConversationStore()
  const ai = new AiManager(
    defineConfig({
      default: 'main',
      providers: { main: fakeProvider(modelA) },
      catalog: { autoPricing: false },
      conversations: { store },
      approvals: { secret: SECRET, allowVolatileStore: true },
      languageModels: fakeLanguageModels({ 'fake/a': modelA, 'fake/b': modelB }),
      resolver: fakeResolver(),
    } as never),
    quiet
  )
  const tools = dangerTools()
  const models = ['fake/a', 'fake/b']
  const conversation = await ai.conversations.start('user:1')
  const paused = await ai.generateText({
    prompt: 'run it',
    models,
    tools: tools.tools,
    toolPermissions: ASK,
    approvals: 'resumable',
    conversation: { id: conversation.id, owner: 'user:1' },
  })
  const approvalId = paused.pendingApprovals[0].approvalId

  const err = await rejectionOf(() =>
    ai.conversations.resolveApprovals(conversation.id, 'user:1', [{ approvalId, approved: true }], {
      models,
      maxRetries: 0,
      tools: tools.tools,
      toolPermissions: ASK,
    })
  )

  assert.isDefined(err)
  assert.lengthOf(tools.inputs.danger, 1)
  modelB.assertCalledTimes(0)
})

test('registry: getToolsWithApprovals returns user-approval for ask and keeps the guard', async ({ assert }) => {
  const registry = new ToolRegistry()
  const ran: unknown[] = []
  const danger = tool({ description: 'd', inputSchema: z.object({}), execute: async (input) => (ran.push(input), 'ok') })
  registry.registerTool('danger', danger as never)
  registry.registerTool('safe', danger as never)
  const guard = { check: (name: string) => (name === 'danger' ? 'blocked by policy' : null) }

  const { tools, toolApproval } = registry.getToolsWithApprovals('agent', {
    permissions: { danger: 'ask', safe: 'allow' },
    guard,
  })

  assert.deepEqual(toolApproval, { danger: 'user-approval', safe: 'not-applicable' })
  const refused = await (tools.danger as { execute: (i: unknown, o: unknown) => Promise<{ error: string }> }).execute({}, {})
  assert.include(refused.error, 'blocked by policy')
  assert.lengthOf(ran, 0)
})

test('pendingApprovals lists the open approvals of a conversation', async ({ assert }) => {
  const { ai, conversation } = await paused()
  const open = await ai.conversations.pendingApprovals(conversation.id, 'user:1')
  assert.lengthOf(open, 1)
  assert.equal(open[0].toolName, 'danger')
  assert.instanceOf(await rejectionOf(() => ai.conversations.pendingApprovals(conversation.id, 'user:2')), ConversationNotFoundError)
})

test('provider-executed tool with ask is a config error', async ({ assert }) => {
  const model = fakeModel(askOnce())
  const ai = managerFor(model)
  const conversation = await ai.conversations.start('user:1')
  const providerTool = { type: 'provider', id: 'test.search', args: {}, inputSchema: { type: 'object' } }
  const err = await rejectionOf(() =>
    ai.generateText({
      prompt: 'search',
      tools: { web: providerTool as never },
      toolPermissions: { web: 'ask' },
      approvals: 'resumable',
      conversation: { id: conversation.id, owner: 'user:1' },
    })
  )
  assert.equal((err as AiException).code, 'E_AI_CONFIG_ERROR')
  model.assertCalledTimes(0)
})
