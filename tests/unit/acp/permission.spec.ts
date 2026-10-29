import { test } from '@japa/runner'
import { AcpDriver } from '../../../src/acp/provider.js'

const options = [
  { optionId: 'a-once', kind: 'allow_once', name: 'Allow' },
  { optionId: 'a-always', kind: 'allow_always', name: 'Always' },
  { optionId: 'r-once', kind: 'reject_once', name: 'Reject' },
]
const request = (opts: typeof options = options) =>
  ({
    sessionId: 's1',
    options: opts,
    toolCall: { title: 'Write file', kind: 'edit', rawInput: { path: 'x' }, locations: [] },
  }) as any

const driver = (permissionPolicy: string, confirmation?: unknown) =>
  new AcpDriver('acp', { driver: 'acp', agentId: 'claude-code', permissionPolicy } as any, {
    confirmation: confirmation as any,
  })

const answer = (d: AcpDriver, params = request()) => (d as any).answerPermission(params, 'claude-code')

test.group('AcpDriver permission answers', () => {
  test('deny policy rejects with the reject option', async ({ assert }) => {
    const res = await answer(driver('deny'))
    assert.deepEqual(res, { outcome: { outcome: 'selected', optionId: 'r-once' } })
  })

  test('deny policy cancels when the agent offers no reject option', async ({ assert }) => {
    const res = await answer(driver('deny'), request([options[0]!]))
    assert.deepEqual(res, { outcome: { outcome: 'cancelled' } })
  })

  test('allow policy picks allow_once and never allow_always', async ({ assert }) => {
    const res = await answer(driver('allow'))
    assert.deepEqual(res, { outcome: { outcome: 'selected', optionId: 'a-once' } })
  })

  test('allow policy rejects when only allow_always is offered', async ({ assert }) => {
    const res = await answer(driver('allow'), request([options[1]!, options[2]!]))
    assert.deepEqual(res, { outcome: { outcome: 'selected', optionId: 'r-once' } })
  })

  test('ask policy without a confirmation service rejects', async ({ assert }) => {
    const res = await answer(driver('ask'))
    assert.deepEqual(res, { outcome: { outcome: 'selected', optionId: 'r-once' } })
  })

  test('ask policy allows when the human approves, and passes the tool details along', async ({ assert }) => {
    const seen: any[] = []
    const confirmation = {
      waitForResponse: async (action: unknown, timeoutMs: unknown) => {
        seen.push({ action, timeoutMs })
        return { status: 'approved' }
      },
    }

    const res = await answer(driver('ask', confirmation))

    assert.deepEqual(res, { outcome: { outcome: 'selected', optionId: 'a-once' } })
    assert.equal(seen[0].action.toolName, 'acp:claude-code')
    assert.equal(seen[0].action.action, 'Write file')
    assert.equal(seen[0].action.sessionId, 's1')
    assert.deepEqual(seen[0].action.params, { kind: 'edit', rawInput: { path: 'x' }, locations: [] })
  })

  test('ask policy rejects when the human declines', async ({ assert }) => {
    const confirmation = { waitForResponse: async () => ({ status: 'rejected' }) }
    const res = await answer(driver('ask', confirmation))
    assert.deepEqual(res, { outcome: { outcome: 'selected', optionId: 'r-once' } })
  })

  test('falls back to the tool kind, then a generic label, when the title is missing', async ({ assert }) => {
    const labels: string[] = []
    const confirmation = {
      waitForResponse: async (action: { action: string }) => {
        labels.push(action.action)
        return { status: 'approved' }
      },
    }
    await answer(driver('ask', confirmation), { ...request(), toolCall: { kind: 'read' } })
    await answer(driver('ask', confirmation), { ...request(), toolCall: undefined })
    assert.deepEqual(labels, ['read', 'agent action'])
  })
})
