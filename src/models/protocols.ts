/** The npm package of ACP agents: `model.npm` for an ACP model, and the marker the fallback rules check. */
export const ACP_NPM = '@mcpc-tech/acp-ai-provider'

export const PROTOCOL_TO_NPM: Readonly<Record<string, string>> = {
  'openai': '@ai-sdk/openai',
  'anthropic': '@ai-sdk/anthropic',
  'openai-compatible': '@ai-sdk/openai-compatible',
  'openrouter': '@openrouter/ai-sdk-provider',
  'google': '@ai-sdk/google',
  'vertex': '@ai-sdk/google-vertex',
  'vertex-anthropic': '@ai-sdk/google-vertex/anthropic',
  'azure': '@ai-sdk/azure',
  'groq': '@ai-sdk/groq',
  'mistral': '@ai-sdk/mistral',
  'cerebras': '@ai-sdk/cerebras',
  'deepinfra': '@ai-sdk/deepinfra',
  'togetherai': '@ai-sdk/togetherai',
  'cohere': '@ai-sdk/cohere',
  'xai': '@ai-sdk/xai',
  'perplexity': '@ai-sdk/perplexity',
  'bedrock': '@ai-sdk/amazon-bedrock',
  'gateway': '@ai-sdk/gateway',
  'vercel': '@ai-sdk/vercel',
  'gitlab': '@gitlab/gitlab-ai-provider',
  'qwencode': '@ai-sdk/openai-compatible',
  'acp': ACP_NPM,
}

export function resolveProviderNpm(config: {
  npmPackage?: string | null
  protocol?: string | null
}): string {
  if (config.npmPackage) return config.npmPackage

  const npm = config.protocol ? PROTOCOL_TO_NPM[config.protocol] : undefined
  if (npm) return npm

  throw new Error(`Unsupported provider protocol: ${config.protocol || 'unknown'}`)
}
