import { test } from '@japa/runner'
import { AiManager } from '../../../src/ai_manager.js'
import { defineConfig } from '../../../src/define_config.js'
import { ToolRegistry } from '../../../src/guard/index.js'
import { McpTools } from '../../../src/mcp/mcp_tools.js'
import { fakeModel, fakeProvider } from '../../../src/testing/index.js'
import { FakeMcpClient } from './fake_client.js'

const warnings: string[] = []
const logger = { info() {}, warn: (message: string) => void warnings.push(message), error() {}, debug() {} }
const READ = { read: { description: 'Read a file' } }

test.group('mcp: lifecycle', () => {
  test('one server failing to connect leaves other servers\' tools registered', async ({ assert }) => {
    warnings.length = 0
    const mcp = new McpTools(
      { servers: { broken: { command: 'does-not-exist' }, fs: { command: 'node' } } },
      {
        logger,
        connect: async (server) => {
          if (server === 'broken') throw new Error('spawn ENOENT')
          return new FakeMcpClient({ tools: READ })
        },
      }
    )
    const registry = new ToolRegistry({ logger })

    await mcp.registerTools(registry)
    registry.setAgentPermissions('a', { mcp__fs__read: 'allow' })

    assert.deepEqual(Object.keys(registry.getToolsForAgent('a')), ['mcp__fs__read'])
    assert.isTrue(warnings.some((w) => w.includes('broken') && w.includes('spawn ENOENT')))
  })

  test('tools on every page of listTools are registered', async ({ assert }) => {
    const mcp = new McpTools(
      { servers: { fs: { command: 'node' } } },
      { logger, connect: async () => new FakeMcpClient({ tools: { read: {}, write: {}, list: {} }, pageSize: 1 }) }
    )
    const registry = new ToolRegistry({ logger })

    await mcp.registerTools(registry)
    registry.setAgentPermissions('a', { mcp__fs__read: 'allow', mcp__fs__write: 'allow', mcp__fs__list: 'allow' })

    assert.deepEqual(Object.keys(registry.getToolsForAgent('a')).sort(), ['mcp__fs__list', 'mcp__fs__read', 'mcp__fs__write'])
  })

  test('manager.shutdown closes every MCP client', async ({ assert }) => {
    const clients = {
      fs: new FakeMcpClient({ tools: READ }),
      git: new FakeMcpClient({ tools: { status: { description: 'git status' } } }),
    }
    const mcp = new McpTools(
      { servers: { fs: { command: 'node' }, git: { command: 'node' } } },
      { logger, connect: async (server) => clients[server as keyof typeof clients] }
    )
    const registry = new ToolRegistry({ logger })
    const manager = new AiManager(
      defineConfig({ default: 'p', providers: { p: fakeProvider(fakeModel([])) }, catalog: { autoPricing: false } } as never),
      logger,
      undefined,
      registry,
      undefined,
      undefined,
      undefined,
      mcp
    )
    await manager.mcp.registerTools(manager.getToolRegistry())
    assert.isFalse(clients.fs.closed)

    await manager.shutdown()

    assert.isTrue(clients.fs.closed)
    assert.isTrue(clients.git.closed)
  })
})
