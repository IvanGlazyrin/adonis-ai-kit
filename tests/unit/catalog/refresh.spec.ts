import { mkdtempSync, writeFileSync } from 'node:fs'
import { utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { ModelsDevSource } from '../../../src/catalog/source.js'

const provider = (id: string) => ({ id, name: id, env: [], models: { m1: { id: 'm1', name: 'M1', tool_call: true } } })

/** Serves `responses` in order and counts how many requests were made. */
async function withFetch(responses: Response[], run: (count: () => number) => Promise<void>) {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    const next = responses.shift()
    if (!next) throw new Error('unexpected fetch call')
    return next
  }
  try {
    await run(() => calls)
  } finally {
    globalThis.fetch = original
  }
}

/** A source whose cache lives in a temp dir; the file is aged by `ageMs` (0 = just written). */
const setup = async (cacheContent?: Record<string, unknown>, ageMs = 0) => {
  const dir = mkdtempSync(join(tmpdir(), 'adonis-ai-refresh-'))
  const cachePath = join(dir, 'cache.json')
  if (cacheContent) writeFileSync(cachePath, JSON.stringify(cacheContent))
  if (cacheContent && ageMs > 0) {
    const old = new Date(Date.now() - ageMs)
    await utimes(cachePath, old, old)
  }
  return { source: sourceAt(cachePath) }
}

const sourceAt = (cachePath: string) =>
  new ModelsDevSource({ cachePath, systemProviders: { fallback: false, acp: false } })

test.group('ModelsDevSource refresh', () => {
  test('a forced refresh uses a fresh local file and does not touch the network', async ({ assert }) => {
    const { source } = await setup({ localprov: provider('localprov') })

    await withFetch([], async (count) => {
      const cat = await source.refresh({ forceRemote: true })
      assert.property(cat, 'localprov')
      assert.equal(count(), 0)
    })
  })

  test('a forced refresh goes to the network when the local file is stale', async ({ assert }) => {
    const { source } = await setup({ localprov: provider('localprov') }, 10 * 60_000)

    await withFetch([new Response(JSON.stringify({ remoteprov: provider('remoteprov') }), { status: 200 })], async (count) => {
      const cat = await source.refresh({ forceRemote: true })
      assert.property(cat, 'remoteprov')
      assert.equal(count(), 1)
    })
  })

  test('a second forced refresh within a minute reuses memory and does not fetch again', async ({ assert }) => {
    const { source } = await setup({ localprov: provider('localprov') }, 10 * 60_000)

    await withFetch([new Response(JSON.stringify({ remoteprov: provider('remoteprov') }), { status: 200 })], async (count) => {
      const first = await source.refresh({ forceRemote: true })
      const second = await source.refresh({ forceRemote: true })
      assert.strictEqual(second, first)
      assert.equal(count(), 1)
    })
  })

  test('a plain refresh without forceRemote reads the local cache without fetching', async ({ assert }) => {
    const { source } = await setup({ localprov: provider('localprov') }, 10 * 60_000)

    await withFetch([], async (count) => {
      const cat = await source.refresh()
      assert.property(cat, 'localprov')
      assert.equal(count(), 0)
    })
  })
})
