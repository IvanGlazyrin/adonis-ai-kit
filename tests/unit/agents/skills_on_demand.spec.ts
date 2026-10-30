import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { tool } from 'ai'
import { z } from 'zod'
import { AiException } from '../../../src/errors.js'
import { AgentLoader } from '../../../src/agents/loader.js'
import { createLoadSkillTool } from '../../../src/agents/skill_tool.js'
import { AgentRunner } from '../../../src/agents/agent_runner.js'
import { AiManager } from '../../../src/ai_manager.js'
import { defineConfig } from '../../../src/define_config.js'
import { fakeModel, type FakeCall, type FakeModel } from '../../../src/testing/index.js'

/** A configs dir and a skills dir, both empty to start with. */
const dirs = () => {
  const root = mkdtempSync(join(tmpdir(), 'adonis-ai-ondemand-'))
  const configsDir = join(root, 'agents')
  const skillsDir = join(root, 'skills')
  mkdirSync(configsDir)
  mkdirSync(skillsDir)
  return { configsDir, skillsDir }
}

/** One skill with a description and a body that must not show up in the on-demand system prompt. */
const writeGreetSkill = (skillsDir: string) =>
  writeFileSync(join(skillsDir, 'greet.md'), '---\ndescription: Greets people politely\n---\nSECRET-GREET-BODY\n')

test.group('skills on demand: composition', () => {
  test('on-demand: systemPrompt lists names and descriptions only', async ({ assert }) => {
    const d = dirs()
    writeGreetSkill(d.skillsDir)
    writeFileSync(join(d.configsDir, 'host.md'), '---\nskillLoading: on-demand\nskills:\n  - greet\n---\nBase.')

    const config = await new AgentLoader(d).loadAgentPrompt('host')

    assert.include(config.systemPrompt, 'greet')
    assert.include(config.systemPrompt, 'Greets people politely')
    assert.notInclude(config.systemPrompt, 'SECRET-GREET-BODY')
  })

  test('on-demand: eagerSystemPrompt equals the eager systemPrompt', async ({ assert }) => {
    const d = dirs()
    writeGreetSkill(d.skillsDir)
    writeFileSync(join(d.configsDir, 'lazy.md'), '---\nskillLoading: on-demand\nskills:\n  - greet\n---\nBase.')
    writeFileSync(join(d.configsDir, 'eager.md'), '---\nskills:\n  - greet\n---\nBase.')
    const loader = new AgentLoader(d)

    const lazy = await loader.loadAgentPrompt('lazy')
    const eager = await loader.loadAgentPrompt('eager')

    assert.include(eager.systemPrompt, 'SECRET-GREET-BODY')
    assert.equal(lazy.eagerSystemPrompt, eager.systemPrompt)
  })
})

test.group('skills on demand: loadSkill tool', () => {
  test('loadSkill tool: returns <skill_content> with the body', async ({ assert }) => {
    const entry = { name: 'greet', description: 'Greets people', body: 'SECRET-GREET-BODY' }
    const loadSkill = createLoadSkillTool({ skills: [entry] })

    const result = await (loadSkill.execute as any)({ name: 'greet' }, { toolCallId: 't1', messages: [] })

    assert.equal(result, '<skill_content name="greet">\nSECRET-GREET-BODY\n</skill_content>')
  })

  test('loadSkill tool: unknown name is rejected by the input schema', ({ assert }) => {
    const loadSkill = createLoadSkillTool({
      skills: [{ name: 'greet', description: 'Greets people', body: 'Body.' }],
    })

    const parsed = (loadSkill.inputSchema as z.ZodType).safeParse({ name: '../secret' })

    assert.isFalse(parsed.success)
  })
})

const managerFor = (model: FakeModel) =>
  new AiManager(
    defineConfig({
      default: 'main',
      providers: { main: { driver: 'custom', factory: () => model, defaultModel: 'fake-model' } },
      catalog: { autoPricing: false },
    }),
    { info() {}, warn() {}, error() {}, debug() {} }
  )

/** An on-demand agent with one skill, loaded through the real loader. */
const onDemandAgent = async () => {
  const d = dirs()
  writeGreetSkill(d.skillsDir)
  writeFileSync(join(d.configsDir, 'host.md'), '---\nskillLoading: on-demand\nskills:\n  - greet\n---\nYou are the host.')
  return new AgentLoader(d).loadAgentPrompt('host')
}

/** The system message texts of one call. */
const systemTextsOf = (call: FakeCall) =>
  call.prompt.filter((message) => message.role === 'system').map((message) => JSON.stringify(message.content))

test.group('skills on demand: AgentRunner.run', () => {
  test('on-demand: model loads a skill and gets its body as a tool result', async ({ assert }) => {
    const model = fakeModel([
      { toolCalls: [{ name: 'loadSkill', input: { name: 'greet' } }] },
      { text: 'greeted' },
    ])
    const runner = new AgentRunner(managerFor(model), await onDemandAgent())

    const result = await runner.run('Say hi.')

    assert.equal(result.text, 'greeted')
    model.assertToolOffered('loadSkill')
    model.assertCalledTimes(2)
    model.assertPromptContains('SECRET-GREET-BODY')
    for (const call of model.calls) {
      assert.notInclude(systemTextsOf(call).join(''), 'SECRET-GREET-BODY')
    }
  })
})

test.group('skills on demand: AgentRunner.runStream', () => {
  test('on-demand: stream path offers loadSkill and the model gets the body as a tool result', async ({ assert }) => {
    const model = fakeModel([
      { toolCalls: [{ name: 'loadSkill', input: { name: 'greet' } }] },
      { text: 'streamed' },
    ])
    const runner = new AgentRunner(managerFor(model), await onDemandAgent())

    const stream = await runner.runStream('Say hi.')
    const result = await stream.consume()

    assert.equal(result.text, 'streamed')
    model.assertToolOffered('loadSkill')
    model.assertCalledTimes(2)
    model.assertPromptContains('SECRET-GREET-BODY')
    for (const call of model.calls) {
      assert.notInclude(systemTextsOf(call).join(''), 'SECRET-GREET-BODY')
    }
  })
})

test.group('skills on demand: conflicts', () => {
  test('on-demand: caller tool named loadSkill is rejected', async ({ assert }) => {
    const model = fakeModel([{ text: 'never' }])
    const runner = new AgentRunner(managerFor(model), await onDemandAgent())
    const impostor = tool({ description: 'impostor', inputSchema: z.object({}), execute: async () => 'x' })

    const error = await runner.run({ prompt: 'hi', tools: { loadSkill: impostor } }).then(() => null, (err: unknown) => err)

    assert.instanceOf(error, AiException)
    assert.equal((error as AiException).code, 'E_AI_INVALID_ARGUMENT')
    model.assertCalledTimes(0)
  })

  test('on-demand: manifest permission deny or ask for loadSkill is a config error', async ({ assert }) => {
    for (const permission of ['deny', 'ask']) {
      const d = dirs()
      writeGreetSkill(d.skillsDir)
      writeFileSync(
        join(d.configsDir, 'strict.md'),
        `---\nskillLoading: on-demand\nskills:\n  - greet\npermissions:\n  loadSkill: ${permission}\n---\nBody.`
      )
      const config = await new AgentLoader(d).loadAgentPrompt('strict')

      try {
        new AgentRunner(managerFor(fakeModel([])), config)
        assert.fail(`expected a config error for ${permission}`)
      } catch (err) {
        assert.instanceOf(err, AiException)
        assert.equal((err as AiException).code, 'E_AI_CONFIG_ERROR')
      }
    }
  })
})

test.group('skills on demand: guard', () => {
  test('on-demand: toolGuard.check sees loadSkill calls', async ({ assert }) => {
    const checked: Array<{ name: string; args: unknown }> = []
    const guard = {
      check: (name: string, args: unknown) => {
        checked.push({ name, args })
        return null
      },
      record() {},
      release() {},
    }
    const model = fakeModel([
      { toolCalls: [{ name: 'loadSkill', input: { name: 'greet' } }] },
      { text: 'done' },
    ])
    const runner = new AgentRunner(managerFor(model), await onDemandAgent())

    await runner.run({ prompt: 'hi', toolGuard: { guard } })

    assert.deepEqual(checked, [{ name: 'loadSkill', args: { name: 'greet' } }])
  })
})

test.group('skills on demand: prompt cache and structured output', () => {
  test('on-demand + promptCache.instructions: system message is identical on every step', async ({ assert }) => {
    const model = fakeModel([
      { toolCalls: [{ name: 'loadSkill', input: { name: 'greet' } }] },
      { text: 'done' },
    ])
    const runner = new AgentRunner(managerFor(model), await onDemandAgent())

    await runner.run({ prompt: 'hi', promptCache: { instructions: '5m' } })

    model.assertCalledTimes(2)
    const systemOf = (call: FakeCall) => call.prompt.filter((message) => message.role === 'system')
    assert.deepEqual(systemOf(model.calls[0]), systemOf(model.calls[1]))
    model.assertProviderOption('anthropic.cacheControl', { type: 'ephemeral', ttl: '5m' })
  })

  test('on-demand: runStructured uses the eager prompt', async ({ assert }) => {
    const model = fakeModel([{ object: { answer: 'ok' } }])
    const runner = new AgentRunner(managerFor(model), await onDemandAgent())

    const result = await runner.runStructured(z.object({ answer: z.string() }), 'hi')

    assert.equal(result.object.answer, 'ok')
    assert.include(systemTextsOf(model.calls[0]).join(''), 'SECRET-GREET-BODY')
  })
})

test.group('skills on demand: eager mode is unchanged', () => {
  test('eager: unchanged for skills without frontmatter', async ({ assert }) => {
    const d = dirs()
    writeFileSync(join(d.skillsDir, 'grid-trading.md'), '# Grid Trading Skill\n\nPlace grid orders.\n')
    writeFileSync(join(d.configsDir, 'trader.md'), '---\nskills:\n  - grid-trading\n---\nYou trade.\n')

    const config = await new AgentLoader(d).loadAgentPrompt('trader')

    assert.equal(config.systemPrompt, 'You trade.\n\n---\n\n# Grid Trading Skill\n\nPlace grid orders.')
    assert.equal(config.skillLoading, 'eager')
  })
})
