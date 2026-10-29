import { test } from '@japa/runner'
import { AcpDriver } from '../../../src/acp/provider.js'

const driverFor = (agentId = 'claude-code') =>
  new AcpDriver('acp', { driver: 'acp', agentId } as any, { env: {} })

test.group('AcpDriver lifecycle', () => {
  test('ping reports a built-in agent whose SDK package is missing, with the reason', async ({ assert }) => {
    const result = await driverFor().ping()

    assert.isFalse(result.ok)
    assert.isNumber(result.latencyMs)
    assert.include(result.error!, 'Package "@mcpc-tech/acp-ai-provider" is required to use ACP drivers')
  })

  test('ping reports an unknown agent as not ok without loading anything', async ({ assert }) => {
    const result = await driverFor('no-such-agent').ping()

    assert.isFalse(result.ok)
    assert.include(result.error!, 'Unknown ACP agent "no-such-agent"')
  })

  test('a failed model is not cached: the next request tries again', async ({ assert }) => {
    const driver = driverFor()

    await assert.rejects(() => driver.getModel(), /is required to use ACP drivers/)
    await assert.rejects(() => driver.getModel(), /is required to use ACP drivers/)
  })

  test('shutdown is safe with nothing started, and safe to call twice', async ({ assert }) => {
    const driver = driverFor()

    assert.isUndefined(await driver.shutdown())
    assert.isUndefined(await driver.shutdown())
  })
})
