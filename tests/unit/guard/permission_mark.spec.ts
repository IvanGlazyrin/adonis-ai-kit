import { test } from '@japa/runner'
import { AgentRunner } from '../../../src/agents/agent_runner.js'
import type { AgentPromptConfig } from '../../../src/agents/loader.js'
import { TOOL_PERMISSION, ToolRegistry, permissionMarkOf } from '../../../src/guard/index.js'
import { MCP_TOOL } from '../../../src/mcp/types.js'
import { fakeModel } from '../../../src/testing/index.js'
import { askOnce, dangerTools, managerFor } from '../approvals/helpers.js'

/** A registry holding the recording `danger` tool. */
function registryWithDanger() {
  const fixture = dangerTools()
  const registry = new ToolRegistry().registerTool('danger', fixture.tools.danger as never)
  return { fixture, registry }
}

const agentConfig = (permissions: Record<string, 'allow' | 'ask' | 'deny'>): AgentPromptConfig =>
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

test.group('permission mark', () => {
  test('permissionMarkOf reads only a valid own mark', ({ assert }) => {
    assert.isUndefined(permissionMarkOf({}))
    assert.isUndefined(permissionMarkOf(undefined))
    assert.isUndefined(permissionMarkOf({ [TOOL_PERMISSION]: 'sometimes' }))
    assert.equal(permissionMarkOf({ [TOOL_PERMISSION]: 'ask' }), 'ask')
    assert.isUndefined(permissionMarkOf(Object.create({ [TOOL_PERMISSION]: 'allow' })))
  })

  test('getToolsWithApprovals marks the real permission on a copy', ({ assert }) => {
    const { registry, fixture } = registryWithDanger()
    registry.registerTool('safe', fixture.tools.danger as never)

    const { tools } = registry.getToolsWithApprovals('agent', { permissions: { danger: 'ask', safe: 'allow' } })

    assert.equal(permissionMarkOf(tools.danger), 'ask')
    assert.equal(permissionMarkOf(tools.safe), 'allow')
    assert.notStrictEqual(tools.danger, fixture.tools.danger)
    assert.isUndefined(permissionMarkOf(fixture.tools.danger))
  })

  test('getToolsForAgent and getToolsByList put no mark: their wrapper enforces the permission', ({ assert }) => {
    const { registry } = registryWithDanger()

    for (const permission of ['allow', 'ask'] as const) {
      const options = { permissions: { danger: permission } }
      assert.isUndefined(permissionMarkOf(registry.getToolsForAgent('agent', options).danger))
      assert.isUndefined(permissionMarkOf(registry.getToolsByList(['danger'], options).danger))
    }
  })

  test('an MCP tool from the registry carries no permission mark', ({ assert }) => {
    const registry = new ToolRegistry()
    const mcpTool = { description: 'm', execute: async () => 'ok', [MCP_TOOL]: { server: 's', tool: 't' } }
    registry.registerTool('mcp__s__t', mcpTool as never)
    const options = { permissions: { mcp__s__t: 'ask' as const } }

    assert.isUndefined(permissionMarkOf(registry.getToolsWithApprovals('agent', options).tools.mcp__s__t))
    assert.isUndefined(permissionMarkOf(registry.getToolsForAgent('agent', options).mcp__s__t))
    assert.isUndefined(permissionMarkOf(registry.getToolsByList(['mcp__s__t'], options).mcp__s__t))
  })

  test('an ask tool from getToolsForAgent is confirmed once', async ({ assert }) => {
    const { registry, fixture } = registryWithDanger()
    const ai = managerFor(fakeModel(askOnce()))
    const confirmation = ai.getConfirmationService()
    const created: string[] = []
    confirmation.onActionCreated((action) => {
      created.push(action.id)
      confirmation.approve(action.id)
    })
    const tools = registry.getToolsForAgent('agent', { permissions: { danger: 'ask' }, confirmation, timeoutMs: 1000 })

    await ai.generateText({ prompt: 'run it', tools: tools as never })

    assert.lengthOf(created, 1)
    assert.lengthOf(fixture.inputs.danger, 1)
  })

  test('an explicit toolPermissions entry wins over the mark', async ({ assert }) => {
    const { registry, fixture } = registryWithDanger()
    const { tools } = registry.getToolsWithApprovals('agent', { permissions: { danger: 'ask' } })
    const ai = managerFor(fakeModel(askOnce()))

    await ai.generateText({ prompt: 'run it', tools: tools as never, toolPermissions: { danger: 'allow' } })

    assert.lengthOf(fixture.inputs.danger, 1)
  })

  test('a tool without a mark stays allow', async ({ assert }) => {
    const fixture = dangerTools()
    const ai = managerFor(fakeModel(askOnce()))

    await ai.generateText({ prompt: 'run it', tools: fixture.tools })

    assert.lengthOf(fixture.inputs.danger, 1)
  })

  test('AgentRunner honours the mark for a tool outside the manifest', async ({ assert }) => {
    const { registry, fixture } = registryWithDanger()
    const { tools } = registry.getToolsWithApprovals('agent', { permissions: { danger: 'ask' } })
    const ai = managerFor(fakeModel(askOnce()))
    const confirmation = ai.getConfirmationService()
    const created: string[] = []
    confirmation.onActionCreated((action) => {
      created.push(action.id)
      confirmation.reject(action.id, 'no')
    })
    const runner = new AgentRunner(ai, agentConfig({}))

    await runner.run({ prompt: 'run it', tools: tools as never })

    assert.lengthOf(created, 1)
    assert.lengthOf(fixture.inputs.danger, 0)
  })

  test('a manifest entry wins over the mark', async () => {
    const { registry } = registryWithDanger()
    const { tools } = registry.getToolsWithApprovals('agent', { permissions: { danger: 'allow' } })
    const model = fakeModel([{ text: 'ok' }])
    const runner = new AgentRunner(managerFor(model), agentConfig({ danger: 'deny' }))

    await runner.run({ prompt: 'run it', tools: tools as never })

    model.assertToolNotOffered('danger')
  })

  test('an allow mark does not loosen a runner that denies by default', async () => {
    const { registry } = registryWithDanger()
    const { tools } = registry.getToolsWithApprovals('agent', { permissions: { danger: 'allow' } })
    const model = fakeModel([{ text: 'ok' }])
    const runner = new AgentRunner(managerFor(model), agentConfig({}), { defaultToolPermission: 'deny' })

    await runner.run({ prompt: 'run it', tools: tools as never })

    model.assertToolNotOffered('danger')
  })

  test('a registry tool outside a strict manifest is not offered', async () => {
    const { registry } = registryWithDanger()
    const tools = registry.getToolsForAgent('agent', { permissions: { danger: 'allow' } })
    const model = fakeModel([{ text: 'ok' }])
    const runner = new AgentRunner(managerFor(model), agentConfig({}), { defaultToolPermission: 'deny' })

    await runner.run({ prompt: 'run it', tools: tools as never })

    model.assertToolNotOffered('danger')
  })
})
