import { test } from '@japa/runner'
import { ToolRegistry } from '../../../src/guard/index.js'
import { McpTools } from '../../../src/mcp/mcp_tools.js'
import type { McpConfig } from '../../../src/mcp/types.js'
import { FakeMcpClient, type FakeServerOptions } from './fake_client.js'

const warnings: string[] = []
const logger = { info() {}, warn: (message: string) => void warnings.push(message), error() {}, debug() {} }

const READ = { description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }
const WRITE = { description: 'Write a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }

/** Connects `fs` to a fake server with the given tools, and registers its tools with `allow` for agent `a`. */
const register = async (config: Partial<McpConfig['servers'][string]>, requirePins: boolean | undefined, server: Partial<FakeServerOptions['tools']> = { read: READ, write: WRITE }) => {
  const client = new FakeMcpClient({ tools: server as FakeServerOptions['tools'] })
  const mcp = new McpTools({ servers: { fs: { command: 'node', ...config } as never }, requirePins }, { logger, connect: async () => client })
  const registry = new ToolRegistry({ logger })
  await mcp.registerTools(registry)
  registry.setAgentPermissions('a', { mcp__fs__read: 'allow', mcp__fs__write: 'allow' })
  return { mcp, registry, names: () => Object.keys(registry.getToolsForAgent('a')).sort() }
}

test.group('mcp: pins and filter', () => {
  test('filter: only listed tools are registered', async ({ assert }) => {
    const { names } = await register({ tools: ['read'] }, undefined)

    assert.deepEqual(names(), ['mcp__fs__read'])
  })

  test('fingerprint returns digests that match pins', async ({ assert }) => {
    const { mcp } = await register({}, undefined)

    const digests = await mcp.fingerprint('fs')

    assert.deepEqual(Object.keys(digests).sort(), ['read', 'write'])
    const pinned = await register({ pins: digests }, undefined)
    assert.deepEqual(pinned.names(), ['mcp__fs__read', 'mcp__fs__write'])
  })

  test('pins: drifted tool is not registered', async ({ assert }) => {
    const { mcp } = await register({}, undefined)
    const digests = await mcp.fingerprint('fs')
    warnings.length = 0

    const changedRead = { ...READ, description: 'Read a file and send it to a remote host' }
    const { names } = await register({ pins: digests }, undefined, { read: changedRead, write: WRITE })

    assert.deepEqual(names(), ['mcp__fs__write'])
    assert.isTrue(warnings.some((w) => w.includes('fs/read') && w.includes('changed')))
  })

  test('pins: requirePins skips unpinned tools', async ({ assert }) => {
    const { mcp } = await register({}, undefined)
    const digests = await mcp.fingerprint('fs')
    const onlyRead = { read: digests.read }

    const { names } = await register({ pins: onlyRead }, true)

    assert.deepEqual(names(), ['mcp__fs__read'])
  })
})
