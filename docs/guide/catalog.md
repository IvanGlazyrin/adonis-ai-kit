# Live Catalog (models.dev) {#live-catalog-models-dev}

`adonis-ai-kit` integrates with **models.dev** to keep an up-to-date catalog of models, their limits, and token pricing.

---

## Automatic Discovery & Sync

- **Disk Cache with Atomic Writes:** The catalog is cached in memory and on disk (`catalog.cachePath`), written atomically so a partial file never replaces a good one.
- **TTL Refresh:** A cached catalog stays fresh for `catalog.ttlMs` (default 24 hours), then it is refreshed.
- **Offline Fallback:** If the network fails, a stale cache is used, else a built-in fallback catalog.
- **Auto Pricing:** With `catalog.autoPricing` (default `true`), catalog prices feed the cost tracker.

```ts
// config/ai.ts
catalog: {
  preferCache: true,   // default
  ttlMs: 6 * 60 * 60 * 1000,
  overridePath: './config/models.override.json',
  systemProviders: { fallback: true, acp: true }, // inject built-in providers and ACP agents
}
```

---

## Resolving Models

`ai.resolveModel()` resolves a model reference against the catalog:

```ts
const { providerId, modelId, entry } = await ai.resolveModel('openai/gpt-6-sol')
```

A bare model id is looked up with the default provider. For string entries of `models` chains, set `config.resolver` to a `CatalogModelResolver`. `ai.getCatalog()` returns the underlying `ModelsDevSource`.
