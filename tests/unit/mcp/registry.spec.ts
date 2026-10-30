import { test } from '@japa/runner'
import { tool } from 'ai'
import { z } from 'zod'
import { AiManager } from '../../../src/ai_manager.js'
import { AgentRunner } from '../../../src/agents/agent_runner.js'
import type { AgentPromptConfig } from '../../../src/agents/loader.js'
import type { ToolPermission } from '../../../src/guard/types.js'
import { defineConfig } from '../../../src/define_config.js'
import { fakeApiError, fakeLanguageModels, fakeModel, fakeProvider } from '../../../src/testing/index.js'
import type { ResolvedModel } from '../../../src/models/index.js'
import { ConfirmationService, ToolRegistry } from '../../../src/guard/index.js'
import { McpTools } from '../../../src/mcp/mcp_tools.js'
import { FakeMcpClient } from './fake_client.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

/** A registry (default `deny`) and an MCP server `fs` with tools `read` and `write`. */
const setup = (calls: Array<{ name: string; args: unknown }> = []) => {
  const client = new FakeMcpClient({
    tools: {
      read: { description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      write: { description: 'Write a file' },
    },
    calls,
  })
  const mcp = new McpTools({ servers: { fs: { command: 'node', args: ['server.js'] } } }, {
    logger: quiet,
    connect: async () => client,
  })
  const registry = new ToolRegistry({ logger: quiet })
  return { client, mcp, registry }
}

test.group('mcp: registry', () => {
  test('registry: MCP tools are denied by default', async ({ assert }) => {
    const { mcp, registry } = setup()

    await mcp.registerTools(registry)

    assert.deepEqual(Object.keys(registry.getToolsForAgent('any')), [])
    assert.deepEqual(Object.keys(registry.getToolsByList(['mcp__fs__read'])), [])
  })

  test('registry: explicit allow exposes the tool and execute calls the server', async ({ assert }) => {
    const calls: Array<{ name: string; args: unknown }> = []
    const { mcp, registry } = setup(calls)
    const guardChecks: string[] = []
    const guard = {
      check: (name: string) => {
        guardChecks.push(name)
        return null
      },
    }
    await mcp.registerTools(registry)
    registry.setAgentPermissions('a', { mcp__fs__read: 'allow' })

    const tools = registry.getToolsForAgent('a', { guard })
    assert.deepEqual(Object.keys(tools), ['mcp__fs__read'])

    const result = await tools.mcp__fs__read.execute!({ path: '/tmp/a' }, {})
    assert.deepEqual(calls, [{ name: 'read', args: { path: '/tmp/a' } }])
    assert.deepEqual(result, { content: [{ type: 'text', text: 'read ok' }] })
    assert.deepEqual(guardChecks, ['mcp__fs__read'])
  })

  test('registry: ask MCP tool waits for confirmation and does not run when rejected', async ({ assert }) => {
    const calls: Array<{ name: string; args: unknown }> = []
    const { mcp, registry } = setup(calls)
    const confirmation = new ConfirmationService({ logger: quiet })
    await mcp.registerTools(registry)
    registry.setAgentPermissions('a', { mcp__fs__write: 'ask' })
    confirmation.onActionCreated((action) => {
      confirmation.reject(action.id, 'not today')
    })

    const tools = registry.getToolsForAgent('a', { confirmation, timeoutMs: 1000 })
    const result = await tools.mcp__fs__write.execute!({ path: '/etc' }, {})

    assert.deepEqual(calls, [])
    assert.match(JSON.stringify(result), /not executed: rejected/)
    confirmation.dispose()
  })

  test('registry: ask MCP tool is a user-approval in resumable mode', async ({ assert }) => {
    const { mcp, registry } = setup()
    await mcp.registerTools(registry)
    registry.setAgentPermissions('a', { mcp__fs__read: 'allow', mcp__fs__write: 'ask' })

    const { tools, toolApproval } = registry.getToolsWithApprovals('a')

    assert.deepEqual(toolApproval, { mcp__fs__read: 'not-applicable', mcp__fs__write: 'user-approval' })
    assert.deepEqual(Object.keys(tools).sort(), ['mcp__fs__read', 'mcp__fs__write'])
  })

  test('manager: MCP tool passed directly without permission is not offered', async ({ assert }) => {
    const { mcp, registry } = setup()
    await mcp.registerTools(registry)
    const mcpTool = registry.getToolsByList(['mcp__fs__read'], { permissions: { mcp__fs__read: 'allow' } }).mcp__fs__read
    const model = fakeModel([{ text: 'ok' }])
    const manager = new AiManager(
      defineConfig({ default: 'p', providers: { p: fakeProvider(model) }, catalog: { autoPricing: false } } as never),
      quiet
    )

    await manager.generateText({ prompt: 'hi', tools: { mcp__fs__read: mcpTool } as never })

    model.assertCalledTimes(1)
    model.assertToolNotOffered('mcp__fs__read')
    assert.isDefined(mcpTool)
  })

  test('manager: unmarked tools still default to allow', async () => {
    const model = fakeModel([{ text: 'ok' }])
    const manager = new AiManager(
      defineConfig({ default: 'p', providers: { p: fakeProvider(model) }, catalog: { autoPricing: false } } as never),
      quiet
    )
    const local = tool({ description: 'local', inputSchema: z.object({}), execute: async () => 'done' })

    await manager.generateText({ prompt: 'hi', tools: { local } })

    model.assertToolOffered('local')
  })

  test('a 64-character MCP tool name is offered to the model unchanged', async ({ assert }) => {
    const server = 'a'.repeat(32)
    const longTool = 'x'.repeat(25)
    const name = `mcp__${server}__${longTool}`
    assert.equal(name.length, 64)
    const client = new FakeMcpClient({ tools: { [longTool]: { description: 'long' } } })
    const mcp = new McpTools({ servers: { [server]: { command: 'node' } } }, { logger: quiet, connect: async () => client })
    const registry = new ToolRegistry({ logger: quiet })
    await mcp.registerTools(registry)
    registry.setAgentPermissions('a', { [name]: 'allow' })
    const model = fakeModel([{ text: 'ok' }])
    const manager = managerOf(model)

    await manager.generateText({ prompt: 'hi', tools: registry.getToolsForAgent('a') as never, toolPermissions: { [name]: 'allow' } })

    model.assertToolOffered(name)
  })

  test('agent runner: MCP tool missing from the manifest is dropped', async ({ assert }) => {
    const { mcp, registry } = setup()
    await mcp.registerTools(registry)
    const mcpTool = registry.getToolsByList(['mcp__fs__read'], { permissions: { mcp__fs__read: 'allow' } }).mcp__fs__read
    const model = fakeModel([{ text: 'ok' }])
    const runner = new AgentRunner(managerOf(model), agentConfig({ local: 'allow' }))

    await runner.run({ prompt: 'hi', tools: { mcp__fs__read: mcpTool, local: localTool() } as never })

    model.assertToolOffered('local')
    model.assertToolNotOffered('mcp__fs__read')
    assert.isDefined(mcpTool)
  })

  test('agent runner: MCP tool listed in the manifest is offered', async () => {
    const { mcp, registry } = setup()
    await mcp.registerTools(registry)
    const mcpTool = registry.getToolsByList(['mcp__fs__read'], { permissions: { mcp__fs__read: 'allow' } }).mcp__fs__read
    const model = fakeModel([{ text: 'ok' }])
    const runner = new AgentRunner(managerOf(model), agentConfig({ mcp__fs__read: 'allow' }))

    await runner.run({ prompt: 'hi', tools: { mcp__fs__read: mcpTool } as never })

    model.assertToolOffered('mcp__fs__read')
  })
  test('no fallback after an MCP tool ran', async ({ assert }) => {
    const { mcp, registry } = setup()
    await mcp.registerTools(registry)
    registry.setAgentPermissions('a', { mcp__fs__read: 'allow' })
    const first = fakeModel([{ toolCalls: [{ name: 'mcp__fs__read', input: { path: '/tmp/a' } }] }, { error: fakeApiError(429) }], {
      provider: 'mock',
      modelId: 'first',
    })
    const second = fakeModel([{ text: 'from second' }], { provider: 'mock', modelId: 'second' })
    const manager = new AiManager(
      defineConfig({
        default: 'main',
        providers: { main: fakeProvider(fakeModel([{ text: 'unused' }])) },
        catalog: { autoPricing: false },
        languageModels: fakeLanguageModels({ 'mock/first': first, 'mock/second': second }),
      } as never),
      quiet
    )
    const chain: ResolvedModel[] = [
      { providerID: 'mock', modelID: 'first', credentialKey: 'k1' } as ResolvedModel,
      { providerID: 'mock', modelID: 'second', credentialKey: 'k2' } as ResolvedModel,
    ]

    await assert.rejects(() =>
      manager.generateText({
        prompt: 'read it',
        maxRetries: 0,
        maxSteps: 3,
        tools: { mcp__fs__read: registry.getToolsByList(['mcp__fs__read'], { permissions: { mcp__fs__read: 'allow' } }).mcp__fs__read } as never,
        toolPermissions: { mcp__fs__read: 'allow' },
        models: chain,
      })
    )

    assert.equal(first.calls.length, 2)
    assert.equal(second.calls.length, 0)
  })
})


const managerOf = (model: ReturnType<typeof fakeModel>) =>
  new AiManager(
    defineConfig({ default: 'p', providers: { p: fakeProvider(model) }, catalog: { autoPricing: false } } as never),
    quiet
  )

const agentConfig = (permissions: Record<string, ToolPermission>): AgentPromptConfig =>
  ({
    id: 'ag',
    description: '',
    mode: 'primary',
    stopSteps: 3,
    skills: [],
    skillLoading: 'eager',
    systemPrompt: 'AGENT',
    eagerSystemPrompt: 'AGENT',
    body: '',
    skillPrompts: {},
    skillEntries: [],
    permissions,
    phases: [],
  }) as unknown as AgentPromptConfig

const localTool = () => tool({ description: 'local', inputSchema: z.object({}), execute: async () => 'done' })
