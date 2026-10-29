import { buildAcpRuntimeConfig } from '../acp/acp_agents.js'
import type { AcpRuntimeOptions } from '../acp/types.js'
import type { ModelsDevCatalog } from '../catalog/models_dev.js'
import { parseModelRef } from './model_ref.js'
import { resolveProviderNpm } from './protocols.js'
import type { ResolvedModel } from './types.js'

export interface ModelResolver {
  resolve(ref?: string): Promise<ResolvedModel>
}

export interface CatalogModelResolverOptions {
  catalog: { load(): Promise<ModelsDevCatalog> }
  /** Model reference used when `resolve()` is called without one. */
  defaultModelRef?: () => string | undefined
  /** Provider to use for refs that are not provider-prefixed. */
  explicitProvider?: () => string | undefined
  /** Default: the first non-empty `process.env[name]`. */
  getApiKey?: (envNames: string[]) => string | undefined
  acp?: AcpRuntimeOptions
}

const ACP_NPM = '@mcpc-tech/acp-ai-provider'

function firstEnvValue(envNames: string[]): string | undefined {
  for (const name of envNames) {
    const value = process.env[name]
    if (value) return value
  }
  return undefined
}

export class CatalogModelResolver implements ModelResolver {
  constructor(private readonly options: CatalogModelResolverOptions) {}

  async resolve(ref?: string): Promise<ResolvedModel> {
    const { options } = this
    const catalog = await options.catalog.load()
    const resolved = ref || options.defaultModelRef?.()
    const explicitProvider = options.explicitProvider?.()

    const picked = resolved
      ? providerModelFromRef(catalog, resolved, explicitProvider)
      : providerModelByDefault(catalog, explicitProvider)
    const { providerID } = picked
    const provider = catalog[providerID]
    const modelID = modelIdFor(provider, picked.modelID, resolved)

    const npm = resolveProviderNpm({ npmPackage: provider.npm, protocol: provider.protocol })
    const apiKey = (options.getApiKey ?? firstEnvValue)(provider.env ?? [])
    if (provider.protocol === 'acp') {
      const acp = this.acpModel(providerID, provider, modelID, npm)
      if (acp) return acp
    }

    const modelInfo = provider.models[modelID]
    return {
      providerID,
      modelID,
      apiUrl: provider.api,
      npm,
      apiKey,
      headers: modelInfo?.headers,
    }
  }

  /** An ACP model runs the built-in agent it names; `null` when no runtime can be built for it. */
  private acpModel(
    providerID: string,
    provider: ModelsDevCatalog[string],
    modelID: string,
    npm: string | undefined
  ): ResolvedModel | null {
    const agentId = modelID || Object.keys(provider.models)[0]
    const acpConfig = buildAcpRuntimeConfig(agentId, this.options.acp)
    if (!acpConfig) return null
    return { providerID, modelID: agentId, npm: npm || ACP_NPM, acpAgentId: agentId, acpConfig }
  }
}

/** A bare reference may name a model id exactly when the parsed id is not one of the provider's models. */
function modelIdFor(provider: ModelsDevCatalog[string], parsedModelId: string, resolved: string | undefined): string {
  if (!provider.models[parsedModelId] && resolved && provider.models[resolved]) return resolved
  return parsedModelId
}

/** The provider and model named by a reference (explicit provider or `provider/model`). */
function providerModelFromRef(
  catalog: ModelsDevCatalog,
  resolved: string,
  explicitProvider: string | undefined
): { providerID: string; modelID: string } {
  const parsed = parseModelRef({
    modelRef: resolved,
    explicitProvider,
    knownProviderIds: Object.keys(catalog),
  })
  if (!catalog[parsed.providerId]) throw new Error(`Unknown provider: ${parsed.providerId}`)
  return { providerID: parsed.providerId, modelID: parsed.modelId }
}

/** No reference: the explicit provider's first model. */
function providerModelByDefault(
  catalog: ModelsDevCatalog,
  explicitProvider: string | undefined
): { providerID: string; modelID: string } {
  const providerID = explicitProvider || ''
  if (!catalog[providerID]) throw new Error('A model or provider is required')
  return { providerID, modelID: Object.keys(catalog[providerID].models)[0] }
}
