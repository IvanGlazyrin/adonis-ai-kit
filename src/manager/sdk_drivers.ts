import type { LanguageModel } from 'ai'
import type { AcpProviderConfig } from '../acp/types.js'
import { AiException, ProviderConfigError } from '../errors.js'
import type { ConfirmationService } from '../guard/confirmation.js'
import type { Logger } from '../logger.js'
import type { AiDriver, BaseProviderConfig, ProviderConfig } from '../types.js'

type ModelFactory = (modelId: string) => LanguageModel
type ClientFactory = (settings: Record<string, unknown>) => ModelFactory

/** How one built-in SDK driver loads its package and builds its client. */
export interface SdkDriverSpec {
  /** Name used in the missing-package error. */
  label: string
  pkg: string
  factory: string
  defaultModel: string
  settings: (config: SdkDriverConfig) => Record<string, unknown>
}

type SdkDriverConfig = Pick<BaseProviderConfig, 'baseURL' | 'headers'> & {
  apiKey?: string
  organization?: string
}

const GOOGLE_DRIVER: SdkDriverSpec = {
  label: 'Google/Gemini',
  pkg: '@ai-sdk/google',
  factory: 'createGoogleGenerativeAI',
  defaultModel: 'gemini-3.5-flash',
  settings: (c) => ({
    apiKey: c.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY,
    baseURL: c.baseURL,
    headers: c.headers,
  }),
}

/** Built-in SDK drivers, keyed by the `driver` value in provider config. */
export const SDK_DRIVERS: Record<string, SdkDriverSpec> = {
  openai: {
    label: 'OpenAI',
    pkg: '@ai-sdk/openai',
    factory: 'createOpenAI',
    defaultModel: 'gpt-6-sol',
    settings: (c) => ({
      apiKey: c.apiKey ?? process.env.OPENAI_API_KEY,
      organization: c.organization ?? process.env.OPENAI_ORG_ID,
      baseURL: c.baseURL ?? process.env.OPENAI_BASE_URL,
      headers: c.headers,
    }),
  },
  anthropic: {
    label: 'Anthropic',
    pkg: '@ai-sdk/anthropic',
    factory: 'createAnthropic',
    defaultModel: 'claude-sonnet-5-5',
    settings: (c) => ({
      apiKey: c.apiKey ?? process.env.ANTHROPIC_API_KEY,
      baseURL: c.baseURL ?? process.env.ANTHROPIC_BASE_URL,
      headers: c.headers,
    }),
  },
  google: GOOGLE_DRIVER,
  gemini: GOOGLE_DRIVER,
  groq: {
    label: 'Groq',
    pkg: '@ai-sdk/groq',
    factory: 'createGroq',
    defaultModel: 'openai/gpt-oss-120b',
    settings: (c) => ({
      apiKey: c.apiKey ?? process.env.GROQ_API_KEY,
      baseURL: c.baseURL,
      headers: c.headers,
    }),
  },
  ollama: {
    label: 'Ollama',
    pkg: '@ai-sdk/openai-compatible',
    factory: 'createOpenAICompatible',
    defaultModel: 'llama3.2',
    settings: (c) => ({
      name: 'ollama',
      baseURL: c.baseURL ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',
      headers: c.headers,
    }),
  },
}

/** Driver factory for OpenAI, Anthropic, Google/Gemini, Groq, Ollama, ACP, and Custom providers. */
export async function createDriver(
  name: string,
  config: ProviderConfig,
  deps: { logger?: Logger; confirmation: ConfirmationService }
): Promise<AiDriver> {
  switch (config.driver) {
    case 'acp': {
      const { createAcpDriver } = await import('../acp/provider.js')
      return createAcpDriver(name, config as AcpProviderConfig, {
        logger: deps.logger,
        confirmation: deps.confirmation,
      })
    }

    case 'custom': {
      const customModel = await config.factory(config)
      const defaultModel = config.defaultModel ?? 'custom'
      return {
        name,
        defaultModel,
        getModel: (m) => (typeof customModel === 'function' ? customModel(m ?? defaultModel) : customModel),
      }
    }

    default: {
      const spec = Object.hasOwn(SDK_DRIVERS, config.driver) ? SDK_DRIVERS[config.driver] : undefined
      if (!spec) {
        throw new ProviderConfigError(name, `Unsupported driver type: "${config.driver}"`)
      }
      return sdkDriver(name, spec, config)
    }
  }
}

/** Loads a built-in SDK package, builds its client, and wraps it as a driver. */
export async function sdkDriver(name: string, spec: SdkDriverSpec, config: ProviderConfig): Promise<AiDriver> {
  const sdk = await safeImport<Record<string, ClientFactory>>(
    spec.pkg,
    `${spec.label} driver requires package "${spec.pkg}"`
  )
  const client = sdk[spec.factory](spec.settings(config))
  const defaultModel = config.defaultModel ?? spec.defaultModel
  return {
    name,
    defaultModel,
    getModel: (m) => client(m ?? defaultModel),
  }
}

export async function safeImport<T>(pkgName: string, helpMsg: string): Promise<T> {
  try {
    return (await import(pkgName)) as T
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    throw new AiException(`${helpMsg}. Error: ${message}`, 'E_AI_MISSING_DEPENDENCY', e)
  }
}
