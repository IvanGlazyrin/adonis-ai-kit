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

test.group('AgentLoader skill metadata', () => {
  test('skill frontmatter: description is read and stripped from the body', ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'adonis-ai-skill-'))
    writeFileSync(join(dir, 'greet.md'), '---\ndescription: Greets the user\n---\n# Greet\nSay hello.\n')
    const loader = new AgentLoader()

    assert.equal(loader.loadSkill('greet', dir), '# Greet\nSay hello.')
    assert.equal(loader.loadSkillEntry('greet', dir)?.description, 'Greets the user')
  })

  test('skill without frontmatter: description falls back to the first heading', ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'adonis-ai-skill-'))
    writeFileSync(join(dir, 'ta.md'), '# Technical analysis Skill\n\nRead charts.\n')

    const entry = new AgentLoader().loadSkillEntry('ta', dir)

    assert.equal(entry?.description, 'Technical analysis Skill')
    assert.equal(entry?.body, '# Technical analysis Skill\n\nRead charts.')
  })

  test('skill without heading: description is the name', ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'adonis-ai-skill-'))
    writeFileSync(join(dir, 'plain.md'), 'Just text.\n')

    assert.equal(new AgentLoader().loadSkillEntry('plain', dir)?.description, 'plain')
  })

  test('skill with broken frontmatter YAML: warned, description from the heading, no frontmatter in the body', ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'adonis-ai-skill-'))
    writeFileSync(join(dir, 'bad.md'), '---\ndescription: [unclosed\n---\n# Bad skill\nBody.\n')
    const { warnings, logger } = quiet()

    const entry = new AgentLoader({ logger }).loadSkillEntry('bad', dir)

    assert.equal(entry?.description, 'Bad skill')
    assert.equal(entry?.body, '# Bad skill\nBody.')
    assert.isTrue(warnings.some((w) => w.includes('invalid YAML frontmatter')))
  })
})

test.group('AgentLoader skill size limit', () => {
  test('skill over 256 KB is skipped with a warning', ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'adonis-ai-skill-'))
    writeFileSync(join(dir, 'huge.md'), 'x'.repeat(256 * 1024 + 1))
    const { warnings, logger } = quiet()

    const text = new AgentLoader({ logger }).loadSkill('huge', dir)

    assert.equal(text, '')
    assert.isTrue(warnings.some((w) => w.includes('larger than')))
  })

  test('skill of exactly 256 KB is loaded', ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'adonis-ai-skill-'))
    writeFileSync(join(dir, 'edge.md'), 'x'.repeat(256 * 1024))

    assert.equal(new AgentLoader().loadSkill('edge', dir).length, 256 * 1024)
  })
})
