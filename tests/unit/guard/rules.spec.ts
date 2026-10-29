import { test } from '@japa/runner'
import { enumRule, rangeRule, reconcileExecutionClaims } from '../../../src/guard/guard.js'

test.group('guard parameter rules', () => {
  test('rangeRule accepts numbers and numeric strings inside the range', ({ assert }) => {
    const rule = rangeRule('n', 0, 10)

    assert.isNull(rule.validate(5, {}))
    assert.isNull(rule.validate('7', {}))
    assert.isNull(rule.validate(0, {}))
    assert.isNull(rule.validate(10, {}))
  })

  test('rangeRule reports a value outside the range with its bounds', ({ assert }) => {
    const rule = rangeRule('n', 0, 10)

    assert.equal(rule.validate(11, {}), 'n 11 is out of permitted range [0, 10]')
    assert.equal(rule.validate('-1', {}), 'n -1 is out of permitted range [0, 10]')
  })

  test('rangeRule rejects values that are not real numbers', ({ assert }) => {
    const rule = rangeRule('n', 0, 10, 'amount')

    for (const bad of ['', '   ', null, undefined, true, [5], { n: 5 }, Number.NaN, 'abc']) {
      assert.equal(rule.validate(bad, {}), 'amount must be a valid number', `value ${JSON.stringify(bad)}`)
    }
  })

  test('enumRule accepts only the listed strings', ({ assert }) => {
    const rule = enumRule('mode', ['read', 'write'])

    assert.isNull(rule.validate('read', {}))
    assert.equal(rule.validate('delete', {}), 'mode "delete" is not allowed. Permitted: read, write')
  })

  test('enumRule rejects non-strings even when they stringify to a listed value', ({ assert }) => {
    const rule = enumRule('mode', ['1'], 'choice')

    assert.equal(rule.validate(1, {}), 'choice "1" is not allowed. Permitted: 1')
    assert.equal(rule.validate(undefined, {}), 'choice "undefined" is not allowed. Permitted: 1')
  })
})

test.group('reconcileExecutionClaims', () => {
  const guardWith = (acceptedCalls: unknown) => ({
    check: () => null,
    record() {},
    release() {},
    summary: () => ({ acceptedCalls }),
  })

  test('a claim that matches the accepted calls is not a mismatch', ({ assert }) => {
    assert.deepEqual(reconcileExecutionClaims(2, guardWith(2) as any), { claimed: 2, verified: 2, mismatch: false })
  })

  test('a claim above the accepted calls is a mismatch', ({ assert }) => {
    assert.deepEqual(reconcileExecutionClaims('3', guardWith(1) as any), { claimed: 3, verified: 1, mismatch: true })
  })

  test('without a guard nothing is verified', ({ assert }) => {
    assert.deepEqual(reconcileExecutionClaims(1), { claimed: 1, verified: 0, mismatch: true })
  })

  test('a guard that reports no accepted count verifies zero', ({ assert }) => {
    assert.equal(reconcileExecutionClaims(0, guardWith('many') as any).verified, 0)
  })

  test('an unparseable or non-finite claim counts as zero', ({ assert }) => {
    assert.equal(reconcileExecutionClaims('abc').claimed, 0)
    assert.equal(reconcileExecutionClaims(Infinity).claimed, 0)
    assert.equal(reconcileExecutionClaims(undefined).claimed, 0)
  })
})
