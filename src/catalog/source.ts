import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_MODEL_PRICING } from '../budget/pricing.js'
import type { ModelPricing } from '../budget/types.js'
import type { Logger } from '../logger.js'
import { getAllAcpProviderEntries } from '../acp/acp_agents.js'
import type {
  ModelCatalogEntry,
  ModelsDevCatalog,
  ModelsDevModel,
  ModelsDevModelCost,
  ModelsDevProvider,
} from './models_dev.js'

export interface ModelsDevLoadOptions {
  preferCache?: boolean
  cachePath?: string
  overridePath?: string
}

export interface ModelsDevRefreshOptions {
  forceRemote?: boolean
  cachePath?: string
  overridePath?: string
}

interface ModelsDevSourceDescriptor {
  key: string
  cachePath: string
  overridePath?: string
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
/** Built-in fallback data is retried quickly instead of being pinned in memory forever. */
const FALLBACK_TTL_MS = 60_000
const MODELS_DEV_URL = 'https://models.dev/api.json'

/** Maps config driver / provider names to models.dev provider ids. */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  gemini: 'google',
  'google-gemini': 'google',
  'google-generative-ai': 'google',
  claude: 'anthropic',
  'openai-compatible': 'openai',
})

/**
 * Resolves a provider/driver name (e.g. config driver `gemini`) to the models.dev provider id
 * (`google`). Unknown names are returned unchanged.
 */
export function resolveCatalogProviderId(providerId: string): string {
  return Object.hasOwn(PROVIDER_ALIASES, providerId) ? PROVIDER_ALIASES[providerId] : providerId
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Keeps only providers that look like models.dev providers (`{ models: { ... } }`).
 * Returns `null` when nothing usable remains.
 */
function sanitizeCatalog(json: unknown): ModelsDevCatalog | null {
  if (!isPlainObject(json)) return null
  const catalog: ModelsDevCatalog = {}
  for (const [id, provider] of Object.entries(json)) {
    if (isPlainObject(provider) && isPlainObject(provider.models)) {
      catalog[id] = sanitizeProvider(id, provider, provider.models)
    }
  }
  return Object.keys(catalog).length > 0 ? catalog : null
}

/** One provider with its models keyed by id; missing ids and names fall back to the catalog key. */
function sanitizeProvider(
  id: string,
  provider: Record<string, unknown>,
  rawModels: Record<string, unknown>
): ModelsDevProvider {
  const models: Record<string, ModelsDevModel> = {}
  for (const [modelId, model] of Object.entries(rawModels)) {
    if (isPlainObject(model)) {
      models[modelId] = { ...model, id: typeof model.id === 'string' ? model.id : modelId } as ModelsDevModel
    }
  }
  return {
    ...provider,
    id: typeof provider.id === 'string' ? provider.id : id,
    name: typeof provider.name === 'string' ? provider.name : id,
    env: Array.isArray(provider.env) ? (provider.env as string[]) : [],
    models,
  } as ModelsDevProvider
}

/**
 * Which system providers to inject. The current `systemProviders` object wins; the deprecated
 * `injectSystemProviders` flag applies to both kinds when it is the only setting.
 */
function systemProviderInjection(options: { systemProviders?: { fallback?: boolean; acp?: boolean }; injectSystemProviders?: boolean } | undefined): {
  fallback: boolean
  acp: boolean
} {
  const system = options?.systemProviders
  const legacy = options?.injectSystemProviders ?? true
  if (!system) return { fallback: legacy, acp: legacy }
  return { fallback: system.fallback ?? true, acp: system.acp ?? true }
}

/** The value when it is a positive number, otherwise the default. */
function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && value > 0 ? value : fallback
}

interface CacheValidators {
  etag: string | null
  lastModified: string | null
}

/** Conditional request headers for the validators we have; `undefined` when there are none. */
function conditionalHeaders({ etag, lastModified }: CacheValidators): Record<string, string> | undefined {
  const headers: Record<string, string> = {}
  if (etag) headers['If-None-Match'] = etag
  if (lastModified) headers['If-Modified-Since'] = lastModified
  return Object.keys(headers).length ? headers : undefined
}

function toCatalogCost(pricing: ModelPricing): ModelsDevModelCost {
  return {
    input: pricing.input,
    output: pricing.output,
    cache_read: pricing.cacheReadCostPer1M,
    cache_write: pricing.cacheWriteCostPer1M,
  }
}

/** Fallback catalog prices come from token-budget's table so the two can never drift apart. */
function costOf(model: string): ModelsDevModelCost | undefined {
  const pricing = Object.hasOwn(DEFAULT_MODEL_PRICING, model) ? DEFAULT_MODEL_PRICING[model] : undefined
  return pricing ? toCatalogCost(pricing) : undefined
}

export class ModelsDevSource {
  #cache: ModelsDevCatalog | null = null
  #cacheKey: string | null = null
  #cacheAt: number | null = null
  #cacheIsFallback = false
  #inFlight: Promise<ModelsDevCatalog> | null = null
  #inFlightKey: string | null = null
  #logger?: Logger
  #customCachePath?: string
  #customOverridePath?: string
  #ttlMs: number
  #fallback: ModelsDevCatalog | null = null
  #injectFallback: boolean
  #injectAcp: boolean

  constructor(options?: {
    logger?: Logger
    cachePath?: string
    overridePath?: string
    ttlMs?: number
    /**
     * @deprecated Use `systemProviders`. `false` is equivalent to
     * `systemProviders: { fallback: false, acp: false }`; an explicit
     * `systemProviders` takes precedence.
     */
    injectSystemProviders?: boolean
    /**
     * Which system providers to inject into the catalog when they are missing:
     * the built-in `fallback` providers (openai / anthropic / google) and the
     * `acp` agents (`acp-<id>`). Both default to `true`.
     */
    systemProviders?: { fallback?: boolean; acp?: boolean }
  }) {
    this.#logger = options?.logger
    this.#customCachePath = options?.cachePath
    this.#customOverridePath = options?.overridePath
    const injection = systemProviderInjection(options)
    this.#injectFallback = injection.fallback
    this.#injectAcp = injection.acp
    this.#ttlMs = positiveOr(options?.ttlMs, DEFAULT_TTL_MS)
  }

  setLogger(logger: Logger): void {
    this.#logger = logger
  }

  async load(options: ModelsDevLoadOptions = {}): Promise<ModelsDevCatalog> {
    const preferCache = options.preferCache ?? true
    const source = await this.#getSource(options)

    if (preferCache && this.#isMemoryFresh(source.key)) {
      this.#logger?.debug?.(`[ModelsDevSource] returning cached models for ${source.key}`)
      return this.#cache!
    }

    if (this.#inFlight && this.#inFlightKey === source.key) {
      this.#logger?.debug?.(`[ModelsDevSource] waiting for in-flight load of ${source.key}`)
      return this.#inFlight
    }

    return this.#loadSource(source, { forceRemote: false })
  }

  async refresh(options: ModelsDevRefreshOptions = {}): Promise<ModelsDevCatalog> {
    const source = await this.#getSource(options)

    if (this.#inFlight && this.#inFlightKey === source.key) {
      this.#logger?.debug?.(`[ModelsDevSource] deduplicating refresh for ${source.key}`)
      return this.#inFlight
    }

    const forceRemote = options.forceRemote ?? false
    if (forceRemote) {
      const fresh = this.#freshFromMemory(source) ?? (await this.#freshFromFile(source))
      if (fresh) return fresh
    }

    return this.#loadSource(source, { forceRemote })
  }

  /** The in-memory catalog when a real (non-fallback) one was loaded less than a minute ago. */
  #freshFromMemory(source: ModelsDevSourceDescriptor): ModelsDevCatalog | undefined {
    if (!this.#cache || this.#cacheKey !== source.key || !this.#cacheAt) return undefined
    const ageMs = Date.now() - this.#cacheAt
    if (this.#cacheIsFallback || ageMs >= 60_000) return undefined

    this.#logger?.info?.(
      `[ModelsDevSource] refresh skipped — in-memory cache is fresh (${Math.round(ageMs / 1000)}s)`
    )
    return this.#cache
  }

  /** The local file when it is under two minutes old. Skipped when an override file is in use. */
  async #freshFromFile(source: ModelsDevSourceDescriptor): Promise<ModelsDevCatalog | undefined> {
    if (source.overridePath) return undefined
    try {
      const fileStat = await stat(source.cachePath)
      const fileAgeMs = Date.now() - fileStat.mtimeMs
      if (fileAgeMs >= 120_000) return undefined

      const local = await this.#readLocalCache(source.cachePath)
      if (!local) return undefined
      this.#logger?.info?.(
        `[ModelsDevSource] refresh: file fresh (${Math.round(fileAgeMs / 1000)}s), using local cache`
      )
      this.#store(source.key, this.#injectSystemProviders(local), false)
      return this.#cache!
    } catch {
      // file doesn't exist or stat failed, fall through to fetch
      return undefined
    }
  }

  resetCache(): void {
    this.#cache = null
    this.#cacheKey = null
    this.#cacheAt = null
    this.#cacheIsFallback = false
    this.#inFlight = null
    this.#inFlightKey = null
  }

  async getProvider(providerId: string): Promise<ModelsDevProvider | undefined> {
    const catalog = await this.load()
    return this.#provider(catalog, providerId)
  }

  async getModel(providerId: string, modelId: string): Promise<ModelCatalogEntry | undefined> {
    const catalog = await this.load()
    const catalogId = resolveCatalogProviderId(providerId)
    const provider = this.#provider(catalog, catalogId)
    if (!provider) return undefined

    const raw = Object.hasOwn(provider.models ?? {}, modelId) ? provider.models[modelId] : undefined
    if (!raw) return undefined

    return this.#normalizeModel(catalogId, provider.name, raw)
  }

  async getContextLimit(providerId: string, modelId: string): Promise<number | undefined> {
    const model = await this.getModel(providerId, modelId)
    return model?.contextLimit
  }

  async supportsToolCall(providerId: string, modelId: string): Promise<boolean> {
    const model = await this.getModel(providerId, modelId)
    return model?.toolCall ?? false
  }

  async getModelPricing(providerId: string, modelId: string): Promise<ModelPricing | undefined> {
    const model = await this.getModel(providerId, modelId)
    return model?.pricing
  }

  async listProviders(): Promise<ModelsDevProvider[]> {
    const catalog = await this.load()
    return Object.values(catalog)
  }

  async listModels(providerId?: string): Promise<ModelCatalogEntry[]> {
    const catalog = await this.load()
    const wanted = providerId ? resolveCatalogProviderId(providerId) : undefined
    const entries: ModelCatalogEntry[] = []

    for (const [pId, provider] of Object.entries(catalog)) {
      if (wanted && pId !== wanted) continue
      for (const raw of Object.values(provider.models ?? {})) {
        entries.push(this.#normalizeModel(pId, provider.name, raw))
      }
    }

    return entries
  }

  /**
   * Dynamically resolves a model reference string (e.g. 'openai/gpt-4o', 'claude-3-5-sonnet', 'gpt-4o')
   * into a matched provider ID, model ID, and catalog entry.
   *
   * Besides exact ids, an undated alias resolves to the newest dated model that extends it
   * (`claude-3-5-sonnet` -> `claude-3-5-sonnet-20241022`).
   */
  async resolveModel(
    modelRef: string,
    defaultProvider?: string
  ): Promise<{ providerId: string; modelId: string; entry?: ModelCatalogEntry }> {
    // 1. Explicit syntax: "providerId/modelId"
    if (modelRef.includes('/')) {
      const [pId, ...rest] = modelRef.split('/')
      const mId = rest.join('/')
      const catalogId = resolveCatalogProviderId(pId)
      const entry = await this.getModel(catalogId, mId)
      return { providerId: catalogId, modelId: mId, entry }
    }

    const catalog = await this.load()
    // 2. The default provider, when one is given and has the model
    const defaultId = defaultProvider ? resolveCatalogProviderId(defaultProvider) : undefined
    const hit =
      (defaultId ? this.#findInProvider(catalog, defaultId, modelRef) : undefined) ??
      // 3. Otherwise search every non-ACP provider: exact id first, then dated alias
      this.#findAcrossProviders(catalog, modelRef)
    if (hit) return this.#withEntry(catalog, hit)

    // 4. Fallback: return defaultProvider or 'openai' with modelRef
    return { providerId: defaultId ?? 'openai', modelId: modelRef }
  }

  /** Exact id, or the newest dated model that extends `modelRef`, within one provider. */
  #findInProvider(
    catalog: ModelsDevCatalog,
    providerId: string,
    modelRef: string
  ): { providerId: string; modelId: string } | undefined {
    const models = this.#provider(catalog, providerId)?.models ?? {}
    if (Object.hasOwn(models, modelRef)) return { providerId, modelId: modelRef }
    const alias = Object.keys(models)
      .filter((id) => id.startsWith(`${modelRef}-`))
      .sort()
      .pop()
    return alias ? { providerId, modelId: alias } : undefined
  }

  #findAcrossProviders(
    catalog: ModelsDevCatalog,
    modelRef: string
  ): { providerId: string; modelId: string } | undefined {
    const searchable = Object.keys(catalog).filter((id) => !id.startsWith('acp-'))
    const exact = searchable.find((pId) =>
      Object.hasOwn(this.#provider(catalog, pId)?.models ?? {}, modelRef)
    )
    if (exact) return { providerId: exact, modelId: modelRef }

    for (const pId of searchable) {
      const hit = this.#findInProvider(catalog, pId, modelRef)
      if (hit) return hit
    }
    return undefined
  }

  #withEntry(
    catalog: ModelsDevCatalog,
    hit: { providerId: string; modelId: string }
  ): { providerId: string; modelId: string; entry: ModelCatalogEntry } {
    const provider = this.#provider(catalog, hit.providerId)!
    return {
      ...hit,
      entry: this.#normalizeModel(hit.providerId, provider.name, provider.models[hit.modelId]),
    }
  }

  #provider(catalog: ModelsDevCatalog, providerId: string): ModelsDevProvider | undefined {
    return Object.hasOwn(catalog, providerId) ? catalog[providerId] : undefined
  }

  #isMemoryFresh(key: string): boolean {
    if (!this.#cache || this.#cacheKey !== key || this.#cacheAt === null) return false
    const ttl = this.#cacheIsFallback ? FALLBACK_TTL_MS : this.#ttlMs
    return Date.now() - this.#cacheAt < ttl
  }

  #store(key: string, catalog: ModelsDevCatalog, isFallback: boolean): void {
    this.#cache = catalog
    this.#cacheKey = key
    this.#cacheAt = Date.now()
    this.#cacheIsFallback = isFallback
  }

  /**
   * Fields models.dev does not provide are reported as "unknown" (`false` / `0`), never guessed.
   */
  #normalizeModel(providerId: string, providerName: string, raw: ModelsDevModel): ModelCatalogEntry {
    const pricing: ModelPricing | undefined = raw.cost
      ? {
          input: raw.cost.input ?? 0,
          output: raw.cost.output ?? 0,
          cacheReadCostPer1M: raw.cost.cache_read,
          cacheWriteCostPer1M: raw.cost.cache_write,
          reasoningCostPer1M: raw.cost.reasoning,
        }
      : undefined

    return {
      id: raw.id,
      name: raw.name ?? raw.id,
      providerId,
      providerName,
      contextLimit: raw.limit?.context ?? 0,
      outputLimit: raw.limit?.output ?? 0,
      toolCall: raw.tool_call ?? false,
      structuredOutput: raw.structured_output ?? false,
      pricing,
      description: raw.description,
      headers: raw.headers,
      rawModel: raw,
    }
  }

  async #getSource(options: ModelsDevLoadOptions): Promise<ModelsDevSourceDescriptor> {
    const overridePath =
      options.overridePath ?? this.#customOverridePath ?? process.env.MODELS_DEV_PATH
    if (overridePath) {
      const absolutePath = path.resolve(overridePath)
      return { key: `override:${absolutePath}`, cachePath: absolutePath, overridePath: absolutePath }
    }

    const cacheOverride =
      options.cachePath ?? this.#customCachePath ?? process.env.MODELS_DEV_CACHE_PATH
    if (cacheOverride) {
      const absolutePath = path.resolve(cacheOverride)
      return { key: `cache:${absolutePath}`, cachePath: absolutePath }
    }

    const defaultPath = await this.#defaultCachePath()
    return { key: `default:${defaultPath}`, cachePath: defaultPath }
  }

  /** The models.dev file under the app's storage folder, or under the working directory outside an app. */
  async #defaultCachePath(): Promise<string> {
    try {
      const { default: app } = await import('@adonisjs/core/services/app')
      return app.makePath('storage', 'models', 'models.dev.json')
    } catch {
      return path.resolve(process.cwd(), 'storage', 'models', 'models.dev.json')
    }
  }

  #loadSource(
    source: ModelsDevSourceDescriptor,
    options: { forceRemote: boolean }
  ): Promise<ModelsDevCatalog> {
    const promise = this.#readSource(source, options).then(({ catalog, isFallback }) => {
      this.#store(source.key, catalog, isFallback)
      return catalog
    })

    this.#inFlight = promise
    this.#inFlightKey = source.key

    return promise.finally(() => {
      if (this.#inFlight === promise) {
        this.#inFlight = null
        this.#inFlightKey = null
      }
    })
  }

  async #readSource(
    source: ModelsDevSourceDescriptor,
    options: { forceRemote: boolean }
  ): Promise<{ catalog: ModelsDevCatalog; isFallback: boolean }> {
    const override = await this.#readOverride(source)
    if (override) return { catalog: override, isFallback: false }

    // 1. A fresh disk cache wins (unless a remote refresh is forced)
    const local = await this.#readLocalCacheWithAge(source.cachePath)
    if (local && !options.forceRemote && local.ageMs < this.#ttlMs) {
      return { catalog: this.#injectSystemProviders(local.data), isFallback: false }
    }

    // 2. Otherwise (missing / expired / forced) ask models.dev
    const remote = await this.#fetchRemote(source.cachePath)
    if (remote) {
      return { catalog: this.#injectSystemProviders(remote), isFallback: false }
    }

    return this.#withoutNetwork(local)
  }

  /** The override file's catalog, or `null` when it is absent, unreadable, or has no valid providers. */
  async #readOverride(source: ModelsDevSourceDescriptor): Promise<ModelsDevCatalog | null> {
    if (!source.overridePath) return null
    this.#logger?.info?.(`[ModelsDevSource] loading from override: ${source.overridePath}`)
    try {
      const data = sanitizeCatalog(JSON.parse(await readFile(source.overridePath, 'utf-8')))
      if (data) return this.#injectSystemProviders(data)
      this.#logger?.warn?.('[ModelsDevSource] override file has no valid providers')
    } catch (err) {
      this.#logger?.warn?.(
        `[ModelsDevSource] failed to parse override file: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    return null
  }

  /** Network failed: a stale cache is better than the built-in fallback catalog. */
  #withoutNetwork(local: { data: ModelsDevCatalog; ageMs: number } | null): {
    catalog: ModelsDevCatalog
    isFallback: boolean
  } {
    if (local) {
      this.#logger?.warn?.(
        `[ModelsDevSource] refresh failed, using stale cache (${Math.round(local.ageMs / 3_600_000)}h old)`
      )
      return { catalog: this.#injectSystemProviders(local.data), isFallback: false }
    }
    return { catalog: this.#injectSystemProviders(this.#getFallbackModels()), isFallback: true }
  }

  async #readLocalCache(cachePath: string): Promise<ModelsDevCatalog | null> {
    return (await this.#readLocalCacheWithAge(cachePath))?.data ?? null
  }

  async #readLocalCacheWithAge(
    cachePath: string
  ): Promise<{ data: ModelsDevCatalog; ageMs: number } | null> {
    try {
      const [content, fileStat] = await Promise.all([readFile(cachePath, 'utf-8'), stat(cachePath)])
      const data = sanitizeCatalog(JSON.parse(content))
      if (!data) {
        this.#logger?.warn?.(`[ModelsDevSource] cache at ${cachePath} contains no valid providers`)
        return null
      }
      return { data, ageMs: Math.max(0, Date.now() - fileStat.mtimeMs) }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        const msg = err instanceof Error ? err.message : String(err)
        this.#logger?.warn?.(`[ModelsDevSource] cache read error at ${cachePath}: ${msg}`)
      }
      return null
    }
  }

  /** Writes via a temp file + rename so concurrent readers never see a half-written file. */
  async #writeAtomic(filePath: string, content: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true })
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
    try {
      await writeFile(tmpPath, content)
      await rename(tmpPath, filePath)
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {})
      throw err
    }
  }

  /** Two attempts; a failed attempt is logged and retried after a short backoff. */
  async #fetchRemote(cachePath: string): Promise<ModelsDevCatalog | null> {
    this.#logger?.info?.('[ModelsDevSource] fetching catalog from models.dev...')

    const etagPath = `${cachePath}.etag`
    const validators = await this.#readValidators(etagPath)

    let lastError: Error | undefined
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await this.#fetchAttempt(cachePath, etagPath, validators)
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        this.#logger?.warn?.(`[ModelsDevSource] fetch attempt ${attempt} failed: ${lastError.message}`)
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 300 * attempt))
        }
      }
    }

    this.#logger?.warn?.(`[ModelsDevSource] all network attempts failed. Error: ${lastError?.message}`)
    return null
  }

  /** One request. Throws on any failure, including a 304 with no local copy to serve. */
  async #fetchAttempt(
    cachePath: string,
    etagPath: string,
    validators: CacheValidators
  ): Promise<ModelsDevCatalog> {
    const response = await fetch(MODELS_DEV_URL, {
      signal: AbortSignal.timeout(6_000),
      headers: conditionalHeaders(validators),
    })

    if (response.status === 304) return this.#useNotModified(cachePath)

    if (!response.ok) {
      throw new Error(`Failed to fetch models.dev: ${response.status} ${response.statusText}`)
    }

    const data = sanitizeCatalog(await response.json())
    if (!data) {
      throw new Error('Invalid models.dev response: no valid providers')
    }

    await this.#writeAtomic(cachePath, JSON.stringify(data))
    await this.#saveValidators(etagPath, response)

    this.#logger?.info?.(`[ModelsDevSource] successfully updated catalog at ${cachePath}`)
    return data
  }

  async #readValidators(etagPath: string): Promise<CacheValidators> {
    try {
      const meta = JSON.parse(await readFile(etagPath, 'utf-8'))
      return {
        etag: typeof meta.etag === 'string' ? meta.etag : null,
        lastModified: typeof meta.lastModified === 'string' ? meta.lastModified : null,
      }
    } catch {
      return { etag: null, lastModified: null } // no previous metadata
    }
  }

  async #saveValidators(etagPath: string, response: Response): Promise<void> {
    const etag = response.headers.get('etag')
    const lastModified = response.headers.get('last-modified')
    if (etag || lastModified) {
      await this.#writeAtomic(etagPath, JSON.stringify({ etag, lastModified })).catch(() => {})
    }
  }

  async #useNotModified(cachePath: string): Promise<ModelsDevCatalog> {
    this.#logger?.info?.('[ModelsDevSource] 304 Not Modified — using local cache')
    const cached = await this.#readLocalCache(cachePath)
    if (!cached) throw new Error('Received 304 but local cache file was missing')
    // Restart the TTL clock of the unchanged file
    const now = new Date()
    await utimes(cachePath, now, now).catch(() => {})
    return cached
  }

  #injectSystemProviders(catalog: ModelsDevCatalog): ModelsDevCatalog {
    if (!this.#injectFallback && !this.#injectAcp) return catalog
    const registry: ModelsDevCatalog = { ...catalog }

    // Inject system fallback providers if missing
    if (this.#injectFallback) {
      const fallback = this.#getFallbackModels()
      for (const id of ['openai', 'anthropic', 'google']) {
        if (!Object.hasOwn(registry, id)) registry[id] = fallback[id]
      }
    }

    // ACP agents are exposed under `acp-<id>` providers (never auto-selected as fallbacks)
    for (const entry of this.#injectAcp ? getAllAcpProviderEntries() : []) {
      if (entry && !Object.hasOwn(registry, entry.id)) {
        registry[entry.id] = {
          id: entry.id,
          name: entry.name,
          env: entry.env,
          npm: entry.npm,
          protocol: entry.protocol,
          models: Object.fromEntries(
            Object.entries(entry.models).map(([modelId, model]) => [
              modelId,
              {
                ...model,
                tool_call: true,
                structured_output: true,
                limit: { context: 200_000, output: 8_192 },
              },
            ])
          ),
        }
      }
    }

    return registry
  }

  #getFallbackModels(): ModelsDevCatalog {
    if (this.#fallback) return this.#fallback
    this.#fallback = {
      'openai': {
        id: 'openai',
        name: 'OpenAI',
        env: ['OPENAI_API_KEY'],
        api: 'https://api.openai.com/v1',
        protocol: 'openai',
        npm: '@ai-sdk/openai',
        models: {
          'gpt-6-sol': {
            id: 'gpt-6-sol',
            name: 'GPT-6 Sol',
            tool_call: true,
            structured_output: true,
            reasoning: true,
            limit: { context: 1_050_000, output: 128_000 },
            cost: costOf('gpt-6-sol'),
          },
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            tool_call: true,
            structured_output: true,
            limit: { context: 128_000, output: 16_384 },
            cost: costOf('gpt-4o'),
          },
          'gpt-4o-mini': {
            id: 'gpt-4o-mini',
            name: 'GPT-4o Mini',
            tool_call: true,
            structured_output: true,
            limit: { context: 128_000, output: 16_384 },
            cost: costOf('gpt-4o-mini'),
          },
          'gpt-4.1': {
            id: 'gpt-4.1',
            name: 'GPT-4.1',
            tool_call: true,
            structured_output: true,
            limit: { context: 1_047_576, output: 32_768 },
            cost: costOf('gpt-4.1'),
          },
          'o1': {
            id: 'o1',
            name: 'o1',
            tool_call: true,
            structured_output: true,
            reasoning: true,
            limit: { context: 200_000, output: 100_000 },
            cost: costOf('o1'),
          },
          'o3-mini': {
            id: 'o3-mini',
            name: 'o3-mini',
            tool_call: true,
            structured_output: true,
            reasoning: true,
            limit: { context: 200_000, output: 100_000 },
            cost: costOf('o3-mini'),
          },
        },
      },
      'anthropic': {
        id: 'anthropic',
        name: 'Anthropic',
        env: ['ANTHROPIC_API_KEY'],
        api: 'https://api.anthropic.com/v1',
        protocol: 'anthropic',
        npm: '@ai-sdk/anthropic',
        models: {
          'claude-sonnet-5-5': {
            id: 'claude-sonnet-5-5',
            name: 'Claude Sonnet 5.5',
            tool_call: true,
            structured_output: true,
            reasoning: true,
            limit: { context: 1_000_000, output: 128_000 },
            cost: costOf('claude-sonnet-5-5'),
          },
          'claude-3-7-sonnet-latest': {
            id: 'claude-3-7-sonnet-latest',
            name: 'Claude 3.7 Sonnet',
            tool_call: true,
            structured_output: true,
            reasoning: true,
            limit: { context: 200_000, output: 64_000 },
            cost: costOf('claude-3-7-sonnet'),
          },
          'claude-3-5-sonnet-20241022': {
            id: 'claude-3-5-sonnet-20241022',
            name: 'Claude 3.5 Sonnet',
            tool_call: true,
            structured_output: true,
            limit: { context: 200_000, output: 8_192 },
            cost: costOf('claude-3-5-sonnet'),
          },
          'claude-3-5-haiku-20241022': {
            id: 'claude-3-5-haiku-20241022',
            name: 'Claude 3.5 Haiku',
            tool_call: true,
            structured_output: true,
            limit: { context: 200_000, output: 8_192 },
            cost: costOf('claude-3-5-haiku'),
          },
        },
      },
      'google': {
        id: 'google',
        name: 'Google',
        env: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'],
        api: 'https://generativelanguage.googleapis.com/v1beta',
        protocol: 'google',
        npm: '@ai-sdk/google',
        models: {
          'gemini-3.5-flash': {
            id: 'gemini-3.5-flash',
            name: 'Gemini 3.5 Flash',
            tool_call: true,
            structured_output: true,
            reasoning: true,
            limit: { context: 1_048_576, output: 65_536 },
            cost: costOf('gemini-3.5-flash'),
          },
          'gemini-2.5-flash': {
            id: 'gemini-2.5-flash',
            name: 'Gemini 2.5 Flash',
            tool_call: true,
            structured_output: true,
            reasoning: true,
            limit: { context: 1_048_576, output: 65_536 },
            cost: costOf('gemini-2.5-flash'),
          },
          'gemini-2.5-pro': {
            id: 'gemini-2.5-pro',
            name: 'Gemini 2.5 Pro',
            tool_call: true,
            structured_output: true,
            reasoning: true,
            limit: { context: 1_048_576, output: 65_536 },
            cost: costOf('gemini-2.5-pro'),
          },
          'gemini-2.0-flash': {
            id: 'gemini-2.0-flash',
            name: 'Gemini 2.0 Flash',
            tool_call: true,
            structured_output: true,
            limit: { context: 1_048_576, output: 8_192 },
            cost: costOf('gemini-2.0-flash'),
          },
          'gemini-1.5-pro': {
            id: 'gemini-1.5-pro',
            name: 'Gemini 1.5 Pro',
            tool_call: true,
            structured_output: true,
            limit: { context: 2_000_000, output: 8_192 },
            cost: costOf('gemini-1.5-pro'),
          },
        },
      },
      'groq': {
        id: 'groq',
        name: 'Groq',
        env: ['GROQ_API_KEY'],
        api: 'https://api.groq.com/openai/v1',
        protocol: 'openai',
        npm: '@ai-sdk/groq',
        models: {
          'openai/gpt-oss-120b': {
            id: 'openai/gpt-oss-120b',
            name: 'GPT OSS 120B',
            tool_call: true,
            structured_output: true,
            reasoning: true,
            limit: { context: 131_072, output: 65_536 },
            cost: costOf('gpt-oss-120b'),
          },
          'llama-3.3-70b-versatile': {
            id: 'llama-3.3-70b-versatile',
            name: 'Llama 3.3 70B',
            tool_call: true,
            structured_output: true,
            limit: { context: 128_000, output: 32_768 },
            cost: costOf('llama-3.3-70b-versatile'),
          },
        },
      },
      'ollama': {
        id: 'ollama',
        name: 'Ollama (Local)',
        env: [],
        api: 'http://localhost:11434/v1',
        protocol: 'openai-compatible',
        npm: '@ai-sdk/openai-compatible',
        models: {
          'llama3.2': {
            id: 'llama3.2',
            name: 'Llama 3.2',
            tool_call: true,
            structured_output: true,
            limit: { context: 128_000, output: 8_192 },
          },
        },
      },
    }
    return this.#fallback
  }
}

export const modelsDevSource = new ModelsDevSource()
