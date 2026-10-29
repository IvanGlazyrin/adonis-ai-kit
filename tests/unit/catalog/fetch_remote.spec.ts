import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { ModelsDevSource } from '../../../src/catalog/source.js'

const remoteBody = {
  remoteprov: {
    id: 'remoteprov',
    name: 'Remote',
    env: [],
    models: { m1: { id: 'm1', name: 'M1', tool_call: true } },
  },
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** Serves `responses` in order and records the request init of every fetch call. */
async function withFetch(responses: Response[], run: (calls: RequestInit[]) => Promise<void>) {
  const original = globalThis.fetch
  const calls: RequestInit[] = []
  globalThis.fetch = async (_url, init) => {
    calls.push(init ?? {})
    const next = responses.shift()
    if (!next) throw new Error('unexpected fetch call')
    return next
  }
  try {
    await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

const sourceIn = (dir: string) =>
  new ModelsDevSource({
    cachePath: join(dir, 'cache.json'),
    systemProviders: { fallback: false, acp: false },
  })

/** Makes the cache file look older than the 120 s freshness window, so refresh goes to the network. */
const ageCache = async (cachePath: string) => {
  const old = new Date(Date.now() - 10 * 60_000)
  await utimes(cachePath, old, old)
}

test.group('ModelsDevSource remote fetch', () => {
  test('refresh downloads the catalog and caches it with its etag', async ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'adonis-ai-fetch-'))
    const cachePath = join(dir, 'cache.json')

    await withFetch(
      [json(remoteBody, 200, { etag: '"abc"', 'last-modified': 'Mon, 01 Jan 2026 00:00:00 GMT' })],
      async () => {
        const cat = await sourceIn(dir).refresh({ forceRemote: true })
        assert.property(cat, 'remoteprov')
      }
    )

    assert.property(JSON.parse(readFileSync(cachePath, 'utf-8')), 'remoteprov')
    const meta = JSON.parse(readFileSync(`${cachePath}.etag`, 'utf-8'))
    assert.equal(meta.etag, '"abc"')
    assert.equal(meta.lastModified, 'Mon, 01 Jan 2026 00:00:00 GMT')
  })

  test('a saved etag is sent back as If-None-Match on the next fetch', async ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'adonis-ai-fetch-'))
    const cachePath = join(dir, 'cache.json')
    writeFileSync(cachePath, JSON.stringify(remoteBody))
    writeFileSync(`${cachePath}.etag`, JSON.stringify({ etag: '"saved"', lastModified: null }))
    await ageCache(cachePath)

    await withFetch([json(remoteBody, 200)], async (calls) => {
      await sourceIn(dir).refresh({ forceRemote: true })
      const headers = calls[0]?.headers as Record<string, string>
      assert.equal(headers['If-None-Match'], '"saved"')
    })
  })

  test('304 Not Modified returns the cached catalog without retrying', async ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'adonis-ai-fetch-'))
    const cachePath = join(dir, 'cache.json')
    writeFileSync(cachePath, JSON.stringify(remoteBody))
    writeFileSync(`${cachePath}.etag`, JSON.stringify({ etag: '"saved"', lastModified: null }))
    await ageCache(cachePath)

    await withFetch([new Response(null, { status: 304 })], async (calls) => {
      const cat = await sourceIn(dir).refresh({ forceRemote: true })
      assert.property(cat, 'remoteprov')
      assert.lengthOf(calls, 1)
    })
  })

  test('304 with no cache file is a failed attempt, retried once, then gives up', async ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'adonis-ai-fetch-'))

    await withFetch([new Response(null, { status: 304 }), new Response(null, { status: 304 })], async (calls) => {
      const cat = await sourceIn(dir).refresh({ forceRemote: true })
      assert.notProperty(cat, 'remoteprov')
      assert.lengthOf(calls, 2)
    })
  })

  test('a server error is retried once and a later success is used', async ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'adonis-ai-fetch-'))

    await withFetch([new Response('boom', { status: 500 }), json(remoteBody)], async (calls) => {
      const cat = await sourceIn(dir).refresh({ forceRemote: true })
      assert.property(cat, 'remoteprov')
      assert.lengthOf(calls, 2)
    })
  })

  test('a payload with no usable providers counts as a failed attempt', async ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'adonis-ai-fetch-'))

    await withFetch([json({ nothing: 'here' }), json(remoteBody)], async (calls) => {
      const cat = await sourceIn(dir).refresh({ forceRemote: true })
      assert.property(cat, 'remoteprov')
      assert.lengthOf(calls, 2)
    })
  })

  test('two failed attempts give up without throwing', async ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'adonis-ai-fetch-'))

    await withFetch([new Response('boom', { status: 500 }), new Response('boom', { status: 503 })], async (calls) => {
      const cat = await sourceIn(dir).refresh({ forceRemote: true })
      assert.notProperty(cat, 'remoteprov')
      assert.lengthOf(calls, 2)
    })
  })
})
