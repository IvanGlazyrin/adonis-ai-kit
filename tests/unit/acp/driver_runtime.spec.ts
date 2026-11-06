import { test } from '@japa/runner'
import path from 'node:path'
import { AcpDriver, buildAgentEnv } from '../../../src/acp/provider.js'
import type { AcpAgentRuntimeConfig } from '../../../src/acp/types.js'

test.group('AcpDriver prebuilt runtime', () => {
  test('uses the prebuilt mcpServers as-is even when ACP_<AGENT>_MCP_SERVERS is set', ({ assert }) => {
    const server = { name: 'one', command: 'node', args: [], env: [] }
    const runtime: AcpAgentRuntimeConfig = {
      command: 'fake-agent',
      args: ['--acp'],
      cwd: path.resolve('.'),
      env: { ANTHROPIC_API_KEY: 'k' },
      mcpServers: [server as any],
    }
    const env = {
      PATH: '/bin',
      SECRET: 'x',
      ACP_CLAUDE_CODE_MCP_SERVERS: JSON.stringify([{ name: 'two', command: 'node', args: [] }]),
    }
    const driver = new AcpDriver('acp', { driver: 'acp', agentId: 'claude-code' } as any, {
      env,
      runtime,
    })
    const resolved = (driver as any).resolveRuntimeConfig('claude-code') as AcpAgentRuntimeConfig
    assert.deepEqual(resolved.mcpServers, [server])
    assert.equal(resolved.command, 'fake-agent')
    assert.deepEqual(resolved.args, ['--acp'])
    assert.equal(resolved.env.ANTHROPIC_API_KEY, 'k')
    assert.equal(resolved.env.SECRET, '')
  })

  test('prebuilt runtime still requires an absolute cwd', ({ assert }) => {
    const driver = new AcpDriver('acp', { driver: 'acp' } as any, {
      runtime: { command: 'c', args: [], cwd: 'relative', env: {}, mcpServers: [] },
    })
    assert.throws(() => (driver as any).resolveRuntimeConfig('claude-code'), /absolute/)
  })

  test('blanks process.env keys that are missing from a custom env source', ({ assert }) => {
    const key = 'ADONIS_AI_TEST_ONLY_IN_PROCESS_ENV'
    process.env[key] = 'leak'
    try {
      const env = buildAgentEnv({ PATH: '/bin' }, { TOKEN: 't' })
      assert.equal(env[key], '')
      assert.equal(env.PATH, '/bin')
      assert.equal(env.TOKEN, 't')
    } finally {
      delete process.env[key]
    }
  })
})

test.group('AcpDriver prebuilt runtime environment', () => {
  const runtime: AcpAgentRuntimeConfig = {
    command: 'fake-agent',
    args: [],
    cwd: path.resolve('.'),
    env: { SHARED: 'from-runtime', RUNTIME_ONLY: 'r' },
    mcpServers: [],
  }

  test('config.env is merged over runtime.env, and both reach the agent without inheritEnv', ({ assert }) => {
    const driver = new AcpDriver('acp', { driver: 'acp', env: { SHARED: 'from-config', HTTPS_PROXY: 'http://p' } } as any, {
      env: { PATH: '/bin' },
      runtime,
    })
    const resolved = (driver as any).resolveRuntimeConfig('claude-code') as AcpAgentRuntimeConfig
    assert.equal(resolved.env.SHARED, 'from-config')
    assert.equal(resolved.env.RUNTIME_ONLY, 'r')
    assert.equal(resolved.env.HTTPS_PROXY, 'http://p')
    assert.equal(resolved.env.PATH, '/bin')
  })

  test('with inheritEnv, config.env still wins and the server environment is not copied in', ({ assert }) => {
    const driver = new AcpDriver(
      'acp',
      { driver: 'acp', inheritEnv: true, env: { SHARED: 'from-config' } } as any,
      { env: { SECRET_FROM_SERVER: 'leak' }, runtime }
    )
    const resolved = (driver as any).resolveRuntimeConfig('claude-code') as AcpAgentRuntimeConfig
    assert.equal(resolved.env.SHARED, 'from-config')
    assert.equal(resolved.env.RUNTIME_ONLY, 'r')
    assert.isUndefined(resolved.env.SECRET_FROM_SERVER)
  })
})
