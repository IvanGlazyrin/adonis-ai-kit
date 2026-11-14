import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import { AceFactory, IgnitorFactory } from '@adonisjs/core/factories'
import MakeAiAgentCommand from '../../../commands/make_agent.js'

/**
 * Runs `make:ai-agent` through a real Ace kernel against a throwaway app root, so the stub, the
 * codemods and the target path are the ones a user gets.
 */
async function runMakeAgent(root: string, argv: string[]) {
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .create(pathToFileURL(`${root}/`), { importer: (specifier) => import(specifier) })
  const ace = await new AceFactory().make(ignitor)
  await ace.app.init()
  ace.ui.switchMode('raw')
  const command = await ace.create(MakeAiAgentCommand, argv)
  await command.exec()
  const errors = ace.ui.logger
    .getLogs()
    .filter((log) => log.stream === 'stderr')
    .map((log) => log.message)
  return { command, errors }
}

const agentFile = (root: string, name: string) => join(root, 'app/ai/agents', name)

test.group('make:ai-agent command', (group) => {
  let root: string

  group.each.setup(() => {
    root = mkdtempSync(join(tmpdir(), 'adonis-ai-make-'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }))
    return () => rmSync(root, { recursive: true, force: true })
  })

  test('writes an agent file named after the snake-cased name, with the class and agent name', async ({ assert }) => {
    const { command } = await runMakeAgent(root, ['MarketAnalysis'])

    const file = agentFile(root, 'market_analysis_agent.ts')
    assert.isTrue(existsSync(file))
    assert.notEqual(command.exitCode, 1)
    const source = readFileSync(file, 'utf-8')
    assert.include(source, 'export class MarketAnalysisAgent')
    assert.include(source, "public readonly agentName = 'marketanalysis-agent'")
    assert.include(source, "].join('\\n')")
    assert.include(source, 'export default new MarketAnalysisAgent()')
  })

  test('a trailing Agent in the name is not doubled', async ({ assert }) => {
    await runMakeAgent(root, ['SupportChatAgent'])

    const source = readFileSync(agentFile(root, 'support_chat_agent.ts'), 'utf-8')
    assert.include(source, 'export class SupportChatAgent')
    assert.notInclude(source, 'SupportChatAgentAgent')
  })

  test('the provider, model and token budget are written into the class', async ({ assert }) => {
    await runMakeAgent(root, ['Coder', '--provider=anthropic', '--model=claude-sonnet-5-5', '--max-tokens=512'])

    const source = readFileSync(agentFile(root, 'coder_agent.ts'), 'utf-8')
    assert.include(source, "public readonly defaultProvider = 'anthropic'")
    assert.include(source, "public readonly defaultModel = 'claude-sonnet-5-5'")
    assert.include(source, 'public readonly maxOutputTokens = 512')
  })

  test('a provider or model with a slash, colon or at sign is accepted', async ({ assert }) => {
    await runMakeAgent(root, ['Router', '--provider=my-gateway', '--model=openai/gpt-6-sol:free@v1.2'])

    const source = readFileSync(agentFile(root, 'router_agent.ts'), 'utf-8')
    assert.include(source, "public readonly defaultModel = 'openai/gpt-6-sol:free@v1.2'")
  })

  test('without a provider or model the defaults are left to the app', async ({ assert }) => {
    await runMakeAgent(root, ['Plain'])

    const source = readFileSync(agentFile(root, 'plain_agent.ts'), 'utf-8')
    assert.include(source, 'public readonly defaultProvider = undefined')
    assert.include(source, 'public readonly defaultModel = undefined')
    assert.include(source, 'public readonly maxOutputTokens = 2048')
  })

  test('an existing agent file is never overwritten', async ({ assert }) => {
    mkdirSync(join(root, 'app/ai/agents'), { recursive: true })
    const file = agentFile(root, 'keep_agent.ts')
    writeFileSync(file, '// hand written')

    const { errors } = await runMakeAgent(root, ['Keep'])

    assert.equal(readFileSync(file, 'utf-8'), '// hand written')
    assert.isTrue(errors.some((e) => e.includes('Agent file already exists')))
  })

  test('rejects a name with a path separator', async ({ assert }) => {
    for (const name of ['../evil', 'a/b', 'a\\b', '..\\evil']) {
      const { command, errors } = await runMakeAgent(root, [name])

      assert.equal(command.exitCode, 1, name)
      assert.isTrue(errors.some((e) => e.includes('name')), name)
    }
    assert.isFalse(existsSync(join(root, 'app')))
    assert.isFalse(existsSync(join(root, '..', 'evil_agent.ts')))
  })

  test('rejects a name that is not an identifier', async ({ assert }) => {
    for (const name of ['1Agent', 'My-Agent', 'My Agent', "A'; process.exit(1); '", 'Agent']) {
      const { command } = await runMakeAgent(root, [name])
      assert.equal(command.exitCode, 1, name)
    }
    assert.isFalse(existsSync(join(root, 'app')))
  })

  test('rejects a provider with a quote', async ({ assert }) => {
    const { command, errors } = await runMakeAgent(root, ['Coder', "--provider=x'; process.exit(1); '"])

    assert.equal(command.exitCode, 1)
    assert.isTrue(errors.some((e) => e.includes('--provider')))
    assert.isFalse(existsSync(join(root, 'app')))
  })

  test('rejects a model with a quote or a space', async ({ assert }) => {
    for (const model of ["gpt'", 'gpt 6', '`x`']) {
      const { command, errors } = await runMakeAgent(root, ['Coder', `--model=${model}`])

      assert.equal(command.exitCode, 1, model)
      assert.isTrue(errors.some((e) => e.includes('--model')), model)
    }
    assert.isFalse(existsSync(join(root, 'app')))
  })

  test('rejects a token budget that is not a positive integer', async ({ assert }) => {
    for (const value of ['0', '-5', '1.5']) {
      const { command } = await runMakeAgent(root, ['Coder', `--max-tokens=${value}`])
      assert.equal(command.exitCode, 1, value)
    }
    assert.isFalse(existsSync(join(root, 'app')))
  })
})
