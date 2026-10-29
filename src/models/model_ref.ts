export interface ParseModelRefOptions {
  modelRef?: string
  explicitProvider?: string
  knownProviderIds: string[]
}

export interface ParsedModelRef {
  providerId: string
  modelId: string
  wasProviderPrefixed: boolean
}

export function parseModelRef({
  modelRef,
  explicitProvider,
  knownProviderIds,
}: ParseModelRefOptions): ParsedModelRef {
  const ref = modelRef?.trim()
  const provider = explicitProvider?.trim()

  if (provider) {
    if (!knownProviderIds.includes(provider)) {
      throw new Error(`Unknown provider: ${provider}`)
    }
    const underProvider = parseUnderExplicitProvider(provider, ref)
    if (underProvider) return underProvider
  }

  if (!ref) {
    throw new Error('A model reference or an explicit provider is required')
  }
  return parseProviderPrefixed(ref, knownProviderIds)
}

/** A model under the explicit provider, with or without its own `provider/` prefix; `null` when there is no reference. */
function parseUnderExplicitProvider(provider: string, ref: string | undefined): ParsedModelRef | null {
  const providerPrefix = `${provider}/`
  if (ref?.startsWith(providerPrefix)) {
    return { providerId: provider, modelId: ref.slice(providerPrefix.length), wasProviderPrefixed: true }
  }
  if (ref) {
    return { providerId: provider, modelId: ref, wasProviderPrefixed: false }
  }
  return null
}

/** A `provider/model` reference: the first segment must be a known provider, and a model id must follow. */
function parseProviderPrefixed(ref: string, knownProviderIds: string[]): ParsedModelRef {
  const [candidateProvider, ...modelParts] = ref.split('/')
  if (!candidateProvider || !knownProviderIds.includes(candidateProvider)) {
    throw new Error(`Unknown provider: ${candidateProvider || ref}`)
  }

  const modelId = modelParts.join('/')
  if (!modelId) {
    throw new Error(`Model id is required for provider: ${candidateProvider}`)
  }

  return { providerId: candidateProvider, modelId, wasProviderPrefixed: true }
}
