import { test } from '@japa/runner'
import {
  DEFAULT_MODEL_PRICING,
  lookupPricing,
  normalizeModelName,
  pricingKeyCandidates,
} from '../../../src/budget/pricing.js'

test.group('default pricing table', () => {
  test('every entry has finite, non-negative input and output rates', ({ assert }) => {
    for (const [model, p] of Object.entries(DEFAULT_MODEL_PRICING)) {
      assert.isTrue(Number.isFinite(p.input) && p.input >= 0, `input of ${model}`)
      assert.isTrue(Number.isFinite(p.output) && p.output >= 0, `output of ${model}`)
    }
  })

  test('optional rates, where present, are finite numbers', ({ assert }) => {
    const optional = ['cacheReadCostPer1M', 'cacheWriteCostPer1M', 'reasoningCostPer1M'] as const
    for (const [model, p] of Object.entries(DEFAULT_MODEL_PRICING)) {
      for (const field of optional) {
        if (p[field] !== undefined) {
          assert.isTrue(Number.isFinite(p[field]), `${field} of ${model}`)
        }
      }
    }
  })

  test('a known model carries its own published rates', ({ assert }) => {
    assert.deepEqual(
      { input: DEFAULT_MODEL_PRICING['gpt-4o'].input, output: DEFAULT_MODEL_PRICING['gpt-4o'].output },
      { input: 2.5, output: 10 }
    )
  })
})

test.group('model name normalization', () => {
  test('a provider prefix is removed', ({ assert }) => {
    assert.equal(normalizeModelName('openai/gpt-4o'), 'gpt-4o')
    assert.equal(normalizeModelName('a/b/c'), 'c')
  })

  test('a plain name and an empty name come back unchanged', ({ assert }) => {
    assert.equal(normalizeModelName('gpt-4o'), 'gpt-4o')
    assert.equal(normalizeModelName(''), '')
  })
})

test.group('pricing key candidates', () => {
  test('a dated model falls back to its base name', ({ assert }) => {
    const keys = pricingKeyCandidates('claude-3-7-sonnet-20250219')
    assert.deepEqual(keys, ['claude-3-7-sonnet-20250219', 'claude-3-7-sonnet'])
  })

  test('a -latest alias and an @date suffix both strip to the base name', ({ assert }) => {
    assert.include(pricingKeyCandidates('claude-3-7-sonnet-latest'), 'claude-3-7-sonnet')
    assert.include(pricingKeyCandidates('model@20250101'), 'model')
  })

  test('a name with nothing to strip is its own only candidate', ({ assert }) => {
    assert.deepEqual(pricingKeyCandidates('gpt-4o'), ['gpt-4o'])
  })

  test('a provider-prefixed name is tried both whole and short', ({ assert }) => {
    assert.deepEqual(pricingKeyCandidates('openai/gpt-4o'), ['openai/gpt-4o', 'gpt-4o'])
  })
})

test.group('pricing lookup', () => {
  const table = { 'gpt-4o': { input: 2.5, output: 10 }, 'gpt-4': { input: 30, output: 60 } }

  test('an exact key is found', ({ assert }) => {
    assert.deepEqual(lookupPricing('gpt-4o', table), { input: 2.5, output: 10 })
  })

  test('a dated variant finds its base model', ({ assert }) => {
    assert.deepEqual(lookupPricing('gpt-4o-2024-08-06', table), { input: 2.5, output: 10 })
  })

  test('the longest known prefix wins over a shorter one', ({ assert }) => {
    assert.deepEqual(lookupPricing('gpt-4o-mini-v2', table), { input: 2.5, output: 10 })
  })

  test('an unknown model is not priced', ({ assert }) => {
    assert.isUndefined(lookupPricing('mystery-model', table))
  })

  test('a Map table is searched the same way', ({ assert }) => {
    const map = new Map([['gpt-4o', { input: 1, output: 2 }]])
    assert.deepEqual(lookupPricing('openai/gpt-4o-2024-08-06', map), { input: 1, output: 2 })
  })

  test('inherited object keys never match as prices', ({ assert }) => {
    assert.isUndefined(lookupPricing('constructor', {}))
    assert.isUndefined(lookupPricing('__proto__', {}))
    assert.isUndefined(lookupPricing('toString-x', {}))
  })
})

test.group('pricing suffix rules', () => {
  test('each dated or alias suffix is stripped on its own', ({ assert }) => {
    assert.include(pricingKeyCandidates('m-latest'), 'm')
    assert.include(pricingKeyCandidates('m-2025-01-31'), 'm')
    assert.include(pricingKeyCandidates('m-20250131'), 'm')
    assert.include(pricingKeyCandidates('m@20250131'), 'm')
  })

  test('a date-like tail that is not a full date is kept', ({ assert }) => {
    assert.deepEqual(pricingKeyCandidates('m-2025-1-31'), ['m-2025-1-31'])
    assert.deepEqual(pricingKeyCandidates('m-2025013'), ['m-2025013'])
    assert.deepEqual(pricingKeyCandidates('latest-m'), ['latest-m'])
  })

  test('the longest matching prefix is chosen whatever the table order', ({ assert }) => {
    const shortFirst = { 'gpt-4': { input: 1, output: 1 }, 'gpt-4.1': { input: 2, output: 2 } }
    const longFirst = { 'gpt-4.1': { input: 2, output: 2 }, 'gpt-4': { input: 1, output: 1 } }
    assert.deepEqual(lookupPricing('gpt-4.1-2025-04-14', shortFirst), { input: 2, output: 2 })
    assert.deepEqual(lookupPricing('gpt-4.1-2025-04-14', longFirst), { input: 2, output: 2 })
  })

  test('a prefix must end at a dash, not inside a word', ({ assert }) => {
    assert.isUndefined(lookupPricing('gpt-4ox', { 'gpt-4o': { input: 1, output: 1 } }))
  })
})
