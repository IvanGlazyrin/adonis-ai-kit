import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { ModelsDevSource } from '../../../src/catalog/source.js'

const catalog = {
  acme: {
    id: 'acme',
    name: 'Acme',
    env: [],
    models: {
      one: { id: 'one', name: 'One', tool_call: true },
      two: { id: 'two', name: 'Two', tool_call: false },
    },
  },
  bolt: {
    id: 'bolt',
    name: 'Bolt',
    env: [],
    models: { speed: { id: 'speed', name: 'Speed', tool_call: true } },
  },
  empty: { id: 'empty', name: 'Empty', env: [] },
}

const sourceWithCatalog = () => {
  const dir = mkdtempSync(join(tmpdir(), 'adonis-ai-list-'))
  const overridePath = join(dir, 'override.json')
  writeFileSync(overridePath, JSON.stringify(catalog))
  return new ModelsDevSource({
    overridePath,
    cachePath: join(dir, 'cache.json'),
    systemProviders: { fallback: false, acp: false },
  })
}

test.group('ModelsDevSource.listModels', () => {
  test('without a provider it lists every model of every provider that has models', async ({ assert }) => {
    const entries = await sourceWithCatalog().listModels()

    assert.sameMembers(
      entries.map((e) => `${e.providerId}/${e.id}`),
      ['acme/one', 'acme/two', 'bolt/speed']
    )
  })

  test('with a provider it lists only that provider\'s models, each tagged with it', async ({ assert }) => {
    const entries = await sourceWithCatalog().listModels('acme')

    assert.sameMembers(
      entries.map((e) => e.id),
      ['one', 'two']
    )
    assert.isTrue(entries.every((e) => e.providerId === 'acme' && e.providerName === 'Acme'))
  })

  test('an unknown provider lists nothing, and a provider without models adds nothing', async ({ assert }) => {
    const source = sourceWithCatalog()

    assert.deepEqual(await source.listModels('nowhere'), [])
    assert.deepEqual(
      (await source.listModels()).filter((e) => e.providerId === 'empty'),
      []
    )
  })
})
