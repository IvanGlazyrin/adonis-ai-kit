import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { ModelsDevSource } from '../../../src/catalog/source.js'

const provider = (id: string) => ({ [id]: { id, name: id, env: [], models: { m: { id: 'm', name: 'M' } } } })

/** Every network request fails, so only the file a source names can supply providers. */
async function withFailingFetch(run: () => Promise<void>) {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('down', { status: 500 })
  try {
    await run()
  } finally {
    globalThis.fetch = original
  }
}

const fileWith = (name: string, content: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'adonis-ai-key-'))
  const file = join(dir, name)
  writeFileSync(file, JSON.stringify(content))
  return file
}

const systemOff = { fallback: false, acp: false }

test.group('ModelsDevSource source selection', () => {
  test('an override path in the call is the file read', async ({ assert }) => {
    const override = fileWith('over.json', provider('fromcall'))

    await withFailingFetch(async () => {
      const cat = await new ModelsDevSource({ systemProviders: systemOff }).load({ overridePath: override })
      assert.property(cat, 'fromcall')
    })
  })

  test('the constructor override applies when the call gives none', async ({ assert }) => {
    const override = fileWith('ctor.json', provider('fromctor'))

    await withFailingFetch(async () => {
      const cat = await new ModelsDevSource({ overridePath: override, systemProviders: systemOff }).load()
      assert.property(cat, 'fromctor')
    })
  })

  test('a cache path in the call is read when no override is given', async ({ assert }) => {
    const cache = fileWith('cache.json', provider('fromcache'))

    await withFailingFetch(async () => {
      const cat = await new ModelsDevSource({ systemProviders: systemOff }).load({ cachePath: cache })
      assert.property(cat, 'fromcache')
    })
  })

  test('the cache path from the environment is read when nothing else is given', async ({ assert }) => {
    const cache = fileWith('env.json', provider('fromenv'))
    const saved = process.env.MODELS_DEV_CACHE_PATH
    process.env.MODELS_DEV_CACHE_PATH = cache
    try {
      await withFailingFetch(async () => {
        const cat = await new ModelsDevSource({ systemProviders: systemOff }).load()
        assert.property(cat, 'fromenv')
      })
    } finally {
      if (saved === undefined) delete process.env.MODELS_DEV_CACHE_PATH
      else process.env.MODELS_DEV_CACHE_PATH = saved
    }
  })
})
