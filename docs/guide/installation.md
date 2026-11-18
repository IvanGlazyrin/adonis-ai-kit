# Installation

## Requirements

- Node.js `>= 24.0.0`
- AdonisJS `>= 7.0.0`
- TypeScript `>= 5.0.0`
- `zod` `^3.25.76 || ^4.1.8` (a peer dependency; `ai` 7 already requires it, so it is installed with the AI SDK)

> [!NOTE]
> `zod` is a peer dependency so your schemas (`schema`, tool `inputSchema`) and the package share one copy of it. Two copies would break type checks and `instanceof` checks.

---

## Quick Setup

```bash
node ace add adonis-ai-kit
```

This installs the package and runs its configure hook, which:

1. registers the service provider and the Ace commands in `adonisrc.ts`;
2. adds `OPENAI_API_KEY` to `.env` and `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` validation to `start/env.ts`;
3. creates `config/ai.ts` with an OpenAI provider and a commented-out Anthropic one. An existing `config/ai.ts` is never overwritten.

To run the setup again for an already installed package, use `node ace configure adonis-ai-kit`. Install the provider packages you need (see below) and set the keys in `.env`.

> [!NOTE]
> Editing `adonisrc.ts` and `start/env.ts` needs `@adonisjs/assembler`, which a standard AdonisJS 7 app already has. Without it AdonisJS skips those steps with a warning: use the manual installation below.

---

## Manual Installation

### Package Installation

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

### Installing Provider Peer Dependencies

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

### Service Provider and Commands Registration

Register the AI service provider and the Ace commands in your application's `adonisrc.ts` file:

```ts
// adonisrc.ts
import { defineConfig } from '@adonisjs/core/app'

export default defineConfig({
  commands: [
    // ...other commands
    () => import('adonis-ai-kit/commands'),
  ],
  providers: [
    // ...other providers
    () => import('adonis-ai-kit/providers/ai_provider'),
  ],
})
```

The `commands` entry adds `ai:test` and `make:ai-agent` to Ace (see [CLI](./cli.md)).

#### What the Provider Does

1. **IoC Container Singleton:** Binds the `ai` service (`AiManager`) to the AdonisJS container under the `'ai'` key.
2. **HTTP Response Macro:** Installs the `response.streamAI()` macro on the HTTP response object for seamless Server-Sent Events (SSE) streaming.
3. **Graceful Application Shutdown:** Hooks into application shutdown (`ai.shutdown()`) to stop ACP coding agent child processes, settle pending confirmations as not approved, and close MCP clients.

## Using the kit without the HTTP layer

`adonis-ai-kit/core` exports everything except the `response.streamAI()` macro and the `configure` hook: the manager,
models, guards, budget, catalog, agents, MCP and approvals. Use it in a worker, a script, or another library that builds
on the kit. Outside an AdonisJS process, default folders (`resources/agent-configs`, `storage/models`) resolve under the
working directory.

```ts
import { AiManager, defineConfig } from 'adonis-ai-kit/core'
```
