import { test } from '@japa/runner'
import { tool } from 'ai'
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'
import { z } from 'zod'
import { AiManager } from '../../../src/ai_manager.js'
import { AgentRunner } from '../../../src/agents/agent_runner.js'
import type { AgentPromptConfig } from '../../../src/agents/loader.js'
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
