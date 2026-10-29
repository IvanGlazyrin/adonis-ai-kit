import { test } from '@japa/runner'
import { z } from 'zod'
import { SchemaRegistry } from '../../../src/guard/schema_registry.js'

test.group('SchemaRegistry validate', () => {
  test('registered schemas can be looked up and bulk-registered', ({ assert }) => {
    const schema = z.object({ n: z.number() })
    const registry = new SchemaRegistry().register('one', schema).registerMany({ two: z.string() })

    assert.strictEqual(registry.get('one'), schema)
    assert.isDefined(registry.get('two'))
    assert.isUndefined(registry.get('three'))
  })

  test('valid data comes back parsed, with the schema transforms applied', ({ assert }) => {
    const registry = new SchemaRegistry().register('t', z.object({ n: z.coerce.number() }))

    const result = registry.validate<{ n: number }>('t', { n: '7' })

    assert.isTrue(result.success)
    if (result.success) assert.deepEqual(result.data, { n: 7 })
  })

  test('an unregistered schema name fails with no issues', ({ assert }) => {
    const result = new SchemaRegistry().validate('missing', {})

    assert.isFalse(result.success)
    if (!result.success) {
      assert.include(result.error, 'Schema "missing" is not registered')
      assert.deepEqual(result.issues, [])
    }
  })

  test('invalid data fails with the issues and a message that names the field', ({ assert }) => {
    const registry = new SchemaRegistry().register('t', z.object({ n: z.number() }))

    const result = registry.validate('t', { n: 'nope' })

    assert.isFalse(result.success)
    if (!result.success) {
      assert.isAbove(result.issues.length, 0)
      assert.include(result.error, 'n')
    }
  })
})
