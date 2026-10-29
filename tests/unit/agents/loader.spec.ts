import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { z } from 'zod'
import { AgentLoader } from '../../../src/agents/loader.js'

/** A configs dir and a skills dir, both empty to start with. */
const dirs = () => {
  const root = mkdtempSync(join(tmpdir(), 'adonis-ai-loader-'))
  const configsDir = join(root, 'agents')
  const skillsDir = join(root, 'skills')
  mkdirSync(configsDir)
  mkdirSync(skillsDir)
  return { configsDir, skillsDir }
}

const loaderFor = (
  d: { configsDir: string; skillsDir: string },
  extra: { schemaResolver?: (name: string) => z.ZodTypeAny | undefined; logger?: unknown } = {}
) => new AgentLoader({ ...d, schemaResolver: extra.schemaResolver, logger: extra.logger as never })

const quiet = () => {
  const warnings: string[] = []
  return { warnings, logger: { info() {}, debug() {}, error() {}, warn: (m: string) => warnings.push(m) } }
}

test.group('AgentLoader prompt files', () => {
  test('frontmatter sets the manifest and the body becomes the system prompt', async ({ assert }) => {
    const d = dirs()
    writeFileSync(
      join(d.configsDir, 'writer.md'),
      '---\ndescription: Writes things\nmode: primary\nstop_steps: 3\n---\nYou write.\n'
    )

    const config = await loaderFor(d).loadAgentPrompt('writer')

    assert.equal(config.id, 'writer')
    assert.equal(config.description, 'Writes things')
    assert.equal(config.mode, 'primary')
    assert.equal(config.stopSteps, 3)
    assert.equal(config.body, 'You write.')
    assert.equal(config.systemPrompt, 'You write.')
  })

  test('a file without frontmatter is all body, with the manifest defaults', async ({ assert }) => {
    const d = dirs()
    writeFileSync(join(d.configsDir, 'plain.md'), '  Just text.  \n')

    const config = await loaderFor(d).loadAgentPrompt('plain')

    assert.equal(config.id, 'plain')
    assert.equal(config.mode, 'subagent')
    assert.equal(config.stopSteps, 5)
    assert.deepEqual(config.permissions, {})
    assert.equal(config.body, 'Just text.')
  })

  test('a BOM and CRLF line endings do not break the frontmatter', async ({ assert }) => {
    const d = dirs()
    writeFileSync(join(d.configsDir, 'win.md'), '﻿---\r\ndescription: Windows\r\n---\r\nBody line.\r\n')

    const config = await loaderFor(d).loadAgentPrompt('win')

    assert.equal(config.description, 'Windows')
    assert.equal(config.body, 'Body line.')
  })

  test('listed skills are appended to the system prompt and recorded by name', async ({ assert }) => {
    const d = dirs()
    writeFileSync(join(d.skillsDir, 'greet.md'), 'Say hello.\n')
    writeFileSync(join(d.configsDir, 'host.md'), '---\nskills:\n  - greet\n---\nBase.')

    const config = await loaderFor(d).loadAgentPrompt('host')

    assert.equal(config.systemPrompt, 'Base.\n\n---\n\nSay hello.')
    assert.deepEqual(config.skillPrompts, { greet: 'Say hello.' })
  })

  test('a missing skill is skipped with a warning', async ({ assert }) => {
    const d = dirs()
    const { warnings, logger } = quiet()
    writeFileSync(join(d.configsDir, 'host.md'), '---\nskills:\n  - ghost\n---\nBase.')

    const config = await loaderFor(d, { logger }).loadAgentPrompt('host')

    assert.equal(config.systemPrompt, 'Base.')
    assert.deepEqual(config.skillPrompts, {})
    assert.isTrue(warnings.some((w) => w.includes('Skill not found')))
  })

  test('an unsafe skill name is refused with a warning and loads nothing', async ({ assert }) => {
    const d = dirs()
    const { warnings, logger } = quiet()

    const text = loaderFor(d, { logger }).loadSkill('../secret', d.skillsDir)

    assert.equal(text, '')
    assert.isTrue(warnings.some((w) => w.includes('Refusing unsafe skill name')))
  })

  test('the output schema is resolved by name when a resolver knows it', async ({ assert }) => {
    const d = dirs()
    const schema = z.object({ n: z.number() })
    writeFileSync(join(d.configsDir, 'typed.md'), '---\noutputSchema: Result\n---\nBody')

    const known = await loaderFor(d, { schemaResolver: (n) => (n === 'Result' ? schema : undefined) }).loadAgentPrompt(
      'typed'
    )
    assert.equal(known.outputSchemaName, 'Result')
    assert.strictEqual(known.outputSchema, schema)

    const unknown = await loaderFor(d, { schemaResolver: () => undefined }).loadAgentPrompt('typed')
    assert.equal(unknown.outputSchemaName, 'Result')
    assert.isUndefined(unknown.outputSchema)
  })

  test('the same agent is served from cache until the loader is replaced', async ({ assert }) => {
    const d = dirs()
    writeFileSync(join(d.configsDir, 'once.md'), 'First.')
    const loader = loaderFor(d)

    const first = await loader.loadAgentPrompt('once')
    writeFileSync(join(d.configsDir, 'once.md'), 'Second.')
    const again = await loader.loadAgentPrompt('once')

    assert.strictEqual(again, first)
    assert.equal(again.body, 'First.')
  })

  test('an unsafe agent id is rejected before any file is read', async ({ assert }) => {
    const d = dirs()
    await assert.rejects(() => loaderFor(d).loadAgentPrompt('../etc/passwd'), /Invalid agent id/)
  })

  test('a missing agent file is an error that names the path', async ({ assert }) => {
    const d = dirs()
    await assert.rejects(() => loaderFor(d).loadAgentPrompt('absent'), /Agent prompt configuration file not found/)
  })

  test('broken YAML frontmatter is reported as a parse error', async ({ assert }) => {
    const d = dirs()
    writeFileSync(join(d.configsDir, 'bad.md'), '---\nkey: [unclosed\n---\nBody')
    await assert.rejects(() => loaderFor(d).loadAgentPrompt('bad'), /Failed to parse YAML frontmatter/)
  })

  test('a manifest that fails validation is reported as invalid', async ({ assert }) => {
    const d = dirs()
    writeFileSync(join(d.configsDir, 'odd.md'), '---\nmode: wizard\n---\nBody')
    await assert.rejects(() => loaderFor(d).loadAgentPrompt('odd'), /Invalid agent manifest for "odd"/)
  })
})
