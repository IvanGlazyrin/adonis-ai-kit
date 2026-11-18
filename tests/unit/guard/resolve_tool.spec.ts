import { test } from '@japa/runner'
import { ToolRegistry } from '../../../src/guard/index.js'

const tool = (label: string) => ({ description: label, execute: async () => label })

test.group('ToolRegistry tool resolution', () => {
  test('an allowed tool with no guard is returned as the very same object', ({ assert }) => {
    const registered = tool('a')
    const registry = new ToolRegistry({ defaultPermission: 'deny' }).registerTool('a', registered)

    const [got] = Object.values(registry.getToolsByList(['a'], { permissions: { a: 'allow' } }))

    assert.strictEqual(got, registered)
  })

  test('a tool missing from the per-call map takes the registry default', ({ assert }) => {
    const allow = new ToolRegistry({ defaultPermission: 'allow' }).registerTool('a', tool('a'))
    const deny = new ToolRegistry({ defaultPermission: 'deny' }).registerTool('a', tool('a'))

    assert.deepEqual(Object.keys(allow.getToolsByList(['a'], { permissions: {} })), ['a'])
    assert.deepEqual(Object.keys(deny.getToolsByList(['a'], { permissions: {} })), [])
  })

  test('without a per-call map the agent matrix decides', ({ assert }) => {
    const registry = new ToolRegistry({ defaultPermission: 'deny' })
      .registerTool('a', tool('a'))
      .registerTool('b', tool('b'))
      .setAgentPermissions('writer', { a: 'allow' })

    assert.deepEqual(Object.keys(registry.getToolsForAgent('writer')), ['a'])
    assert.deepEqual(Object.keys(registry.getToolsForAgent('reader')), [])
  })

  test('an ask tool without a confirmation service is kept but warned about', ({ assert }) => {
    const warnings: string[] = []
    const registry = new ToolRegistry({
      defaultPermission: 'deny',
      logger: { info() {}, debug() {}, error() {}, warn: (m: string) => void warnings.push(m) } as any,
    }).registerTool('a', tool('a'))

    const [got] = Object.values(registry.getToolsByList(['a'], { permissions: { a: 'ask' } }))

    assert.isDefined(got)
    assert.isTrue(warnings.some((w) => w.includes('requires confirmation but no ConfirmationService')))
  })

  test('an allowed tool with a guard is wrapped, so the guard sees its calls', async ({ assert }) => {
    const registered = tool('a')
    const checked: string[] = []
    const guard = {
      check: (name: string) => {
        checked.push(name)
        return null
      },
      record() {},
      release() {},
    }
    const registry = new ToolRegistry({ defaultPermission: 'deny' }).registerTool('a', registered)

    const [got] = Object.values(registry.getToolsByList(['a'], { permissions: { a: 'allow' }, guard }))

    assert.notStrictEqual(got, registered)
    assert.equal(await got.execute!({}, undefined as any), 'a')
    assert.deepEqual(checked, ['a'])
  })
})
