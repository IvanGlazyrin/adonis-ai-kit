import { test } from '@japa/runner'
import { ApprovalNotFoundError, ApprovalSignatureError } from '../../../src/approvals/errors.js'
import { approvalSecret } from '../../../src/approvals/secret.js'
import { classifyError } from '../../../src/error_classifier.js'
import { ConversationConflictError } from '../../../src/conversations/errors.js'
import { AiException } from '../../../src/errors.js'
import { fakeModel } from '../../../src/testing/index.js'
import { JsonRowStore, SECRET, askOnce, dangerTools, managerFor, rejectionOf } from './helpers.js'

const ASK = { danger: 'ask' as const }

/** Pauses one run in `store`, and returns what the test needs to resolve it. */
async function pausedIn(store: JsonRowStore, script = askOnce()) {
  const model = fakeModel(script)
  const tools = dangerTools()
  const ai = managerFor(model, { store })
  const conversation = await ai.conversations.start('user:1')
  const turn = await ai.generateText({
    prompt: 'run it',
    tools: tools.tools,
    toolPermissions: ASK,
    approvals: 'resumable',
    conversation: { id: conversation.id, owner: 'user:1' },
  })
  return { ai, model, tools, conversation, approvalId: turn.pendingApprovals[0].approvalId }
}

test('forged approval: tampered tool input is rejected by HMAC', async ({ assert }) => {
  const store = new JsonRowStore()
  const { ai, model, tools, conversation, approvalId } = await pausedIn(store)
  store.tamper(conversation.id, (record) => {
    record.messages[1].content[0].input = { n: 999 }
  })

  const err = await rejectionOf(() =>
    ai.conversations.resolveApprovals(conversation.id, 'user:1', [{ approvalId, approved: true }], {
      tools: tools.tools,
      toolPermissions: ASK,
    })
  )

  assert.instanceOf(err, ApprovalSignatureError)
  assert.equal((err as AiException).code, 'E_AI_APPROVAL_INVALID')
  assert.lengthOf(tools.inputs.danger, 0)
  model.assertCalledTimes(1)
})

test('forged approval: request without signature is rejected', async ({ assert }) => {
  const store = new JsonRowStore()
  const { ai, model, tools, conversation, approvalId } = await pausedIn(store)
  store.tamper(conversation.id, (record) => {
    delete record.messages[1].content[1].signature
  })

  const err = await rejectionOf(() =>
    ai.conversations.resolveApprovals(conversation.id, 'user:1', [{ approvalId, approved: true }], {
      tools: tools.tools,
      toolPermissions: ASK,
    })
  )

  assert.instanceOf(err, ApprovalSignatureError)
  assert.equal((err as AiException).code, 'E_AI_APPROVAL_INVALID')
  assert.lengthOf(tools.inputs.danger, 0)
  model.assertCalledTimes(1)
})

test('forged approval: unknown approvalId is not-found', async ({ assert }) => {
  const store = new JsonRowStore()
  const model = fakeModel([
    { toolCalls: [{ name: 'danger', input: { n: 1 } }] },
    { toolCalls: [{ name: 'danger', input: { n: 2 } }] },
    { text: 'done' },
  ])
  const tools = dangerTools()
  const ai = managerFor(model, { store })
  const first = await ai.conversations.start('user:1')
  const second = await ai.conversations.start('user:1')
  const ask = { prompt: 'a', tools: tools.tools, toolPermissions: ASK, approvals: 'resumable' as const }
  await ai.generateText({ ...ask, conversation: { id: first.id, owner: 'user:1' } })
  const pausedSecond = await ai.generateText({ ...ask, conversation: { id: second.id, owner: 'user:1' } })

  const unknown = await rejectionOf(() =>
    ai.conversations.resolveApprovals(first.id, 'user:1', [{ approvalId: 'aitxt-made-up', approved: true }], {
      tools: tools.tools,
      toolPermissions: ASK,
    })
  )
  const fromOtherConversation = await rejectionOf(() =>
    ai.conversations.resolveApprovals(
      first.id,
      'user:1',
      [{ approvalId: pausedSecond.pendingApprovals[0].approvalId, approved: true }],
      { tools: tools.tools, toolPermissions: ASK }
    )
  )

  assert.instanceOf(unknown, ApprovalNotFoundError)
  assert.equal((unknown as AiException).code, 'E_AI_APPROVAL_NOT_FOUND')
  assert.instanceOf(fromOtherConversation, ApprovalNotFoundError)
  assert.lengthOf(tools.inputs.danger, 0)
})

test('replayed approval: second resolve is not-found and the tool ran once', async ({ assert }) => {
  const store = new JsonRowStore()
  const { ai, tools, conversation, approvalId } = await pausedIn(store)
  const decision = { tools: tools.tools, toolPermissions: ASK }

  await ai.conversations.resolveApprovals(conversation.id, 'user:1', [{ approvalId, approved: true }], decision)
  const again = await rejectionOf(() =>
    ai.conversations.resolveApprovals(conversation.id, 'user:1', [{ approvalId, approved: true }], decision)
  )

  assert.instanceOf(again, ApprovalNotFoundError)
  assert.lengthOf(tools.inputs.danger, 1)
})

test('concurrent resolve: one wins, tool ran once', async ({ assert }) => {
  const store = new JsonRowStore()
  const { ai, tools, conversation, approvalId } = await pausedIn(store)
  const decision = { tools: tools.tools, toolPermissions: ASK }

  const outcomes = await Promise.allSettled([
    ai.conversations.resolveApprovals(conversation.id, 'user:1', [{ approvalId, approved: true }], decision),
    ai.conversations.resolveApprovals(conversation.id, 'user:1', [{ approvalId, approved: true }], decision),
  ])

  const won = outcomes.filter((o) => o.status === 'fulfilled')
  const lost = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected')
  assert.lengthOf(won, 1)
  assert.lengthOf(lost, 1)
  assert.isTrue(lost[0].reason instanceof ConversationConflictError || lost[0].reason instanceof ApprovalNotFoundError)
  assert.lengthOf(tools.inputs.danger, 1)
})

test('secret never appears in logs, errors or JSON', async ({ assert }) => {
  const logs: string[] = []
  const record = (...args: unknown[]) => void logs.push(args.map(String).join(' '))
  const logger = { info: record, warn: record, error: record, debug: record }
  const store = new JsonRowStore()
  const model = fakeModel(askOnce())
  const tools = dangerTools()
  const ai = managerFor(model, { store, logger, approvals: { secret: approvalSecret(SECRET) } })
  const conversation = await ai.conversations.start('user:1')
  const turn = await ai.generateText({
    prompt: 'run it',
    tools: tools.tools,
    toolPermissions: ASK,
    approvals: 'resumable',
    conversation: { id: conversation.id, owner: 'user:1' },
  })
  store.tamper(conversation.id, (row) => {
    row.messages[1].content[0].input = { n: 999 }
  })
  const error = await rejectionOf(() =>
    ai.conversations.resolveApprovals(
      conversation.id,
      'user:1',
      [{ approvalId: turn.pendingApprovals[0].approvalId, approved: true }],
      { tools: tools.tools, toolPermissions: ASK }
    )
  )

  assert.notInclude(String(error), SECRET)
  assert.notInclude(JSON.stringify(ai.getConfig()), SECRET)
  assert.notInclude(JSON.stringify({ approvals: { secret: approvalSecret(SECRET) } }), SECRET)
  assert.notInclude(logs.join('\n'), SECRET)
  assert.notInclude(JSON.stringify([...store.rows.values()]), SECRET)
})

test('approval secret must be at least 32 bytes', ({ assert }) => {
  let thrown: unknown
  try {
    approvalSecret('short')
  } catch (err) {
    thrown = err
  }
  assert.equal((thrown as AiException)?.code, 'E_AI_CONFIG_ERROR')
})

test('approval errors are fatal: they never move a call to another model', ({ assert }) => {
  assert.equal(classifyError(new ApprovalSignatureError()).kind, 'fatal')
  assert.equal(classifyError(new ApprovalNotFoundError()).kind, 'fatal')
})
