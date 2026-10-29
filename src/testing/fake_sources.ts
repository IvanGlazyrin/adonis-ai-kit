import type { LanguageModel } from 'ai'
import type { ModelResolver } from '../models/catalog_resolver.js'
import type { LanguageModelSource, ResolvedModel } from '../models/types.js'
import type { CustomProviderConfig } from '../types.js'

/** A provider config that answers every call with `model`. Use it as `providers.<name>` in `defineConfig`. */
export function fakeProvider(model: LanguageModel): CustomProviderConfig {
  return {
    driver: 'custom',
    factory: () => model,
    defaultModel: typeof model === 'string' ? model : model.modelId,
  }
}

/**
 * A `languageModels` source for `models` chains: each entry is answered from `models`, keyed by
 * `provider/model`. An unregistered entry throws a plain error (not a skip), so a missing registration
 * fails the test instead of falling back silently.
 */
export function fakeLanguageModels(models: Record<string, LanguageModel>): LanguageModelSource {
  return {
    async create(model: ResolvedModel): Promise<LanguageModel> {
      const key = `${model.providerID}/${model.modelID}`
      if (!Object.hasOwn(models, key)) {
        throw new Error(`fakeLanguageModels: no fake model registered for "${key}"`)
      }
      return models[key]
    },
    async shutdown(): Promise<void> {},
  }
}

/**
 * A `resolver` for string entries of a chain. A `provider/model` reference resolves to itself; `overrides`
 * replaces a reference with a full `ResolvedModel` (for example to set `credentialKey`).
 */
export function fakeResolver(overrides: Record<string, ResolvedModel> = {}): ModelResolver {
  return {
    async resolve(ref?: string): Promise<ResolvedModel> {
      if (!ref) throw new Error('fakeResolver: a model reference is required')
      if (Object.hasOwn(overrides, ref)) return overrides[ref]
      const slash = ref.indexOf('/')
      if (slash <= 0) throw new Error(`fakeResolver: "${ref}" is not a provider/model reference`)
      return { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) }
    },
  }
}
