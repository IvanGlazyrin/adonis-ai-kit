import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { AgentLoader } from '../../../src/agents/loader.js'

const dirs = () => {
  const root = mkdtempSync(join(tmpdir(), 'adonis-ai-cache-'))
  const configsDir = join(root, 'agents')
  const skillsDir = join(root, 'skills')
  mkdirSync(configsDir)
  mkdirSync(skillsDir)
  return { configsDir, skillsDir }
}

test.group('AgentLoader bulk load and cache', () => {
  test('loadAllAgentPrompts loads every markdown file by its name and skips the rest', async ({ assert }) => {
    const d = dirs()
    writeFileSync(join(d.configsDir, 'alpha.md'), '---\ndescription: A\n---\nAlpha body')
    writeFileSync(join(d.configsDir, 'beta.md'), 'Beta body')
    writeFileSync(join(d.configsDir, 'notes.txt'), 'not an agent')

    const all = await new AgentLoader().loadAllAgentPrompts(d.configsDir, d.skillsDir)

    assert.sameMembers(Object.keys(all), ['alpha', 'beta'])
    assert.equal(all.alpha.description, 'A')
    assert.equal(all.beta.body, 'Beta body')
  })

  test('a missing configs folder loads nothing and warns', async ({ assert }) => {
    const warnings: string[] = []
    const loader = new AgentLoader({
      logger: { info() {}, debug() {}, error() {}, warn: (m: string) => void warnings.push(m) } as any,
    })

    const all = await loader.loadAllAgentPrompts('/definitely/not/here', '/nor/here')

    assert.deepEqual(all, {})
    assert.isTrue(warnings.some((w) => w.includes('Configs directory does not exist')))
  })

  test('a cached agent is reloaded after its file changes only once it is invalidated', async ({ assert }) => {
    const d = dirs()
    writeFileSync(join(d.configsDir, 'cfg.md'), 'First')
    const loader = new AgentLoader()
    const first = await loader.loadAgentPrompt('cfg', d.configsDir, d.skillsDir)

    writeFileSync(join(d.configsDir, 'cfg.md'), 'Second')
    assert.strictEqual(await loader.loadAgentPrompt('cfg', d.configsDir, d.skillsDir), first)

    loader.invalidateCache('cfg')
    const reloaded = await loader.loadAgentPrompt('cfg', d.configsDir, d.skillsDir)
    assert.equal(reloaded.body, 'Second')
  })

  test('invalidating one agent leaves the others cached, and no argument clears everything', async ({ assert }) => {
    const d = dirs()
    writeFileSync(join(d.configsDir, 'a.md'), 'A')
    writeFileSync(join(d.configsDir, 'b.md'), 'B')
    const loader = new AgentLoader()
    const a = await loader.loadAgentPrompt('a', d.configsDir, d.skillsDir)
    const b = await loader.loadAgentPrompt('b', d.configsDir, d.skillsDir)

    loader.invalidateCache('a')
    assert.notStrictEqual(await loader.loadAgentPrompt('a', d.configsDir, d.skillsDir), a)
    assert.strictEqual(await loader.loadAgentPrompt('b', d.configsDir, d.skillsDir), b)

    loader.invalidateCache()
    assert.notStrictEqual(await loader.loadAgentPrompt('b', d.configsDir, d.skillsDir), b)
  })
})
