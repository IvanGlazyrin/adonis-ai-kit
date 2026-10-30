import { test } from '@japa/runner'
import { tool } from 'ai'
import { z } from 'zod'
import { fakeApiError, fakeModel } from '../../../src/testing/index.js'
import { JsonRowStore, askOnce, managerFor } from './helpers.js'

const ASK = { danger: 'ask' as const }

/** A tool that counts its executions in `counter`, which the test shares with every manager it creates. */
const countingTools = (counter: { danger: number }) => ({
  danger: tool({
    description: 'counts runs',
    inputSchema: z.any(),
    execute: async () => {
      counter.danger++
      return { ok: 1 }
    },
  }),
})

test('restart: a paused run resumes in a fresh manager', async ({ assert }) => {
  const counter = { danger: 0 }
  const storeA = new JsonRowStore()
  const aiA = managerFor(fakeModel(askOnce()), { store: storeA })
  const conversation = await aiA.conversations.start('user:1')
  const paused = await aiA.generateText({
    prompt: 'run it',
    tools: countingTools(counter),
    toolPermissions: ASK,
    approvals: 'resumable',
    conversation: { id: conversation.id, owner: 'user:1' },
  })
  assert.equal(counter.danger, 0)

  // Restart: a new store holding the same rows, a new manager, new tools and a new model.
  const storeB = new JsonRowStore()
  storeA.copyRowsTo(storeB)
  const modelB = fakeModel([{ text: 'done' }])
  const aiB = managerFor(modelB, { store: storeB })
  const result = await aiB.conversations.resolveApprovals(
    conversation.id,
    'user:1',
    [{ approvalId: paused.pendingApprovals[0].approvalId, approved: true }],
    { tools: countingTools(counter), toolPermissions: ASK }
  )

  assert.equal(counter.danger, 1)
  assert.equal(result.text, 'done')
  assert.include(JSON.stringify(modelB.calls[0].prompt), '"tool-result"')
  const stored = await storeB.load(conversation.id, 'user:1')
  assert.deepEqual(
    stored?.messages.map((m) => m.role),
    ['user', 'assistant', 'tool', 'assistant']
  )
})

test('model fails after the approved tool ran: resume does not run the tool again', async ({ assert }) => {
  const counter = { danger: 0 }
  const store = new JsonRowStore()
  const model = fakeModel([
    { toolCalls: [{ name: 'danger', input: { n: 1 } }] },
    { error: fakeApiError(400) },
    { text: 'done' },
  ])
  const ai = managerFor(model, { store })
  const conversation = await ai.conversations.start('user:1')
  const paused = await ai.generateText({
    prompt: 'run it',
    tools: countingTools(counter),
    toolPermissions: ASK,
    approvals: 'resumable',
    conversation: { id: conversation.id, owner: 'user:1' },
  })
  const approvalId = paused.pendingApprovals[0].approvalId

  // The tool runs, then the model call fails: the turn is not stored.
  const failed = await ai.conversations
    .resolveApprovals(conversation.id, 'user:1', [{ approvalId, approved: true }], {
      tools: countingTools(counter),
      toolPermissions: ASK,
    })
    .catch((err: unknown) => err)
  assert.isDefined(failed)
  assert.equal(counter.danger, 1)

  const retry = await ai.conversations.resume(conversation.id, 'user:1', {
    tools: countingTools(counter),
    toolPermissions: ASK,
  })

  assert.equal(retry.text, 'done')
  assert.equal(counter.danger, 1)
  // The retry sends the stored result, not a placeholder.
  const sent = JSON.stringify(model.calls[2].prompt)
  assert.include(sent, '\"ok\":1')
  assert.notInclude(sent, 'outcome unknown')
})

test('crash inside tool: resume reports unknown outcome and does not re-run', async ({ assert }) => {
  const counter = { danger: 0 }
  const store = new JsonRowStore()
  const model = fakeModel([{ toolCalls: [{ name: 'danger', input: { n: 1 } }] }, { text: 'done' }])
  const ai = managerFor(model, { store })
  const conversation = await ai.conversations.start('user:1')
  await ai.generateText({
    prompt: 'run it',
    tools: countingTools(counter),
    toolPermissions: ASK,
    approvals: 'resumable',
    conversation: { id: conversation.id, owner: 'user:1' },
  })
  // The process died inside the tool: the approval is marked as executing, with no result.
  store.tamper(conversation.id, (record) => {
    record.state.approvals[0].approved = true
    record.state.approvals[0].status = 'executing'
  })

  const result = await ai.conversations.resume(conversation.id, 'user:1', {
    tools: countingTools(counter),
    toolPermissions: ASK,
  })

  assert.equal(counter.danger, 0)
  assert.equal(result.text, 'done')
  assert.include(JSON.stringify(model.calls[1].prompt), 'outcome unknown after restart')
})
