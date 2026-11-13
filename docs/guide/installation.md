# Installation

## Requirements

- Node.js `>= 24.0.0`
- AdonisJS `>= 7.0.0`
- TypeScript `>= 5.0.0`

---

## Package Installation

Install `adonis-ai-kit` via your preferred package manager:

```bash
# Using npm
npm install adonis-ai-kit

# Using pnpm
pnpm add adonis-ai-kit

# Using yarn
yarn add adonis-ai-kit
```

> [!NOTE]
> The package is named **`adonis-ai-kit`** on npm (the `adonis-ai` name belongs to another project).

---

## Installing Provider Peer Dependencies

`adonis-ai-kit` relies on modular Vercel AI SDK provider adapters (optional peer dependencies). Install the providers your application needs. `models` chains can also load `@ai-sdk/azure`, `@ai-sdk/amazon-bedrock`, `@ai-sdk/mistral`, `@ai-sdk/cohere`, `@ai-sdk/xai`, `@openrouter/ai-sdk-provider` and others:

```bash
# OpenAI (driver: 'openai')
npm install @ai-sdk/openai

# Anthropic (driver: 'anthropic')
npm install @ai-sdk/anthropic

# Google Gemini (driver: 'google' or 'gemini')
npm install @ai-sdk/google

# Groq (driver: 'groq')
npm install @ai-sdk/groq

# Ollama (driver: 'ollama') and other OpenAI-compatible servers
npm install @ai-sdk/openai-compatible

# Optional: Model Context Protocol (MCP) support (v2)
npm install @ai-sdk/mcp

# Optional: Agent Client Protocol (ACP) for Claude Code / opencode
npm install @mcpc-tech/acp-ai-provider
```

---

## Service Provider Registration

Register the AI service provider in your application's `adonisrc.ts` file:

```ts
// adonisrc.ts
import { defineConfig } from '@adonisjs/core/app'

export default defineConfig({
  providers: [
    // ...other providers
    () => import('adonis-ai-kit/providers/ai_provider'),
  ],
})
```

### What the Provider Does

1. **IoC Container Singleton:** Binds the `ai` service (`AiManager`) to the AdonisJS container under the `'ai'` key.
2. **HTTP Response Macro:** Installs the `response.streamAI()` macro on the HTTP response object for seamless Server-Sent Events (SSE) streaming.
3. **Graceful Application Shutdown:** Hooks into application shutdown (`ai.shutdown()`) to stop ACP coding agent child processes, settle pending confirmations as not approved, and close MCP clients.
