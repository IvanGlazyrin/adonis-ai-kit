import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import Configure from '@adonisjs/core/commands/configure'
import { AceFactory, IgnitorFactory } from '@adonisjs/core/factories'
import { configure } from '../../configure.js'
import { stubsRoot } from '../../stubs/main.js'
import * as kit from '../../src/index.js'

const ADONISRC = `import { defineConfig } from '@adonisjs/core/app'

export default defineConfig({
  commands: [() => import('@adonisjs/core/commands')],
  providers: [() => import('@adonisjs/core/providers/app_provider')],
})
`

const START_ENV = `import { Env } from '@adonisjs/core/env'

export default await Env.create(new URL('../', import.meta.url), {
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
})
`

/** A throwaway AdonisJS app on disk: just the files the codemods edit. */
function makeFixtureApp() {
  const root = mkdtempSync(join(tmpdir(), 'adonis-ai-configure-'))
  mkdirSync(join(root, 'start'))
  mkdirSync(join(root, 'config'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }))
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext' } }))
  writeFileSync(join(root, 'adonisrc.ts'), ADONISRC)
  writeFileSync(join(root, 'start/env.ts'), START_ENV)
  writeFileSync(join(root, '.env'), 'NODE_ENV=development\n')
  writeFileSync(join(root, '.env.example'), 'NODE_ENV=development\n')
  return root
}

/** Runs `node ace configure adonis-ai-kit` against the fixture app. */
async function runConfigure(root: string) {
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .create(pathToFileURL(`${root}/`), {
      importer: async (specifier) => {
        if (specifier === 'adonis-ai-kit') return { configure, stubsRoot }
        return import(specifier)
      },
    })
  const ace = await new AceFactory().make(ignitor)
  await ace.app.init()
  ace.ui.switchMode('raw')
  const command = await ace.create(Configure, ['adonis-ai-kit'])
  await command.exec()
  return command
}

test.group('configure', (group) => {
  let root: string

  group.each.setup(() => {
    root = makeFixtureApp()
    return () => rmSync(root, { recursive: true, force: true })
  })

  test('configure registers provider, commands and config', async ({ assert }) => {
    const command = await runConfigure(root)

    assert.equal(command.exitCode, 0)
    const rc = readFileSync(join(root, 'adonisrc.ts'), 'utf-8')
    assert.include(rc, "import('adonis-ai-kit/providers/ai_provider')")
    assert.include(rc, "import('adonis-ai-kit/commands')")

    const config = readFileSync(join(root, 'config/ai.ts'), 'utf-8')
    assert.include(config, "import { defineConfig } from 'adonis-ai-kit'")
    assert.include(config, "import env from '#start/env'")
    assert.include(config, "default: 'openai'")
    assert.include(config, "apiKey: env.get('OPENAI_API_KEY')")

    const startEnv = readFileSync(join(root, 'start/env.ts'), 'utf-8')
    assert.include(startEnv, 'OPENAI_API_KEY')
    assert.include(startEnv, 'ANTHROPIC_API_KEY')
    assert.include(readFileSync(join(root, '.env'), 'utf-8'), 'OPENAI_API_KEY=')
    assert.include(readFileSync(join(root, '.env.example'), 'utf-8'), 'OPENAI_API_KEY=')
  })

  test('configure keeps an existing config/ai.ts', async ({ assert }) => {
    const mine = '// my own config, do not touch\nexport default {}\n'
    writeFileSync(join(root, 'config/ai.ts'), mine)

    await runConfigure(root)

    assert.equal(readFileSync(join(root, 'config/ai.ts'), 'utf-8'), mine)
  })

  test('running configure twice registers the provider and commands once', async ({ assert }) => {
    await runConfigure(root)
    await runConfigure(root)

    const rc = readFileSync(join(root, 'adonisrc.ts'), 'utf-8')
    assert.lengthOf(rc.match(/adonis-ai-kit\/providers\/ai_provider/g) ?? [], 1)
    assert.lengthOf(rc.match(/adonis-ai-kit\/commands/g) ?? [], 1)
  })
})

test.group('configure package wiring', () => {
  test('the package entry re-exports configure', ({ assert }) => {
    assert.strictEqual(kit.configure, configure)
  })

  test('stubsRoot holds config/ai.stub that targets config/ai.ts', ({ assert }) => {
    const stub = join(stubsRoot, 'config/ai.stub')
    assert.isTrue(existsSync(stub))
    const source = readFileSync(stub, 'utf-8')
    assert.include(source, "app.configPath('ai.ts')")
    assert.include(source, 'defineConfig')
  })
})
