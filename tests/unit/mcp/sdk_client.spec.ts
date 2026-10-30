import { test } from '@japa/runner'
import { fileURLToPath } from 'node:url'
import { createMCPClient, type MCPTransport } from '@ai-sdk/mcp'
import { fakeModel, fakeProvider } from '../../../src/testing/index.js'
import { AiManager } from '../../../src/ai_manager.js'
import { defineConfig } from '../../../src/define_config.js'
import { ToolRegistry } from '../../../src/guard/index.js'
import { McpTools } from '../../../src/mcp/mcp_tools.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

/** An MCP server in the same process: answers initialize, tools/list and tools/call. */
class InProcessTransport implements MCPTransport {
  onmessage?: (message: any) => void
  onclose?: () => void
  onerror?: (error: Error) => void
  readonly seen: string[] = []

  async start(): Promise<void> {}

  async send(message: any): Promise<void> {
    if (message.id === undefined) return
    this.seen.push(message.method)
    const result = this.answer(message)
    queueMicrotask(() => this.onmessage?.({ jsonrpc: '2.0', id: message.id, result }))
  }

  async close(): Promise<void> {
    this.onclose?.()
  }

  private answer(message: any): unknown {
    switch (message.method) {
      case 'initialize':
        return {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'in-process', version: '1.0.0' },
        }
      case 'tools/list':
        return {
          tools: [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
        }
      case 'tools/call':
        return { content: [{ type: 'text', text: `read ${message.params.arguments.path}` }] }
      default:
        return {}
    }
  }
}

test.group('mcp: @ai-sdk/mcp', () => {
  test('@ai-sdk/mcp: in-process transport lists and calls a tool through the registry', async ({ assert }) => {
    const transport = new InProcessTransport()
    const mcp = new McpTools(
      { servers: { fs: { command: 'unused' } } },
      {
        logger: quiet,
        connect: async () => createMCPClient({ transport, protocolVersionDiscovery: false }),
      }
    )
    const registry = new ToolRegistry({ logger: quiet })
    await mcp.registerTools(registry)
    registry.setAgentPermissions('a', { mcp__fs__read: 'allow' })

    const model = fakeModel([
      { toolCalls: [{ name: 'mcp__fs__read', input: { path: '/tmp/a' } }] },
      { text: 'done' },
    ])
    const manager = new AiManager(
      defineConfig({ default: 'p', providers: { p: fakeProvider(model) }, catalog: { autoPricing: false } } as never),
      quiet
    )

    const result = await manager.generateText({
      prompt: 'read it',
      tools: registry.getToolsForAgent('a') as never,
      toolPermissions: { mcp__fs__read: 'allow' },
      maxSteps: 2,
    })

    assert.equal(result.text, 'done')
    assert.isTrue(transport.seen.includes('tools/call'))
    model.assertToolOffered('mcp__fs__read')
    assert.deepEqual(model.calls[0].toolNames, ['mcp__fs__read'])
    await mcp.close()
  })
})

test.group('mcp: @ai-sdk/mcp stdio', () => {
  test('@ai-sdk/mcp: stdio server from config runs as a child process', async ({ assert }) => {
    const fixture = fileURLToPath(new URL('../../fixtures/mcp_stdio_server.mjs', import.meta.url))
    process.env.AI_TEST_SECRET = 'leaked-from-the-test-process'
    try {
      const mcp = new McpTools({ servers: { probe: { command: process.execPath, args: [fixture] } } }, { logger: quiet })
      const registry = new ToolRegistry({ logger: quiet })
      await mcp.registerTools(registry)
      registry.setAgentPermissions('a', { mcp__probe__probe: 'allow' })

      const tool = registry.getToolsForAgent('a').mcp__probe__probe
      const result = (await tool.execute!({}, {})) as { content: Array<{ text: string }> }
      const seen = JSON.parse(result.content[0].text)

      assert.equal(seen.secret, 'absent')
      assert.equal(seen.path, 'inherited')
      await mcp.close()
    } finally {
      delete process.env.AI_TEST_SECRET
    }
  }).timeout(10_000)
})

test.group('mcp: missing package', () => {
  test('missing @ai-sdk/mcp gives E_AI_MISSING_DEPENDENCY', async ({ assert }) => {
    const mcp = new McpTools(
      { servers: { fs: { command: 'node' } } },
      {
        logger: quiet,
        loadModule: async () => {
          throw new Error("Cannot find package '@ai-sdk/mcp'")
        },
      }
    )

    let code: string | undefined
    try {
      await mcp.registerTools(new ToolRegistry({ logger: quiet }))
    } catch (err) {
      code = (err as { code?: string }).code
    }

    assert.equal(code, 'E_AI_MISSING_DEPENDENCY')
  })
})
