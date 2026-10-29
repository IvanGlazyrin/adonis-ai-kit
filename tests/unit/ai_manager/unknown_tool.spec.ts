import { test } from '@japa/runner'
import { AiManager } from '../../../src/ai_manager.js'
import { defineConfig } from '../../../src/define_config.js'
import { fakeModel, fakeProvider, fakeTools } from '../../../src/testing/index.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

const managerWith = (model: ReturnType<typeof fakeModel>) =>
  new AiManager(
    defineConfig({
      default: 'main',
      providers: { main: fakeProvider(model) },
      catalog: { autoPricing: false },
    } as never),
    quiet
  )

test.group('unknown tool calls (B2)', () => {
  test('a call to an unknown tool returns a tool error listing only the allowed tools; the call succeeds', async ({
    assert,
  }) => {
    const tools = fakeTools({ ping: () => 'pong', secret: () => 'x' })
    const model = fakeModel([{ toolCalls: [{ name: 'nope' }] }, { text: 'recovered' }])
    const m = managerWith(model)

    const result = await m.generateText({
      prompt: 'x',
      maxSteps: 2,
      tools: tools.tools,
      toolPermissions: { secret: 'deny' },
    })

    assert.equal(result.text, 'recovered')
    model.assertCalledTimes(2)
    const second = JSON.stringify(model.calls[1].prompt)
    assert.include(second, 'Available tools: ping')
    assert.notInclude(second, 'secret')
    tools.assertToolNotCalled('ping')
  })

  test('repairToolCall receives the NoSuchToolError and its corrected call is executed', async ({ assert }) => {
    const tools = fakeTools({ ping: () => 'pong' })
    const model = fakeModel([{ toolCalls: [{ name: 'pnig', input: {} }] }, { text: 'done' }])
    const m = managerWith(model)
    const seen: string[] = []

    const result = await m.generateText({
      prompt: 'x',
      maxSteps: 2,
      tools: tools.tools,
      repairToolCall: async ({ toolCall, error }) => {
        seen.push(error.name)
        return { ...toolCall, toolName: 'ping' }
      },
    })

    assert.equal(result.text, 'done')
    assert.deepEqual(seen, ['AI_NoSuchToolError'])
    tools.assertToolCalled('ping', {})
  })
})
