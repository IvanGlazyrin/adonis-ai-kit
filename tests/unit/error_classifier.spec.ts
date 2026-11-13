import { test } from '@japa/runner'
import {
  CREDENTIAL_ERROR_CLASSES,
  classifyError,
  classifyErrorClass,
  countsAsBreakerFailure,
  getUserFriendlyMessage,
  isRetryableError,
  type ErrorClass,
  type ErrorKind,
} from '../../src/error_classifier.js'
import { AiException, ProviderUnavailableError } from '../../src/errors.js'

const e = (props: Record<string, unknown>, msg = 'x') => Object.assign(new Error(msg), props)

test.group('classifyError', () => {
  const cases: Array<[string, unknown, ErrorKind, ErrorClass, boolean]> = [
    ['400 context length', e({ statusCode: 400 }, 'maximum context length is 8192'), 'retryable', 'prompt_too_long', false],
    ['no output', e({ name: 'AI_NoOutputGeneratedError' }), 'retryable', 'no_output_generated', false],
    ['429 in cause', e({ cause: { statusCode: 429 } }), 'retryable', 'rate_limit', true],
    ['RetryError lastError 503', e({ name: 'AI_RetryError', lastError: { statusCode: 503 } }), 'retryable', 'server_error', true],
    ['status field', e({ status: 502 }), 'retryable', 'server_error', true],
    ['response.status field', e({ response: { status: 500 } }), 'retryable', 'server_error', true],
    ['409', e({ statusCode: 409 }), 'retryable', 'overloaded', true],
    ['425', e({ statusCode: 425 }), 'retryable', 'overloaded', true],
    ['529', e({ statusCode: 529 }), 'retryable', 'overloaded', true],
    ['408', e({ statusCode: 408 }), 'retryable', 'timeout', true],
    ['ECONNRESET', e({ code: 'ECONNRESET' }), 'retryable', 'network_error', true],
    ['code in cause', e({ cause: { code: 'ECONNREFUSED' } }), 'retryable', 'network_error', true],
    ['TimeoutError', e({ name: 'TimeoutError' }), 'retryable', 'timeout', true],
    ['fetch failed message', new Error('fetch failed'), 'retryable', 'network_error', true],
    ['provider marked retryable', e({ isRetryable: true }, 'weird'), 'retryable', 'unknown', false],
    ['401', e({ statusCode: 401 }), 'fatal', 'auth_error', false],
    ['403', e({ statusCode: 403 }), 'fatal', 'auth_error', false],
    ['402', e({ statusCode: 402 }), 'fatal', 'billing_error', false],
    ['404', e({ statusCode: 404 }), 'fatal', 'model_not_found', false],
    ['400 bad request', e({ statusCode: 400 }, 'invalid param'), 'fatal', 'invalid_request', false],
    ['plain object 400', { statusCode: 400 }, 'fatal', 'invalid_request', false],
    ['validation', e({ name: 'AI_TypeValidationError' }), 'fatal', 'unknown', false],
    ['unrecognized', new Error('something weird'), 'fatal', 'unknown', false],
    ['null', null, 'fatal', 'unknown', false],
    ['string', 'string error', 'fatal', 'unknown', false],
  ]

  for (const [name, err, kind, errorClass, counts] of cases) {
    test(name, ({ assert }) => {
      const c = classifyError(err)
      assert.deepInclude(c, { kind, errorClass, countsAsFailure: counts })
      assert.equal(classifyErrorClass(err), errorClass)
    })
  }

  test('loose network message is retryable and counts', ({ assert }) => {
    assert.deepInclude(classifyError(new Error('socket hang up')), {
      kind: 'retryable',
      errorClass: 'network_error',
      countsAsFailure: true,
    })
  })

  test('explicit non-retryable status is not overridden by message heuristics', ({ assert }) => {
    assert.equal(classifyError(e({ statusCode: 422 }, 'network layer rejected')).kind, 'fatal')
  })

  test('classifyErrorClass agrees with the table for non-heuristic cases', ({ assert }) => {
    assert.equal(classifyErrorClass(e({ statusCode: 429 })), 'rate_limit')
    assert.equal(classifyErrorClass(new Error('ETIMEDOUT')), 'timeout')
    assert.equal(classifyErrorClass(new Error('ECONNREFUSED')), 'network_error')
    assert.equal(classifyErrorClass(e({ statusCode: 400 }, 'max_tokens exceeded')), 'prompt_too_long')
  })

  test('walks a cause chain up to depth 5', ({ assert }) => {
    let err: Record<string, unknown> = { statusCode: 429 }
    for (let i = 0; i < 4; i++) err = { cause: err }
    assert.equal(classifyErrorClass(err), 'rate_limit')
    err = { cause: err }
    err = { cause: err }
    assert.equal(classifyErrorClass(err), 'unknown')
  })

  test('survives a circular cause chain', ({ assert }) => {
    const a: Record<string, unknown> = {}
    a.cause = a
    assert.equal(classifyErrorClass(a), 'unknown')
  })

  test('caller abort wins over a retryable status', ({ assert }) => {
    const ac = new AbortController()
    ac.abort()
    assert.include(classifyError(e({ statusCode: 503 }), ac.signal), { kind: 'fatal', countsAsFailure: false })
  })

  test('AbortError is fatal', ({ assert }) => {
    assert.include(classifyError(e({ name: 'AbortError' })), { kind: 'fatal', countsAsFailure: false })
  })

  test('open breaker is skip', ({ assert }) => {
    const c = classifyError(new ProviderUnavailableError('p'))
    assert.equal(c.kind, 'skip')
    assert.isFalse(c.countsAsFailure)
  })

  test('missing dependency and config errors are skip', ({ assert }) => {
    assert.equal(classifyError(new AiException('m', 'E_AI_MISSING_DEPENDENCY')).kind, 'skip')
    assert.equal(classifyError(new AiException('m', 'E_AI_CONFIG_ERROR')).kind, 'skip')
  })
})

test.group('error classes', () => {
  test('user friendly messages exist for all classes', ({ assert }) => {
    const classes: ErrorClass[] = [
      'rate_limit',
      'overloaded',
      'timeout',
      'auth_error',
      'billing_error',
      'model_not_found',
      'prompt_too_long',
      'invalid_request',
      'server_error',
      'network_error',
      'no_output_generated',
      'unknown',
    ]
    for (const cls of classes) {
      const msg = getUserFriendlyMessage(cls)
      assert.isString(msg)
      assert.isTrue(msg.length > 0)
    }
    assert.equal(getUserFriendlyMessage('billing_error'), 'API billing problem — check account balance')
  })

  test('CREDENTIAL_ERROR_CLASSES holds auth_error and billing_error', ({ assert }) => {
    assert.sameMembers([...CREDENTIAL_ERROR_CLASSES], ['auth_error', 'billing_error'])
  })

  test('identifies retryable error classes for fallback routing', ({ assert }) => {
    for (const cls of ['rate_limit', 'overloaded', 'timeout', 'server_error', 'network_error', 'prompt_too_long', 'no_output_generated'] as const) {
      assert.isTrue(isRetryableError(cls), cls)
    }
    for (const cls of ['auth_error', 'billing_error', 'model_not_found', 'invalid_request', 'unknown'] as const) {
      assert.isFalse(isRetryableError(cls), cls)
    }
  })

  test('only upstream-health classes count against the breaker', ({ assert }) => {
    for (const cls of ['rate_limit', 'overloaded', 'timeout', 'server_error', 'network_error'] as const) {
      assert.isTrue(countsAsBreakerFailure(cls), cls)
    }
    for (const cls of ['prompt_too_long', 'no_output_generated', 'auth_error', 'billing_error', 'model_not_found', 'invalid_request', 'unknown'] as const) {
      assert.isFalse(countsAsBreakerFailure(cls), cls)
    }
  })
})
