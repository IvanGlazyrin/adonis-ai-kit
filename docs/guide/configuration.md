# Configuration

Configuration for `adonis-ai-kit` lives in `config/ai.ts`.

---

## Configuration File

Create or update `config/ai.ts` using the `defineConfig` helper:

```ts
// config/ai.ts
import env from '#start/env'
import { defineConfig } from 'adonis-ai-kit'

export default defineConfig({
  // Default provider used when none is specified
  default: 'openai',

  // Configured AI provider instances
  providers: {
    openai: {
      driver: 'openai',
      apiKey: env.get('OPENAI_API_KEY'),
      defaultModel: 'gpt-6-sol',
    },
    anthropic: {
      driver: 'anthropic',
      apiKey: env.get('ANTHROPIC_API_KEY'),
      defaultModel: 'claude-sonnet-5-5',
    },
    gemini: {
      driver: 'google',
      apiKey: env.get('GEMINI_API_KEY'),
      defaultModel: 'gemini-3.5-flash',
    },
  },

  // Fallback providers to try in order when the primary provider fails with 429/5xx errors
  fallbackCascade: ['anthropic', 'gemini'],

  // Circuit breaker settings per provider:model
  circuitBreaker: {
    failureThreshold: 5,        // Open circuit after 5 consecutive failures
    recoveryTimeoutMs: 30_000,  // Wait 30s before trying a probe request
    halfOpenMaxAttempts: 2,     // Require 2 successful probes before closing circuit
  },
})
```

`defineConfig` requires at least one provider and checks that `default` and every `fallbackCascade` entry are registered. When `fallbackCascade` is omitted, every other provider except `acp` and `custom` ones becomes a fallback. A fallback provider uses its own `defaultModel` (or `fallbackModels[provider]`); the model requested for the primary provider is never forwarded.

### Other Options

| Key | Description |
| :--- | :--- |
| `fallbackModels` | Model per fallback provider, e.g. `{ anthropic: 'claude-sonnet-5-5' }` |
| `budget` | `pricing` (USD per 1M tokens per model), `defaultAgentName`, `sink` (called with every cost record, may be async, never awaited) and `maxRecords` (records kept in memory, `0` keeps aggregates only; see [Persisting cost records](/guide/budget-and-cost#persisting-cost-records)). `maxTokensPerRequest` and `maxCostPerRequestUsd` only log a warning when a call goes over them; they do not stop it (see [Token Budget](/guide/budget-and-cost)) |
| `catalog` | models.dev settings: `preferCache`, `cachePath`, `overridePath`, `ttlMs`, `autoPricing`, `systemProviders` |
| `agentConfigsDir` / `agentSkillsDir` | Agent manifests and skills (default `resources/agent-configs`, `resources/agent-skills`) |
| `resolver` / `languageModels` | Resolve and build entries of `models` chains |
| `conversations` | `{ store }`, a `ConversationStore` (default: in memory) |
| `mcp` | MCP servers whose tools are registered in the `ToolRegistry` |
| `approvals` | `mode`, `secret`, `ttlMs`, `allowVolatileStore` for `ask` tools |

---

## Environment Variables

Define your API credentials in `.env`:

```dotenv
OPENAI_API_KEY=sk-proj-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=AIzaSy...
```

Add validation in `start/env.ts`:

```ts
// start/env.ts
import { Env } from '@adonisjs/core/env'

export default await Env.create(new URL('../', import.meta.url), {
  OPENAI_API_KEY: Env.schema.string.optional(),
  ANTHROPIC_API_KEY: Env.schema.string.optional(),
  GEMINI_API_KEY: Env.schema.string.optional(),
})
```

When `apiKey` is omitted, the drivers read `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` / `GOOGLE_API_KEY` or `GROQ_API_KEY` from the environment. The same applies to the other settings the config leaves out: `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `OPENAI_ORG_ID` and `OLLAMA_BASE_URL` (default `http://localhost:11434/v1`).

---

## Provider Drivers

| Driver | Package | Settings |
| :--- | :--- | :--- |
| `'openai'` | `@ai-sdk/openai` | `apiKey`, `organization`, `project`, `baseURL`, `headers` |
| `'anthropic'` | `@ai-sdk/anthropic` | `apiKey`, `baseURL`, `headers` |
| `'google'` / `'gemini'` | `@ai-sdk/google` | `apiKey`, `baseURL`, `headers` |
| `'groq'` | `@ai-sdk/groq` | `apiKey`, `baseURL`, `headers` |
| `'ollama'` | `@ai-sdk/openai-compatible` | `baseURL` (default `http://localhost:11434/v1`), `headers` |
| `'acp'` | `@mcpc-tech/acp-ai-provider` | Local coding agents (see [ACP Coding Agents](/guide/acp-agents)) |
| `'custom'` | any | `factory` returns an AI SDK `LanguageModel` or `(modelId) => LanguageModel` |

Every driver accepts `defaultModel`.

---

## Custom Base URLs & Proxies

If you route requests through an AI Gateway (e.g. Cloudflare AI Gateway, Portkey, LiteLLM) or a corporate reverse proxy, specify the `baseURL`:

```ts
// config/ai.ts
providers: {
  openai: {
    driver: 'openai',
    apiKey: env.get('OPENAI_API_KEY'),
    baseURL: 'https://gateway.ai.cloudflare.com/v1/account-id/gateway-name/openai',
  },
}
```

---

## Self-Hosted & OpenAI-Compatible Providers

For Ollama, use the `ollama` driver:

```ts
// config/ai.ts
providers: {
  local: {
    driver: 'ollama',
    baseURL: env.get('OLLAMA_BASE_URL', 'http://localhost:11434/v1'),
    defaultModel: 'llama3.2',
  },
}
```

For other private LLM servers (vLLM, LM Studio, Together AI), use the `custom` driver:

```ts
// config/ai.ts
providers: {
  vllm: {
    driver: 'custom',
    defaultModel: 'llama-3.3-70b',
    factory: async () => {
      const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible')
      const provider = createOpenAICompatible({
        name: 'vllm',
        baseURL: env.get('VLLM_URL', 'http://localhost:8000/v1'),
        apiKey: env.get('VLLM_KEY'),
        headers: { 'X-Custom-Tenant': 'production' },
      })
      return (modelId) => provider(modelId)
    },
  },
}
```

`custom` and `acp` providers are never added to the fallback cascade automatically.

---

## Dynamic Multi-Tenant Credentials

In multi-tenant SaaS environments where customers bring their own keys (BYOK), pass a dynamic `models` chain. Each entry is a `ResolvedModel` object or a model reference string; the provider cascade is then not used:

```ts
import ai from 'adonis-ai-kit/services/main'

const result = await ai.generateText({
  prompt: 'Generate monthly executive briefing',
  models: [
    {
      providerID: 'anthropic',
      modelID: 'claude-sonnet-5-5',
      npm: '@ai-sdk/anthropic',
      apiKey: tenant.anthropicApiKey,
      credentialKey: `tenant:${tenant.id}:anthropic`,
    },
    'openai/gpt-6-sol', // Platform failover (resolved through config.resolver)
  ],
  onFallback: ({ fromModel, toModel, errorClass }) => logger.warn(`${fromModel} -> ${toModel} (${errorClass})`),
})
```

- Each entry has its own circuit breaker, keyed by `credentialKey` when present, so one bad tenant key does not block the others.
- String entries need `config.resolver` (for example a `CatalogModelResolver`); without one a `ProviderConfigError` is thrown.
- `npm` can be any of the built-in provider packages: `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/google-vertex`, `@ai-sdk/azure`, `@ai-sdk/amazon-bedrock`, `@ai-sdk/groq`, `@ai-sdk/mistral`, `@ai-sdk/cohere`, `@ai-sdk/xai`, `@ai-sdk/cerebras`, `@ai-sdk/deepinfra`, `@ai-sdk/togetherai`, `@ai-sdk/perplexity`, `@ai-sdk/gateway`, `@ai-sdk/vercel`, `@ai-sdk/openai-compatible`, `@openrouter/ai-sdk-provider`, `@gitlab/gitlab-ai-provider`. Register others with `ProviderFactoryRegistry.register()`.
