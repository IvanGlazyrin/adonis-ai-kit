import { test } from '@japa/runner'
import { NoObjectGeneratedError } from 'ai'
import { z } from 'zod'
import { AiManager } from '../../src/ai_manager.js'
import { defineConfig } from '../../src/define_config.js'
import { extractFirstJsonValue } from '../../src/json_recovery.js'
import { fakeModel, fakeProvider } from '../../src/testing/index.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

const managerWith = (model: ReturnType<typeof fakeModel>) =>
  new AiManager(
    defineConfig({
      default: 'main',
      providers: { main: fakeProvider(model) },
      catalog: { autoPricing: false },
    } as never),
    quiet
  )

test.group('extractFirstJsonValue', () => {
  test('returns an object that sits between prose', ({ assert }) => {
    assert.equal(extractFirstJsonValue('Here you go: {"a": 1} hope it helps'), '{"a": 1}')
  })

  test('skips braces inside strings and handles escaped quotes', ({ assert }) => {
    const text = 'x {"msg": "a } brace \\" and { more", "n": 2} y'
    assert.equal(extractFirstJsonValue(text), '{"msg": "a } brace \\" and { more", "n": 2}')
  })

  test('returns a top-level array', ({ assert }) => {
    assert.equal(extractFirstJsonValue('items: [1, {"b": 2}, 3] end'), '[1, {"b": 2}, 3]')
  })

  test('a first candidate that does not parse is skipped for the next one', ({ assert }) => {
    assert.equal(extractFirstJsonValue('{not json} and then {"ok": true}'), '{"ok": true}')
  })

  test('text with no valid JSON comes back unchanged', ({ assert }) => {
    const text = 'no json here, only {broken and [also broken'
    assert.equal(extractFirstJsonValue(text), text)
  })
})

test.group('jsonRecovery (D1.3)', () => {
  test('with schema and jsonRecovery, prose around the JSON is removed and the output is parsed', async ({
    assert,
  }) => {
    const model = fakeModel([{ text: 'Here: {"answer": 42} trailing words' }])
    const m = managerWith(model)

    const result = await m.generateText({
      prompt: 'answer',
      schema: z.object({ answer: z.number() }),
      jsonRecovery: true,
    })

    assert.deepEqual(result.output, { answer: 42 })
    assert.isAbove(result.usage.totalTokens, 0)
    assert.isAbove(m.getCostTracker().getRecords()[0].totalTokens, 0)
  })

  test('without jsonRecovery the same answer is a NoObjectGeneratedError, and its usage is recorded as failed', async ({
    assert,
  }) => {
    const model = fakeModel([{ text: 'Here: {"answer": 42} trailing words', usage: { input: 7, output: 3 } }])
    const m = managerWith(model)

    try {
      await m.generateText({ prompt: 'answer', schema: z.object({ answer: z.number() }) })
      assert.fail('expected NoObjectGeneratedError')
    } catch (err) {
      assert.isTrue(NoObjectGeneratedError.isInstance(err))
    }

    const [record] = m.getCostTracker().getRecords()
    assert.equal(record.metadata?.failed, true)
    assert.equal(record.inputTokens, 7)
    assert.equal(record.outputTokens, 3)
  })
})
