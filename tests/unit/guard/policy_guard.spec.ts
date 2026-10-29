import { test } from '@japa/runner'
import { PolicyGuard } from '../../../src/guard/guard.js'

test.group('PolicyGuard', () => {
  test('a tool outside allowedTools is refused', ({ assert }) => {
    const guard = new PolicyGuard({ allowedTools: ['search'] })

    assert.equal(guard.check('delete', {}), 'Tool "delete" is not permitted by policy')
    assert.isNull(guard.check('search', {}))
  })

  test('maxCalls counts in-flight reservations, so parallel calls cannot all pass', ({ assert }) => {
    const guard = new PolicyGuard({ maxCalls: 1 })

    assert.isNull(guard.check('t', {}))
    assert.equal(guard.check('t', {}), 'Maximum allowed calls (1) exceeded for policy')
  })

  test('record keeps the slot counted; release gives it back', ({ assert }) => {
    const guard = new PolicyGuard({ maxCalls: 1 })

    guard.check('t', {})
    guard.record('t', { ok: true })
    assert.equal(guard.check('t', {}), 'Maximum allowed calls (1) exceeded for policy')

    const other = new PolicyGuard({ maxCalls: 1 })
    other.check('t', {})
    other.release('t')
    assert.isNull(other.check('t', {}))
  })

  test('a failed result counts as a call but not as an accepted one', ({ assert }) => {
    const guard = new PolicyGuard()

    guard.check('t', {})
    guard.record('t', { error: 'boom' })
    guard.check('t', {})
    guard.record('t', { ok: true })

    assert.equal(guard.totalCalls, 2)
    assert.equal(guard.acceptedCalls, 1)
  })

  test('a parameter rule that fails returns its violation', ({ assert }) => {
    const guard = new PolicyGuard()
    guard.addRule('read', {
      field: 'path',
      validate: (value) => (typeof value === 'string' && value.startsWith('/tmp') ? null : 'path must be under /tmp'),
    })

    assert.equal(guard.check('read', { path: '/etc/passwd' }), 'path must be under /tmp')
    assert.isNull(guard.check('read', { path: '/tmp/ok' }))
  })

  test('rules given in the constructor apply like added ones', ({ assert }) => {
    const guard = new PolicyGuard({
      rules: { read: [{ field: 'path', validate: (v) => (v === 'x' ? null : 'nope') }] },
    })

    assert.equal(guard.check('read', { path: 'y' }), 'nope')
  })

  test('a rule sees the whole argument object, not just its field', ({ assert }) => {
    const guard = new PolicyGuard()
    guard.addRule('send', {
      field: 'to',
      validate: (_to, all) => (all.confirmed === true ? null : 'confirmation required'),
    })

    assert.equal(guard.check('send', { to: 'a' }), 'confirmation required')
    assert.isNull(guard.check('send', { to: 'a', confirmed: true }))
  })

  test('a tool with rules fails closed on non-object arguments', ({ assert }) => {
    const guard = new PolicyGuard()
    guard.addRule('read', { field: 'path', validate: () => null })

    assert.equal(guard.check('read', 'a string'), 'Arguments for "read" must be an object to be validated by policy')
    assert.equal(guard.check('read', ['arr']), 'Arguments for "read" must be an object to be validated by policy')
    assert.equal(guard.check('read', null), 'Arguments for "read" must be an object to be validated by policy')
  })

  test('a tool without rules accepts any argument shape', ({ assert }) => {
    assert.isNull(new PolicyGuard().check('anything', 'raw string'))
  })

  test('summary reports totals and the limit, with no limit shown as Infinity', ({ assert }) => {
    const guard = new PolicyGuard()
    guard.check('t', {})
    guard.record('t', { ok: 1 })

    assert.deepEqual(guard.summary(), { totalCalls: 1, acceptedCalls: 1, maxCalls: Infinity })
  })
})
