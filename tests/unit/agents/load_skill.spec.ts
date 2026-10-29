import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { AgentLoader } from '../../../src/agents/loader.js'

const quiet = () => {
  const warnings: string[] = []
  const logger = { info() {}, debug() {}, error() {}, warn: (m: string) => void warnings.push(m) }
  return { warnings, logger: logger as any }
}

test.group('AgentLoader.loadSkill', () => {
  test('a skill file is read and trimmed', ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'adonis-ai-skill-'))
    writeFileSync(join(dir, 'greet.md'), '\n  Say hello.  \n')

    assert.equal(new AgentLoader().loadSkill('greet', dir), 'Say hello.')
  })

  test('a skill path that cannot be read is reported and gives empty text', ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'adonis-ai-skill-'))
    mkdirSync(join(dir, 'broken.md'))
    const { warnings, logger } = quiet()

    const text = new AgentLoader({ logger }).loadSkill('broken', dir)

    assert.equal(text, '')
    assert.isTrue(warnings.some((w) => w.includes('Failed to read skill file')))
  })
})
