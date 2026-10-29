import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import MakeAiAgentCommand from '../../../commands/make_agent.js'

/** A command instance with the ace fields it reads, backed by a temp app root. */
const commandFor = (name: string, overrides: Record<string, unknown> = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'adonis-ai-make-'))
  const errors: string[] = []
  const cmd = Object.assign(Object.create(MakeAiAgentCommand.prototype), {
    name,
    provider: '',
    model: '',
    maxTokens: 2048,
    app: { makePath: (p: string) => join(root, p) },
    ui: {
      logger: {
        error: (m: string) => void errors.push(m),
        success: () => {},
        info: () => {},
      },
    },
    ...overrides,
  })
  return { cmd, root, errors }
}

test.group('make:ai-agent command', () => {
  test('writes an agent file named after the snake-cased name, with the class and agent name', async ({ assert }) => {
    const { cmd, root } = commandFor('MarketAnalysis')

    await cmd.run()

    const file = join(root, 'app/ai/agents/market_analysis_agent.ts')
    assert.isTrue(existsSync(file))
    const source = readFileSync(file, 'utf-8')
    assert.include(source, 'export class MarketAnalysisAgent')
    assert.include(source, "public readonly agentName = 'marketanalysis-agent'")
  })

  test('a trailing Agent in the name is not doubled', async ({ assert }) => {
    const { cmd, root } = commandFor('SupportChatAgent')

    await cmd.run()

    const source = readFileSync(join(root, 'app/ai/agents/support_chat_agent.ts'), 'utf-8')
    assert.include(source, 'export class SupportChatAgent')
    assert.notInclude(source, 'SupportChatAgentAgent')
  })

  test('the provider, model and token budget are written into the class', async ({ assert }) => {
    const { cmd, root } = commandFor('Coder', { provider: 'anthropic', model: 'claude-sonnet-5-5', maxTokens: 512 })

    await cmd.run()

    const source = readFileSync(join(root, 'app/ai/agents/coder_agent.ts'), 'utf-8')
    assert.include(source, "public readonly defaultProvider = 'anthropic'")
    assert.include(source, "public readonly defaultModel = 'claude-sonnet-5-5'")
    assert.include(source, 'public readonly maxOutputTokens = 512')
  })

  test('without a provider or model the defaults are left to the app', async ({ assert }) => {
    const { cmd, root } = commandFor('Plain')

    await cmd.run()

    const source = readFileSync(join(root, 'app/ai/agents/plain_agent.ts'), 'utf-8')
    assert.include(source, 'public readonly defaultProvider = undefined')
    assert.include(source, 'public readonly defaultModel = undefined')
  })

  test('an existing agent file is never overwritten', async ({ assert }) => {
    const { cmd, root, errors } = commandFor('Keep')
    mkdirSync(join(root, 'app/ai/agents'), { recursive: true })
    const file = join(root, 'app/ai/agents/keep_agent.ts')
    writeFileSync(file, '// hand written')

    await cmd.run()

    assert.equal(readFileSync(file, 'utf-8'), '// hand written')
    assert.isTrue(errors.some((e) => e.includes('Agent file already exists')))
  })
})
