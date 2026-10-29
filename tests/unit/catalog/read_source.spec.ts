import { mkdtempSync, writeFileSync } from 'node:fs'
import { utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { DEFAULT_MODEL_PRICING } from '../../../src/budget/pricing.js'
import { ModelsDevSource } from '../../../src/catalog/source.js'

const provider = (id: string) => ({ id, name: id, env: [], models: { m1: { id: 'm1', name: 'M1', tool_call: true } } })

/** Every request fails with 500; counts requests. */
async function withFailingFetch(run: (count: () => number) => Promise<void>) {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response('down', { status: 500 })
  }
  try {
    await run(() => calls)
  } finally {
    globalThis.fetch = original
  }
}

const dirWith = () => mkdtempSync(join(tmpdir(), 'adonis-ai-read-'))

const sourceAt = (dir: string, extra: Record<string, unknown> = {}) =>
  new ModelsDevSource({
    cachePath: join(dir, 'cache.json'),
    systemProviders: { fallback: false, acp: false },
    ...extra,
  } as any)

test.group('ModelsDevSource source selection', () => {
  test('a valid override file is used and the network is not touched', async ({ assert }) => {
    const dir = dirWith()
    const overridePath = join(dir, 'override.json')
    writeFileSync(overridePath, JSON.stringify({ overprov: provider('overprov') }))

    await withFailingFetch(async (count) => {
      const cat = await sourceAt(dir, { overridePath }).load()
      assert.property(cat, 'overprov')
      assert.equal(count(), 0)
    })
  })

  test('an override file with no valid providers is skipped in favour of the rest', async ({ assert }) => {
    const dir = dirWith()
    const overridePath = join(dir, 'override.json')
    writeFileSync(overridePath, JSON.stringify({ junk: 'not a provider' }))

    await withFailingFetch(async () => {
      const cat = await sourceAt(dir, { overridePath }).load()
      assert.notProperty(cat, 'overprov')
      assert.property(cat, 'openai')
    })
  })

  test('an unparseable override file is skipped with the rest of the chain', async ({ assert }) => {
    const dir = dirWith()
    const overridePath = join(dir, 'override.json')
    writeFileSync(overridePath, '{ not json')

    await withFailingFetch(async () => {
      const cat = await sourceAt(dir, { overridePath }).load()
      assert.property(cat, 'openai')
    })
  })

  test('a fresh local cache is served without a network request', async ({ assert }) => {
    const dir = dirWith()
    writeFileSync(join(dir, 'cache.json'), JSON.stringify({ cacheprov: provider('cacheprov') }))

    await withFailingFetch(async (count) => {
      const cat = await sourceAt(dir, { ttlMs: 60_000 }).load()
      assert.property(cat, 'cacheprov')
      assert.equal(count(), 0)
    })
  })

  test('an expired cache is replaced by a successful remote fetch', async ({ assert }) => {
    const dir = dirWith()
    const cachePath = join(dir, 'cache.json')
    writeFileSync(cachePath, JSON.stringify({ oldprov: provider('oldprov') }))
    const old = new Date(Date.now() - 10 * 60_000)
    await utimes(cachePath, old, old)

    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return new Response(JSON.stringify({ newprov: provider('newprov') }), { status: 200 })
    }
    try {
      const cat = await sourceAt(dir, { ttlMs: 60_000 }).load()
      assert.property(cat, 'newprov')
      assert.notProperty(cat, 'oldprov')
      assert.equal(calls, 1)
    } finally {
      globalThis.fetch = original
    }
  })

  test('when the network fails, an expired cache is still better than nothing', async ({ assert }) => {
    const dir = dirWith()
    const cachePath = join(dir, 'cache.json')
    writeFileSync(cachePath, JSON.stringify({ staleprov: provider('staleprov') }))
    const old = new Date(Date.now() - 10 * 60_000)
    await utimes(cachePath, old, old)

    await withFailingFetch(async () => {
      const cat = await sourceAt(dir, { ttlMs: 60_000 }).load()
      assert.property(cat, 'staleprov')
      assert.notProperty(cat, 'openai')
    })
  })

  test('with no cache and no network, the built-in fallback catalog is used', async ({ assert }) => {
    const dir = dirWith()

    await withFailingFetch(async () => {
      const cat = await sourceAt(dir).load()
      assert.property(cat, 'openai')
      assert.property(cat, 'anthropic')
    })
  })

  test('every fallback catalog model is priced from the built-in table', async ({ assert }) => {
    const dir = dirWith()

    await withFailingFetch(async () => {
      const cat = await sourceAt(dir).load()
      for (const providerId of ['openai', 'anthropic', 'google', 'groq']) {
        for (const model of Object.values(cat[providerId].models)) {
          assert.isDefined(model.cost, `${providerId}/${model.id} has no table price`)
        }
      }
      assert.equal(cat.openai.models['gpt-4o'].cost?.input, DEFAULT_MODEL_PRICING['gpt-4o'].input)
    })
  })
})
