import { test } from '@japa/runner'
import { tool } from 'ai'
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'
import { z } from 'zod'
import { AiManager } from '../../../src/ai_manager.js'
import { AgentRunner } from '../../../src/agents/agent_runner.js'
import type { AgentPromptConfig } from '../../../src/agents/loader.js'
import type { AgentRunnerOptions } from '../../../src/agents/agent_runner.js'
import type { ActionGuard } from '../../../src/guard/types.js'
import type { GenerateTextOptions } from '../../../src/types.js'
import { defineConfig } from '../../../src/define_config.js'

const usage = (inp: number, out: number) => ({
  inputTokens: { total: inp, noCache: inp, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: out, text: out, reasoning: 0 },
})
const finish = () => ({ unified: 'stop' as const, raw: 'stop' })

/** Records the options each generation call receives, and answers with `text`. */
const recordingModel = (text: string) => {
  const calls: Array<Record<string, any>> = []
  const model = new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'm',
    doGenerate: async (options) => {
      calls.push(options)
      return {
        content: [{ type: 'text', text }],
        finishReason: finish(),
        usage: usage(10, 5),
        warnings: [],
      }
    },
    doStream: async (options) => {
      calls.push(options)
      return {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: text },
          { type: 'text-end', id: '1' },
          { type: 'finish', finishReason: finish(), usage: usage(10, 5) },
        ]),
      }
    },
  })
  return { model, calls }
}

const manager = (model: MockLanguageModelV4) =>
  new AiManager(
    defineConfig({
      default: 'main',
      providers: { main: { driver: 'custom', factory: () => model, defaultModel: 'm' } },
      catalog: { autoPricing: false },
    }),
    { info() {}, warn() {}, error() {}, debug() {} }
  )

const agentConfig = (overrides: Partial<AgentPromptConfig> = {}): AgentPromptConfig => ({
  id: 'writer',
  description: 'Writes things',
  mode: 'primary',
  stopSteps: 4,
  skills: [],
  systemPrompt: 'AGENT-PROMPT',
  body: '',
  skillPrompts: {},
  permissions: {},
  phases: [],
  ...overrides,
})

const ping = tool({ description: 'ping', inputSchema: z.object({}), execute: async () => 'pong' })

test.group('AgentRunner', () => {
  test('run() merges the agent system prompt with the caller system prompt', async ({ assert }) => {
    const { model, calls } = recordingModel('done')
    const runner = new AgentRunner(manager(model), agentConfig())

    const result = await runner.run({ prompt: 'hi', system: 'CALLER-PROMPT' })

    assert.equal(result.text, 'done')
    const sent = JSON.stringify(calls[0]?.prompt)
    assert.include(sent, 'AGENT-PROMPT')
    assert.include(sent, 'CALLER-PROMPT')
  })

  test('run() accepts a bare prompt string', async ({ assert }) => {
    const { model } = recordingModel('done')
    const result = await new AgentRunner(manager(model), agentConfig()).run('hi')
    assert.equal(result.text, 'done')
  })

  test('run() uses the runner default temperature and the deprecated maxTokens alias', async ({ assert }) => {
    const { model, calls } = recordingModel('done')
    const runner = new AgentRunner(manager(model), agentConfig(), { temperature: 0.2 })

    await runner.run({ prompt: 'hi', maxTokens: 42 })

    assert.equal(calls[0]?.temperature, 0.2)
    assert.equal(calls[0]?.maxOutputTokens, 42)
  })

  test('run() drops tools the manifest denies and keeps the rest', async ({ assert }) => {
    const { model, calls } = recordingModel('done')
    const runner = new AgentRunner(
      manager(model),
      agentConfig({ permissions: { secret: 'deny' } })
    )

    await runner.run({ prompt: 'hi', tools: { ping, secret: ping } })

    const names = (calls[0]?.tools ?? []).map((t: { name: string }) => t.name)
    assert.deepEqual(names, ['ping'])
  })

  test('runStream() streams the agent response', async ({ assert }) => {
    const { model } = recordingModel('streamed')
    const stream = await new AgentRunner(manager(model), agentConfig()).runStream('hi')

    const result = await stream.consume()

    assert.equal(result.text, 'streamed')
  })

  test('stream() is an alias of runStream()', async ({ assert }) => {
    const { model } = recordingModel('streamed')
    const stream = await new AgentRunner(manager(model), agentConfig()).stream('hi')

    assert.equal((await stream.consume()).text, 'streamed')
  })

  test('runStructured() parses output against the schema passed in', async ({ assert }) => {
    const { model } = recordingModel('{"n":7}')
    const runner = new AgentRunner(manager(model), agentConfig())

    const result = await runner.runStructured(z.object({ n: z.number() }), 'hi')

    assert.deepEqual(result.object, { n: 7 })
  })

  test('runStructured() falls back to the agent outputSchema', async ({ assert }) => {
    const { model } = recordingModel('{"n":9}')
    const runner = new AgentRunner(
      manager(model),
      agentConfig({ outputSchema: z.object({ n: z.number() }) })
    )

    const result = await runner.runStructured(undefined, { prompt: 'hi' })

    assert.deepEqual(result.object, { n: 9 })
  })

  test('runStructured() rejects when neither a schema nor an outputSchema exists', async ({ assert }) => {
    const { model } = recordingModel('{}')
    const runner = new AgentRunner(manager(model), agentConfig())

    await assert.rejects(() => runner.runStructured(undefined, 'hi'), /No schema provided/)
  })

})

/** Always asks for the `ping` tool, so every step is a tool step. */
const toolCallingModel = () =>
  new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'm',
    doGenerate: async () => ({
      content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'ping', input: '{}' }],
      finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
      usage: usage(10, 5),
      warnings: [],
    }),
  })

const outputLimit = async (
  config: Partial<AgentPromptConfig>,
  options: AgentRunnerOptions,
  call: GenerateTextOptions = { prompt: 'hi' }
) => {
  const { model, calls } = recordingModel('done')
  await new AgentRunner(manager(model), agentConfig(config), options).run(call)
  return calls[0]?.maxOutputTokens
}

test.group('AgentRunner defaults and fallbacks', () => {
  test('getters expose the agent identity and manifest', ({ assert }) => {
    const config = agentConfig({ permissions: { ping: 'deny' } })
    const runner = new AgentRunner(manager(recordingModel('x').model), config)

    assert.equal(runner.getId(), 'writer')
    assert.equal(runner.getDescription(), 'Writes things')
    assert.equal(runner.getSystemPrompt(), 'AGENT-PROMPT')
    assert.strictEqual(runner.getConfig(), config)
    assert.deepEqual(runner.getPermissions(), { ping: 'deny' })
  })

  test('run() sends the runner default system prompt when the caller gives none', async ({ assert }) => {
    const { model, calls } = recordingModel('done')

    await new AgentRunner(manager(model), agentConfig(), { system: 'RUNNER-DEFAULT' }).run('hi')

    const sent = JSON.stringify(calls[0]?.prompt)
    assert.include(sent, 'AGENT-PROMPT')
    assert.include(sent, 'RUNNER-DEFAULT')
  })

  test('run() uses the runner default tools when the call passes none', async ({ assert }) => {
    const { model, calls } = recordingModel('done')

    await new AgentRunner(manager(model), agentConfig(), { tools: { ping } }).run('hi')

    const names = (calls[0]?.tools ?? []).map((t: { name: string }) => t.name)
    assert.deepEqual(names, ['ping'])
  })

  test('defaultToolPermission "deny" removes tools the manifest does not mention', async ({ assert }) => {
    const { model, calls } = recordingModel('done')
    const runner = new AgentRunner(manager(model), agentConfig({ permissions: { ping: 'allow' } }), {
      defaultToolPermission: 'deny',
    })

    await runner.run({ prompt: 'hi', tools: { ping, other: ping } })

    const names = (calls[0]?.tools ?? []).map((t: { name: string }) => t.name)
    assert.deepEqual(names, ['ping'])
  })

  test('output token limit resolves call, then runner, then deprecated runner, then manifest', async ({ assert }) => {
    assert.equal(await outputLimit({}, { maxOutputTokens: 77 }, { prompt: 'hi', maxOutputTokens: 11 }), 11)
    assert.equal(await outputLimit({}, { maxOutputTokens: 77 }), 77)
    assert.equal(await outputLimit({}, { maxTokens: 33 }), 33)
    assert.equal(await outputLimit({ maxTokens: 55 }, {}), 55)
    assert.isUndefined(await outputLimit({}, {}))
  })

  test('maxSteps comes from the manifest stopSteps unless the call overrides it', async ({ assert }) => {
    const runner = (stopSteps: number) =>
      new AgentRunner(manager(toolCallingModel()), agentConfig({ stopSteps }), {
        tools: { ping },
      })

    const fromManifest = await runner(3).run('hi')
    assert.equal(fromManifest.steps?.length, 3)

    const fromCall = await runner(3).run({ prompt: 'hi', maxSteps: 2 })
    assert.equal(fromCall.steps?.length, 2)
  })

  test('run() applies the runner default tool guard when the call sets none', async ({ assert }) => {
    const checked: string[] = []
    const guard: ActionGuard = {
      check: (toolName) => {
        checked.push(toolName)
        return null
      },
      record() {},
      release() {},
    }
    const runner = new AgentRunner(manager(toolCallingModel()), agentConfig({ stopSteps: 1 }), {
      tools: { ping },
      toolGuard: { guard },
    })

    await runner.run('hi')

    assert.deepEqual(checked, ['ping'])
  })

  test('runStructured() names the schema from the manifest, else the agent id', async ({ assert }) => {
    const named = recordingModel('{"n":1}')
    await new AgentRunner(
      manager(named.model),
      agentConfig({ outputSchemaName: 'Manifest', outputSchema: z.object({ n: z.number() }) })
    ).runStructured(undefined, 'hi')
    assert.equal(named.calls[0]?.responseFormat?.name, 'Manifest')

    const unnamed = recordingModel('{"n":1}')
    await new AgentRunner(manager(unnamed.model), agentConfig()).runStructured(z.object({ n: z.number() }), 'hi')
    assert.equal(unnamed.calls[0]?.responseFormat?.name, 'writer')
  })

  test('run() resolves model and temperature: call, then runner, then manifest', async ({ assert }) => {
    const { model, calls } = recordingModel('done')
    const runner = new AgentRunner(
      manager(model),
      agentConfig({ model: 'manifest-model', temperature: 0.9 }),
      { model: 'runner-model', temperature: 0.5 }
    )

    assert.equal((await runner.run('a')).model, 'runner-model')
    assert.equal(calls[0]?.temperature, 0.5)

    const fromCall = await runner.run({ prompt: 'b', model: 'call-model', temperature: 0.1 })
    assert.equal(fromCall.model, 'call-model')
    assert.equal(calls[1]?.temperature, 0.1)

    const manifestOnly = new AgentRunner(manager(model), agentConfig({ model: 'manifest-model', temperature: 0.9 }))
    assert.equal((await manifestOnly.run('c')).model, 'manifest-model')
    assert.equal(calls[2]?.temperature, 0.9)
  })

  test('run() prefers call tools over runner defaults, and an explicit empty set disables them', async ({ assert }) => {
    const { model, calls } = recordingModel('done')
    const runner = new AgentRunner(manager(model), agentConfig(), { tools: { ping } })
    const names = (i: number) => (calls[i]?.tools ?? []).map((t: { name: string }) => t.name)

    await runner.run({ prompt: 'a', tools: { other: ping } })
    assert.deepEqual(names(0), ['other'])

    await runner.run({ prompt: 'b', tools: {} })
    assert.deepEqual(names(1), [])
  })
})
