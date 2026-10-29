import path from 'node:path'
import { test } from '@japa/runner'
import { AgentLoader } from '../../../src/agents/loader.js'

test.group('AgentLoader directories', () => {
  test('explicit directories are used as given, without resolving defaults', async ({ assert }) => {
    const dirs = await new AgentLoader().resolveDirs('/abs/configs', '/abs/skills')

    assert.deepEqual(dirs, { configsDir: '/abs/configs', skillsDir: '/abs/skills' })
  })

  test('constructor directories are used when the call passes none', async ({ assert }) => {
    const loader = new AgentLoader({ configsDir: '/c', skillsDir: '/s' })

    assert.deepEqual(await loader.resolveDirs(), { configsDir: '/c', skillsDir: '/s' })
  })

  test('a call directory overrides the constructor one', async ({ assert }) => {
    const loader = new AgentLoader({ configsDir: '/c', skillsDir: '/s' })

    assert.deepEqual(await loader.resolveDirs('/other', undefined), { configsDir: '/other', skillsDir: '/s' })
  })

  test('an empty directory string counts as unset and gets the default', async ({ assert }) => {
    const dirs = await new AgentLoader({ configsDir: '/c', skillsDir: '' }).resolveDirs()

    assert.equal(dirs.configsDir, '/c')
    assert.isTrue(path.isAbsolute(dirs.skillsDir))
    assert.isTrue(dirs.skillsDir.endsWith(path.join('resources', 'agent-skills')))
  })

  test('unset directories fall back to the resources folders', async ({ assert }) => {
    const dirs = await new AgentLoader().resolveDirs()

    assert.isTrue(path.isAbsolute(dirs.configsDir))
    assert.isTrue(dirs.configsDir.endsWith(path.join('resources', 'agent-configs')))
    assert.isTrue(dirs.skillsDir.endsWith(path.join('resources', 'agent-skills')))
  })
})
