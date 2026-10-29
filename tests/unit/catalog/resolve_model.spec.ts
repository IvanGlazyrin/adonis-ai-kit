import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { ModelsDevSource } from '../../../src/catalog/source.js'

const model = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Name ${id}`,
  tool_call: true,
  ...extra,
})

const catalog = {
  acme: {
    id: 'acme',
    name: 'Acme',
    env: [],
    models: {
      'widget-1': model('widget-1', { cost: { input: 1, output: 2 } }),
      'widget-2-20250101': model('widget-2-20250101'),
      'widget-2-20251001': model('widget-2-20251001'),
      gizmo: model('gizmo'),
    },
  },
  other: {
    id: 'other',
    name: 'Other',
    env: [],
    models: { 'widget-1': model('widget-1'), 'thing-9': model('thing-9') },
  },
  'acp-claude-code': {
    id: 'acp-claude-code',
    name: 'ACP',
    env: [],
    models: { ghost: model('ghost') },
  },
}

const sourceWithCatalog = () => {
  const dir = mkdtempSync(join(tmpdir(), 'adonis-ai-resolve-'))
  const overridePath = join(dir, 'override.json')
  writeFileSync(overridePath, JSON.stringify(catalog))
  return new ModelsDevSource({
    overridePath,
    cachePath: join(dir, 'cache.json'),
    systemProviders: { fallback: false, acp: false },
  })
}

test.group('ModelsDevSource.resolveModel', () => {
  test('provider/model syntax is taken as written and carries the catalog entry', async ({ assert }) => {
    const r = await sourceWithCatalog().resolveModel('acme/widget-1')

    assert.equal(r.providerId, 'acme')
    assert.equal(r.modelId, 'widget-1')
    assert.equal(r.entry?.name, 'Name widget-1')
    assert.equal(r.entry?.providerId, 'acme')
  })

  test('provider/model for an unknown provider reports no entry', async ({ assert }) => {
    const r = await sourceWithCatalog().resolveModel('nowhere/widget-1')

    assert.equal(r.providerId, 'nowhere')
    assert.equal(r.modelId, 'widget-1')
    assert.isUndefined(r.entry)
  })

  test('the default provider wins when it has the model', async ({ assert }) => {
    const r = await sourceWithCatalog().resolveModel('widget-1', 'other')
    assert.equal(r.providerId, 'other')
  })

  test('when the default provider lacks the model, the search continues across providers', async ({ assert }) => {
    const r = await sourceWithCatalog().resolveModel('gizmo', 'other')
    assert.equal(r.providerId, 'acme')
    assert.equal(r.modelId, 'gizmo')
  })

  test('an exact id is found in the first provider that has it', async ({ assert }) => {
    const r = await sourceWithCatalog().resolveModel('thing-9')
    assert.equal(r.providerId, 'other')
  })

  test('an undated alias resolves to the newest dated model that extends it', async ({ assert }) => {
    const r = await sourceWithCatalog().resolveModel('widget-2')

    assert.equal(r.providerId, 'acme')
    assert.equal(r.modelId, 'widget-2-20251001')
    assert.equal(r.entry?.id, 'widget-2-20251001')
  })

  test('ACP providers are never matched by a bare model id', async ({ assert }) => {
    const r = await sourceWithCatalog().resolveModel('ghost')

    assert.equal(r.providerId, 'openai')
    assert.equal(r.modelId, 'ghost')
    assert.isUndefined(r.entry)
  })

  test('an unknown model falls back to the default provider, or openai', async ({ assert }) => {
    const source = sourceWithCatalog()

    const withDefault = await source.resolveModel('mystery', 'acme')
    assert.equal(withDefault.providerId, 'acme')
    assert.equal(withDefault.modelId, 'mystery')

    const bare = await source.resolveModel('mystery')
    assert.equal(bare.providerId, 'openai')
    assert.equal(bare.modelId, 'mystery')
  })
})
