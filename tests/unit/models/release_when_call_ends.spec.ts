import { test } from '@japa/runner'
import { LanguageModelFactory } from '../../../src/models/language_model_factory.js'

/** A driver stand-in that counts how often the factory shuts it down. */
const fakeDriver = () => {
  const log = { shutdowns: 0 }
  return { log, shutdown: async () => void log.shutdowns++ }
}

/** A stream that yields `chunks` and closes. */
const streamOf = (chunks: string[]) =>
  new ReadableStream<string>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
  })

/** Wraps `model` the way the factory does for per-call ACP models. */
const wrap = (driver: unknown, model: unknown) =>
  (new LanguageModelFactory() as any).releaseWhenCallEnds(driver, model) as any

const deferred = <T>() => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test.group('ACP per-call driver tracking', () => {
  test('a non-object model is returned untouched', ({ assert }) => {
    assert.equal(wrap(fakeDriver(), 'plain'), 'plain')
  })

  test('plain properties pass through and methods are bound to the model', ({ assert }) => {
    const model = {
      modelId: 'acp-model',
      who() {
        return this === model
      },
    }
    const proxied = wrap(fakeDriver(), model)

    assert.equal(proxied.modelId, 'acp-model')
    assert.isTrue(proxied.who())
  })

  test('a finished doGenerate leaves no driver to shut down', async ({ assert }) => {
    const driver = fakeDriver()
    const factory = new LanguageModelFactory()
    const proxied = (factory as any).releaseWhenCallEnds(driver, {
      doGenerate: async () => ({ text: 'ok' }),
    })

    assert.deepEqual(await proxied.doGenerate({}), { text: 'ok' })
    await factory.shutdown()

    assert.equal(driver.log.shutdowns, 0)
  })

  test('shutdown stops the driver while a doGenerate is in flight', async ({ assert }) => {
    const driver = fakeDriver()
    const factory = new LanguageModelFactory()
    const gate = deferred<{ text: string }>()
    const proxied = (factory as any).releaseWhenCallEnds(driver, { doGenerate: () => gate.promise })

    const call = proxied.doGenerate({})
    await factory.shutdown()
    assert.equal(driver.log.shutdowns, 1)

    gate.resolve({ text: 'late' })
    await call
  })

  test('a failed doGenerate also releases the driver', async ({ assert }) => {
    const driver = fakeDriver()
    const factory = new LanguageModelFactory()
    const proxied = (factory as any).releaseWhenCallEnds(driver, {
      doGenerate: async () => {
        throw new Error('model failed')
      },
    })

    await assert.rejects(() => proxied.doGenerate({}), 'model failed')
    await factory.shutdown()

    assert.equal(driver.log.shutdowns, 0)
  })

  test('the driver stays tracked until the last of two concurrent calls ends', async ({ assert }) => {
    const driver = fakeDriver()
    const factory = new LanguageModelFactory()
    const first = deferred<{ text: string }>()
    const second = deferred<{ text: string }>()
    const pending = [first, second]
    const proxied = (factory as any).releaseWhenCallEnds(driver, {
      doGenerate: () => pending.shift()!.promise,
    })

    const a = proxied.doGenerate({})
    const b = proxied.doGenerate({})
    first.resolve({ text: 'a' })
    await a
    await factory.shutdown()
    assert.equal(driver.log.shutdowns, 1)

    second.resolve({ text: 'b' })
    await b
  })

  test('a stream keeps the driver tracked until it is fully read', async ({ assert }) => {
    const driver = fakeDriver()
    const factory = new LanguageModelFactory()
    const proxied = (factory as any).releaseWhenCallEnds(driver, {
      doStream: async () => ({ stream: streamOf(['a', 'b']), request: { id: 1 } }),
    })

    const result = await proxied.doStream({})
    assert.deepEqual(result.request, { id: 1 })

    const reader = result.stream.getReader()
    assert.equal((await reader.read()).value, 'a')
    await factory.shutdown()
    assert.equal(driver.log.shutdowns, 1)

    while (!(await reader.read()).done) {
      // drain the rest
    }
  })

  test('a fully read stream releases the driver', async ({ assert }) => {
    const driver = fakeDriver()
    const factory = new LanguageModelFactory()
    const proxied = (factory as any).releaseWhenCallEnds(driver, {
      doStream: async () => ({ stream: streamOf(['only']) }),
    })

    const result = await proxied.doStream({})
    const chunks: string[] = []
    for await (const chunk of result.stream as AsyncIterable<string>) chunks.push(chunk)
    await factory.shutdown()

    assert.deepEqual(chunks, ['only'])
    assert.equal(driver.log.shutdowns, 0)
  })

  test('cancelling a stream releases the driver', async ({ assert }) => {
    const driver = fakeDriver()
    const factory = new LanguageModelFactory()
    const proxied = (factory as any).releaseWhenCallEnds(driver, {
      doStream: async () => ({ stream: streamOf(['a', 'b']) }),
    })

    const result = await proxied.doStream({})
    await result.stream.cancel('user left')
    await factory.shutdown()

    assert.equal(driver.log.shutdowns, 0)
  })

  test('a doStream that fails to start is released and its error propagates', async ({ assert }) => {
    const driver = fakeDriver()
    const factory = new LanguageModelFactory()
    const proxied = (factory as any).releaseWhenCallEnds(driver, {
      doStream: async () => {
        throw new Error('no stream')
      },
    })

    await assert.rejects(() => proxied.doStream({}), 'no stream')
    await factory.shutdown()

    assert.equal(driver.log.shutdowns, 0)
  })
})
