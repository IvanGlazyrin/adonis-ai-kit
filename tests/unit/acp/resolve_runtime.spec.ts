import path from 'node:path'
import { test } from '@japa/runner'
import { AcpDriver } from '../../../src/acp/provider.js'

/** A driver with no ambient env, so only the provider config shapes the runtime. */
const driver = (config: Record<string, unknown>, warnings: string[] = []) =>
  new AcpDriver('acp', { driver: 'acp', ...config } as any, {
    env: {},
    logger: { info() {}, debug() {}, warn: (m: string) => warnings.push(m) } as any,
  })

const resolve = (config: Record<string, unknown>, agentId = 'claude-code', warnings: string[] = []) =>
  (driver(config, warnings) as any).resolveRuntimeConfig(agentId)

test.group('AcpDriver runtime resolution', () => {
  test('a built-in agent runs its registered command in the process cwd', ({ assert }) => {
    const resolved = resolve({})
    assert.equal(resolved.command, 'claude-agent-acp')
    assert.deepEqual(resolved.args, [])
    assert.equal(resolved.cwd, process.cwd())
    assert.deepEqual(resolved.mcpServers, [])
  })

  test('an unknown agent without an explicit command is a configuration error', ({ assert }) => {
    assert.throws(() => resolve({}, 'nope'), /Unknown ACP agent "nope"/)
  })

  test('an explicit command takes no arguments from the built-in agent', ({ assert }) => {
    const resolved = resolve({ command: 'my-agent' })
    assert.equal(resolved.command, 'my-agent')
    assert.deepEqual(resolved.args, [])
  })

  test('configured args win over the built-in arguments', ({ assert }) => {
    assert.deepEqual(resolve({ command: 'my-agent', args: ['--acp'] }).args, ['--acp'])
    assert.deepEqual(resolve({ args: ['--z'] }).args, ['--z'])
    assert.equal(resolve({ args: ['--z'] }).command, 'claude-agent-acp')
  })

  test('a relative configured cwd is rejected', ({ assert }) => {
    assert.throws(() => resolve({ cwd: 'relative/dir' }), /absolute path/)
  })

  test('a configured absolute cwd is used', ({ assert }) => {
    const cwd = path.resolve('.')
    assert.equal(resolve({ cwd }).cwd, cwd)
  })

  test('configured env is passed to the agent', ({ assert }) => {
    assert.equal(resolve({ env: { FOO: 'bar' } }).env.FOO, 'bar')
  })

  test('an invalid MCP server is dropped with a warning', ({ assert }) => {
    const warnings: string[] = []
    const resolved = resolve({ mcpServers: [{ name: '' }] }, 'claude-code', warnings)
    assert.deepEqual(resolved.mcpServers, [])
    assert.isTrue(warnings.some((w) => w.includes('Ignoring invalid MCP server')))
  })

  test('a valid MCP server is kept', ({ assert }) => {
    const resolved = resolve({ mcpServers: [{ name: 'fs', command: 'node', args: ['x'] }] })
    assert.lengthOf(resolved.mcpServers, 1)
    assert.equal(resolved.mcpServers[0].name, 'fs')
  })

  test('enabling project MCP without a path warns and adds nothing', ({ assert }) => {
    const warnings: string[] = []
    const resolved = resolve({ enableProjectMcp: true }, 'claude-code', warnings)
    assert.deepEqual(resolved.mcpServers, [])
    assert.isTrue(warnings.some((w) => w.includes('projectMcp.path')))
  })

  test('the configured authMethodId wins and is absent when nothing sets it', ({ assert }) => {
    assert.equal(resolve({ authMethodId: 'cfg' }).authMethodId, 'cfg')
    assert.isUndefined(resolve({}).authMethodId)
  })
})
