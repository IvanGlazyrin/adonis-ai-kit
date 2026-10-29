import { test } from '@japa/runner'
import { LanguageModelFactory } from '../../../src/models/language_model_factory.js'

/** Replaces the global fetch for one test and restores it afterwards. */
async function withFetch(impl: typeof fetch, run: () => Promise<void>) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  try {
    await run()
  } finally {
    globalThis.fetch = original
  }
}

const recorder = () => {
  const debug: string[] = []
  const error: string[] = []
  const logger = {
    info() {},
    warn() {},
    debug: (m: string) => void debug.push(m),
    error: (m: string) => void error.push(m),
  }
  return { debug, error, logger: logger as any }
}

const timeoutFetch = (opts: { timeoutMs?: number; logger?: unknown } = {}) =>
  (new LanguageModelFactory({ timeoutMs: opts.timeoutMs ?? 60_000, logger: opts.logger as any }) as any).createTimeoutFetch() as typeof fetch

test.group('LanguageModelFactory request wrapper', () => {
  test('a successful request returns the response and logs its status and method', async ({ assert }) => {
    const { debug, logger } = recorder()
    await withFetch(async () => new Response('ok', { status: 201 }), async () => {
      const res = await timeoutFetch({ logger })('https://models.example/v1/chat', { body: '{}' })
      assert.equal(res.status, 201)
    })

    assert.isTrue(debug.some((m) => m.startsWith('[LLM HTTP] POST https://models.example/v1/chat')))
    assert.isTrue(debug.some((m) => m.startsWith('[LLM HTTP] 201 POST')))
  })

  test('an explicit method is logged instead of the POST default', async ({ assert }) => {
    const { debug, logger } = recorder()
    await withFetch(async () => new Response(''), async () => {
      await timeoutFetch({ logger })('https://models.example/v1/models', { method: 'GET' })
    })

    assert.isTrue(debug.some((m) => m.includes('GET https://models.example/v1/models')))
  })

  test('a URL in a log line is cut to 120 characters', async ({ assert }) => {
    const { debug, logger } = recorder()
    const long = `https://models.example/${'a'.repeat(300)}`
    await withFetch(async () => new Response(''), async () => {
      await timeoutFetch({ logger })(long)
    })

    const line = debug.find((m) => m.startsWith('[LLM HTTP] POST'))!
    assert.notInclude(line, 'a'.repeat(200))
    assert.include(line, long.slice(0, 120))
  })

  test('a network failure is logged as FAILED and rethrown unchanged', async ({ assert }) => {
    const { error, logger } = recorder()
    const boom = new Error('socket hang up')
    await withFetch(async () => {
      throw boom
    }, async () => {
      try {
        await timeoutFetch({ logger })('https://models.example/x')
        assert.fail('expected the request to reject')
      } catch (err) {
        assert.strictEqual(err, boom)
      }
    })

    assert.isTrue(error.some((m) => m.includes('FAILED POST https://models.example/x') && m.includes('socket hang up')))
  })

  test('a request that outlives the timeout is aborted', async ({ assert }) => {
    const { logger } = recorder()
    await withFetch((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
    }), async () => {
      try {
        await timeoutFetch({ timeoutMs: 20, logger })('https://models.example/slow')
        assert.fail('expected a timeout')
      } catch (err: any) {
        assert.isTrue(err.name === 'TimeoutError' || err.name === 'AbortError')
      }
    })
  })

  test('the caller can abort a request before the timeout', async ({ assert }) => {
    const controller = new AbortController()
    await withFetch((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('caller aborted')))
    }), async () => {
      const pending = timeoutFetch()('https://models.example/hang', { signal: controller.signal })
      controller.abort()
      await assert.rejects(() => pending, 'caller aborted')
    })
  })
})
