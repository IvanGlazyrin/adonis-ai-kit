import { test } from '@japa/runner'
import { AcpDriver } from '../../../src/acp/provider.js'

const options = [
  { optionId: 'once', kind: 'allow_once', name: 'Allow' },
  { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
]

const driver = (permissionPolicy: string) =>
  new AcpDriver('acp', { driver: 'acp', agentId: 'claude-code', permissionPolicy } as any, { env: {} })

/** A model whose connect installs the permission handler on a client; `client` may be absent. */
const modelWith = (client: unknown, connect: () => Promise<void> = async () => {}) => {
  const model: any = { connectClient: connect, client }
  return model
}

test.group('AcpDriver permission handler installation', () => {
  test('connecting installs a handler that answers with the driver policy', async ({ assert }) => {
    let installed: ((params: unknown) => Promise<unknown>) | undefined
    const model = modelWith({ setPermissionRequestHandler: (h: any) => (installed = h) })

    ;(driver('allow') as any).installPermissionHandler(model, 'claude-code')
    await model.connectClient()

    assert.isFunction(installed)
    const answer = await installed!({ options, toolCall: { title: 'Read' } })
    assert.deepEqual(answer, { outcome: { outcome: 'selected', optionId: 'once' } })
  })

  test('an agent client without a permission hook is refused, not run unguarded', async ({ assert }) => {
    const model = modelWith({})

    ;(driver('ask') as any).installPermissionHandler(model, 'claude-code')

    await assert.rejects(() => model.connectClient(), /refusing to run the agent without permission control/)
  })

  test('a failure while connecting is passed through and nothing is installed', async ({ assert }) => {
    let installed = false
    const model = modelWith(
      { setPermissionRequestHandler: () => (installed = true) },
      async () => {
        throw new Error('no route to agent')
      }
    )

    ;(driver('ask') as any).installPermissionHandler(model, 'claude-code')

    await assert.rejects(() => model.connectClient(), 'no route to agent')
    assert.isFalse(installed)
  })
})
