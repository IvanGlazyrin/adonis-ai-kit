import { test } from '@japa/runner'
import { tool } from 'ai'
import { z } from 'zod'
import { MemoryConversationStore } from '../../../src/conversations/memory_store.js'
import { fakeModel } from '../../../src/testing/index.js'
import { managerFor } from './helpers.js'

/** A `pay` tool declared with the AI SDK's own `needsApproval`; `runs` lists the inputs it ran with. */
function nativeTool(needsApproval: boolean | ((input: { n: number }) => boolean) = true) {
  const runs: unknown[] = []
  const pay = tool({
    description: 'pay',
    inputSchema: z.object({ n: z.number() }),
    needsApproval,
    execute: async (input) => {
      runs.push(input)
      return { paid: input.n }
    },
  })
  return { tools: { pay }, runs }
}

const payOnce = (n = 1) => [{ toolCalls: [{ name: 'pay', input: { n } }] }, { text: 'done' }]

test.group('approvals: a tool with native needsApproval', () => {
  test('blocking: the call asks the confirmation service and runs the tool once approved', async ({ assert }) => {
    const ai = managerFor(fakeModel(payOnce()))
    const { tools, runs } = nativeTool()
    const asked: string[] = []
    ai.getConfirmationService().onActionCreated((action) => {
      asked.push(action.toolName)
      ai.getConfirmationService().approve(action.id)
    })

    const result = await ai.generateText({ prompt: 'pay', tools, maxSteps: 2 })

    assert.deepEqual(asked, ['pay'])
    assert.deepEqual(runs, [{ n: 1 }])
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.pendingApprovals, [])
    assert.equal(result.text, 'done')
  })

  test('blocking: a rejected confirmation does not run the tool, and the model sees why', async ({ assert }) => {
    const ai = managerFor(fakeModel(payOnce()))
    const { tools, runs } = nativeTool()
    ai.getConfirmationService().onActionCreated((action) => ai.getConfirmationService().reject(action.id, 'no'))

    const result = await ai.generateText({ prompt: 'pay', tools, maxSteps: 2 })

    assert.lengthOf(runs, 0)
    const [step] = result.steps as Array<{ toolResults: Array<{ output: { error?: string } }> }>
    const output = step.toolResults[0]?.output
    assert.include(output.error, 'was not executed: rejected')
  })

  test('blocking: a needsApproval function asks only for the calls it marks', async ({ assert }) => {
    const ai = managerFor(fakeModel([{ toolCalls: [{ name: 'pay', input: { n: 1 } }, { name: 'pay', input: { n: 500 } }] }, { text: 'done' }]))
    const { tools, runs } = nativeTool((input) => input.n > 100)
    const asked: unknown[] = []
    ai.getConfirmationService().onActionCreated((action) => {
      asked.push(action.params)
      ai.getConfirmationService().approve(action.id)
    })

    await ai.generateText({ prompt: 'pay', tools, maxSteps: 2 })

    assert.deepEqual(asked, [{ n: 500 }])
    assert.sameDeepMembers(runs, [{ n: 1 }, { n: 500 }])
  })

  test('blocking: an explicit allow does not skip the tool\'s own approval', async ({ assert }) => {
    const ai = managerFor(fakeModel(payOnce()))
    const { tools, runs } = nativeTool()
    const asked: string[] = []
    ai.getConfirmationService().onActionCreated((action) => {
      asked.push(action.toolName)
      ai.getConfirmationService().approve(action.id)
    })

    await ai.generateText({ prompt: 'pay', tools, toolPermissions: { pay: 'allow' }, maxSteps: 2 })

    assert.deepEqual(asked, ['pay'])
    assert.deepEqual(runs, [{ n: 1 }])
  })

  test('blocking: streamText asks the confirmation service in the same way', async ({ assert }) => {
    const ai = managerFor(fakeModel(payOnce()))
    const { tools, runs } = nativeTool()
    ai.getConfirmationService().onActionCreated((action) => ai.getConfirmationService().approve(action.id))

    const stream = await ai.streamText({ prompt: 'pay', tools, maxSteps: 2 })
    const result = await stream.consume()

    assert.deepEqual(runs, [{ n: 1 }])
    assert.equal(result.status, 'completed')
    assert.equal(result.text, 'done')
  })

  test('resumable: behaves as before (the kit\'s toolApproval decides, the confirmation service is not used)', async ({ assert }) => {
    const ai = managerFor(fakeModel(payOnce()), { store: new MemoryConversationStore() })
    const { tools, runs } = nativeTool()
    const asked: unknown[] = []
    ai.getConfirmationService().onActionCreated((action) => asked.push(action))
    const conversation = await ai.conversations.start('user:1')

    const result = await ai.generateText({
      prompt: 'pay',
      tools,
      approvals: 'resumable',
      conversation: { id: conversation.id, owner: 'user:1' },
      maxSteps: 2,
    })

    assert.lengthOf(asked, 0)
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.pendingApprovals, [])
    assert.deepEqual(runs, [{ n: 1 }])
  })

  test('resumable: an ask permission on it still pauses at a signed approval request', async ({ assert }) => {
    const ai = managerFor(fakeModel(payOnce()), { store: new MemoryConversationStore() })
    const { tools, runs } = nativeTool()
    const conversation = await ai.conversations.start('user:1')

    const result = await ai.generateText({
      prompt: 'pay',
      tools,
      toolPermissions: { pay: 'ask' },
      approvals: 'resumable',
      conversation: { id: conversation.id, owner: 'user:1' },
      maxSteps: 2,
    })

    assert.equal(result.status, 'awaiting-approval')
    assert.lengthOf(result.pendingApprovals, 1)
    assert.lengthOf(runs, 0)
  })

  test('a tool without needsApproval runs without a confirmation, as before', async ({ assert }) => {
    const ai = managerFor(fakeModel(payOnce()))
    const runs: unknown[] = []
    const pay = tool({
      inputSchema: z.object({ n: z.number() }),
      execute: async (input) => {
        runs.push(input)
        return { paid: input.n }
      },
    })
    const asked: unknown[] = []
    ai.getConfirmationService().onActionCreated((action) => asked.push(action))

    const result = await ai.generateText({ prompt: 'pay', tools: { pay }, maxSteps: 2 })

    assert.lengthOf(asked, 0)
    assert.deepEqual(runs, [{ n: 1 }])
    assert.equal(result.status, 'completed')
  })
})
