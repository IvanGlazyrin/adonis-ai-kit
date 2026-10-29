import { test } from '@japa/runner'
import path from 'node:path'
import { buildAcpRuntimeConfig, resetAcpAgents } from '../../../src/acp/acp_agents.js'

const envOf = (vars: Record<string, string>) => (key: string) => vars[key]

const captureWarnings = () => {
  const warnings: string[] = []
  return { warnings, logger: { info() {}, debug() {}, error() {}, warn: (m: string) => void warnings.push(m) } as any }
}

test.group('acp runtime config, edge paths', (group) => {
  group.each.teardown(() => resetAcpAgents())

  test('an invalid MCP servers JSON is ignored with a warning', ({ assert }) => {
    const { warnings, logger } = captureWarnings()
    const cfg = buildAcpRuntimeConfig('claude-code', envOf({ ACP_CLAUDE_CODE_MCP_SERVERS: '{not json' }), {}, logger)

    assert.deepEqual(cfg?.mcpServers, [])
    assert.isTrue(warnings.some((w) => w.includes('Invalid MCP servers JSON for claude-code')))
  })

  test('an MCP servers value that is not an array is ignored silently', ({ assert }) => {
    const { warnings, logger } = captureWarnings()
    const cfg = buildAcpRuntimeConfig(
      'claude-code',
      envOf({ ACP_CLAUDE_CODE_MCP_SERVERS: JSON.stringify({ name: 'x', command: 'y' }) }),
      {},
      logger
    )

    assert.deepEqual(cfg?.mcpServers, [])
    assert.lengthOf(warnings, 0)
  })

  test('the working directory can be overridden and is made absolute', ({ assert }) => {
    const cfg = buildAcpRuntimeConfig('claude-code', envOf({ ACP_CLAUDE_CODE_CWD: 'work/here' }), {})

    assert.equal(cfg?.cwd, path.resolve('work/here'))
  })

  test('project MCP enabled without any path warns and adds nothing', ({ assert }) => {
    const { warnings, logger } = captureWarnings()
    const cfg = buildAcpRuntimeConfig(
      'claude-code',
      envOf({ ACP_CLAUDE_CODE_ENABLE_PROJECT_MCP: 'true' }),
      {},
      logger
    )

    assert.deepEqual(cfg?.mcpServers, [])
    assert.isTrue(warnings.some((w) => w.includes('ACP_CLAUDE_CODE_PROJECT_MCP_PATH is not')))
  })

  test('an unknown agent with no registration yields no runtime', ({ assert }) => {
    assert.isNull(buildAcpRuntimeConfig('not-an-agent', envOf({}), {}))
  })
})
