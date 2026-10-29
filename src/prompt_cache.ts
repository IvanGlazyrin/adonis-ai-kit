import { AiException } from './errors.js'
import type { CacheTtl, ProviderOptions, PromptCacheOptions } from './types.js'

/** The Anthropic `cache_control` value for a breakpoint with the given lifetime. */
export function cacheControlFor(ttl: CacheTtl): { type: 'ephemeral'; ttl: CacheTtl } {
  return { type: 'ephemeral', ttl }
}

/**
 * Rejects cache TTL combinations that Anthropic does not accept, before any model call (the rules of
 * laravel/ai `BuildsTextRequests`): a 1h instructions cache needs a 1h tools cache when tools are cached, and a
 * 1h request-level automatic cache needs every explicit breakpoint to be 1h.
 */
export function validatePromptCache(options: {
  promptCache?: PromptCacheOptions
  providerOptions?: ProviderOptions
}): void {
  const { instructions, tools } = options.promptCache ?? {}
  if (instructions === '1h' && tools !== undefined && tools !== '1h') {
    throw invalid('a one-hour instructions cache requires the tools cache to also use a one-hour TTL')
  }

  const requestCache = options.providerOptions?.anthropic?.cacheControl as { ttl?: unknown } | undefined
  if (requestCache?.ttl === '1h') {
    const explicit = [instructions, tools].filter((ttl): ttl is CacheTtl => ttl !== undefined)
    if (explicit.some((ttl) => ttl !== '1h')) {
      throw invalid('a one-hour automatic cache requires all explicit cache breakpoints to also use a one-hour TTL')
    }
  }
}

/**
 * Merges provider options per provider key: the entries of `extra` are added to `base[provider]`, so
 * options the caller already set (for the same provider) are kept.
 */
export function mergeProviderOptions(
  base: ProviderOptions | undefined,
  extra: ProviderOptions
): ProviderOptions {
  const merged: ProviderOptions = { ...base }
  for (const [provider, options] of Object.entries(extra)) {
    merged[provider] = { ...merged[provider], ...options }
  }
  return merged
}

function invalid(message: string): AiException {
  return new AiException(`Invalid prompt cache options: ${message}.`, 'E_AI_INVALID_ARGUMENT')
}
