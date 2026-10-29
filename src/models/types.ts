import type { LanguageModel } from 'ai'
import type { AcpAgentRuntimeConfig } from '../acp/types.js'

/**
 * Builds the language model of a `models` chain entry and releases what it holds. `LanguageModelFactory`
 * implements it; `fakeLanguageModels()` from `adonis-ai-kit/testing` implements it for tests.
 */
export interface LanguageModelSource {
  create(model: ResolvedModel): Promise<LanguageModel>
  shutdown(): Promise<void>
}

export interface ResolvedModel {
  providerID: string
  modelID: string
  apiUrl?: string
  npm?: string
  apiKey?: string
  headers?: Record<string, string>
  /**
   * Identity of the credential this model was resolved with, e.g. `key:42`.
   * Used to key circuit breakers per credential; never forwarded to the AI SDK.
   */
  credentialKey?: string
  acpAgentId?: string
  acpConfig?: AcpAgentRuntimeConfig
}
