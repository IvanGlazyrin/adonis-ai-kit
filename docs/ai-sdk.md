# AI SDK for AdonisJS 7

- [Introduction](#introduction)
- [Installation](#installation)
- [Configuration](#configuration)
    - [Custom Base URLs](#custom-base-urls)
    - [Self-Hosted & OpenAI-Compatible Providers](#self-hosted-openai-compatible-providers)
    - [On-Demand Providers & Dynamic Credentials](#on-demand-providers-dynamic-credentials)
    - [Provider Support](#provider-support)
- [Text Generation](#text-generation)
    - [Prompting & Instructions](#prompting-instructions)
    - [Usage & Live Cost Tracking](#usage-live-cost-tracking)
    - [Structured Output](#structured-output)
- [Streaming](#streaming)
    - [Basic Streaming](#basic-streaming)
    - [AdonisJS SSE Macro (`response.streamAI`)](#adonisjs-sse-macro-response-streamai)
    - [Client Disconnect & Abort Detection](#client-disconnect-abort-detection)
    - [Structured Streaming with Tools](#structured-streaming-with-tools)
- [Conversations](#conversations)
    - [Remembering Conversations](#remembering-conversations)
    - [Owner Verification & Security](#owner-verification-security)
    - [Optimistic Concurrency Control](#optimistic-concurrency-control)
    - [Pruning Conversation History](#pruning-conversation-history)
    - [Database Store (Lucid ORM Adapter)](#database-store-lucid-orm-adapter)
- [Agents](#agents)
    - [Scaffolded Agent Classes](#scaffolded-agent-classes)
    - [Declarative Markdown Manifests](#declarative-markdown-manifests)
    - [Skills & Progressive Disclosure (On-Demand)](#skills-progressive-disclosure-on-demand)
    - [Sub-Agents](#sub-agents)
    - [ACP Coding Agents (Claude Code, opencode)](#acp-coding-agents-claude-code-opencode)
    - [Step Control & Tool Narrowing (`prepareStep`)](#step-control-tool-narrowing-preparestep)
    - [Loop Limits & Budget Stops (`stopWhen`)](#loop-limits-budget-stops-stopwhen)
    - [Tool Call Repair (`repairToolCall`)](#tool-call-repair-repairtoolcall)
    - [Prompt Caching](#prompt-caching)
    - [JSON Recovery](#json-recovery)
- [Tools & Security Guardrails](#tools-security-guardrails)
    - [Tool Registry](#tool-registry)
    - [Permissions (`allow`, `ask`, `deny`)](#permissions-allow-ask-deny)
    - [PolicyGuard Rules](#policyguard-rules)
    - [Streaming Tools](#streaming-tools)
- [Human Tool Approval (Human-in-the-Loop)](#human-tool-approval-human-in-the-loop)
    - [In-Process Approvals (`ConfirmationService`)](#in-process-approvals-confirmationservice)
    - [Resumable Approvals (Survives Process Restarts)](#resumable-approvals-survives-process-restarts)
    - [Resolving Approvals](#resolving-approvals)
- [MCP Servers as Tools](#mcp-servers-as-tools)
    - [Configuring MCP Servers](#configuring-mcp-servers)
    - [Security Model: Deny by Default](#security-model-deny-by-default)
    - [Untrusted Metadata Sanitization](#untrusted-metadata-sanitization)
    - [Pinning Tool Definitions Against Rug-Pulls](#pinning-tool-definitions-against-rug-pulls)
- [Cost Tracking & Token Budget](#cost-tracking-token-budget)
    - [Live USD Cost Calculations](#live-usd-cost-calculations)
    - [CostTracker (Ring Buffer)](#costtracker-ring-buffer)
    - [Atomic Token Budget Enforcement](#atomic-token-budget-enforcement)
    - [Live Catalog Discovery (`models.dev`)](#live-catalog-discovery-models-dev)
- [SRE Resilience & Failover](#sre-resilience-failover)
    - [Cascading Multi-Provider Failover](#cascading-multi-provider-failover)
    - [Circuit Breaker (Per `provider:model`)](#circuit-breaker-per-provider-model)
    - [Fail-Closed Side-Effect Protection](#fail-closed-side-effect-protection)
    - [Error Taxonomy & Retry Policies](#error-taxonomy-retry-policies)
- [Testing](#testing)
    - [Fakes & Test Doubles](#fakes-test-doubles)
    - [Simulating Provider Outages](#simulating-provider-outages)
    - [Testing Custom Conversation Stores](#testing-custom-conversation-stores)
- [Ace CLI Commands](#ace-cli-commands)
    - [`ai:test`](#ai-test)
    - [`make:ai-agent`](#make-ai-agent)

---

## Introduction

The **Adonis AI Kit** (`adonis-ai-kit`) provides a unified, expressive, and production-grade API for building modern AI applications and autonomous agents in **AdonisJS 7**.

Powered under the hood by **Vercel AI SDK v7**, the kit marries the idiomatic developer experience of AdonisJS with enterprise-grade SRE resilience:

- **Unified Multi-Provider API:** Built-in drivers for OpenAI, Anthropic, Google Gemini, Groq, Ollama and ACP agents, a `custom` driver for any AI SDK model, and dynamic `models` chains that reach Amazon Bedrock, Azure, Mistral, Cohere, xAI, OpenRouter, Vertex and more.
- **Failover & Per-Model Circuit Breakers:** Automatic cascading failover on rate limits (429) or upstream downtime (5xx), with isolated half-open state tracking per model and fail-closed safety for side effects.
- **Tool Security Guardrails & Human-in-the-Loop:** Policy-enforced tool execution (`allow`, `ask`, `deny`), call limits, argument rules, and signed resumable approvals that survive server restarts.
- **Agent Architectures:** File-based Markdown agent manifests, on-demand skill disclosure, sub-agent isolation, and scaffolded agent classes.
- **ACP (Agent Client Protocol):** Orchestration of CLI-based coding agents such as Claude Code and opencode with a sanitized child-process environment.
- **Model Context Protocol (MCP):** stdio and HTTP/SSE MCP servers as registry tools, with untrusted-description cleaning and pins against changed tool definitions ("rug pulls").
- **Live USD Cost & Atomic Token Budgets:** Cost computation from the `models.dev` catalog, ring-buffer usage tracking, and race-free token pre-flight reservations.
- **HTTP Streaming Macro:** `response.streamAI()` for Server-Sent Events (SSE), the AI SDK UI message stream or raw text, with client-disconnect abort propagation and heartbeat keepalives.

---

## Installation

Install the package via your preferred Node package manager:

```bash
npm install adonis-ai-kit
# or
pnpm add adonis-ai-kit
# or
yarn add adonis-ai-kit
```

> [!NOTE]
> The npm package is named **`adonis-ai-kit`**. The source code repository is located at [github.com/IvanGlazyrin/adonis-ai-kit](https://github.com/IvanGlazyrin/adonis-ai-kit).

Provider packages are optional peer dependencies. Install the ones you use, for example `@ai-sdk/openai` and `@ai-sdk/anthropic`.

### Register the Service Provider

Next, register the AI service provider in your application's `adonisrc.ts` file:

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

Registering the provider binds the `ai` singleton (`AiManager`) to the AdonisJS IoC container, installs the `response.streamAI()` macro on the HTTP response, and on application shutdown stops ACP agent processes, settles pending confirmations and closes MCP clients.

---

## Configuration

Define your AI settings and provider credentials in `config/ai.ts` using the `defineConfig` helper:

```ts
// config/ai.ts
import env from '#start/env'
import { defineConfig } from 'adonis-ai-kit'

export default defineConfig({
  default: 'openai',

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

  // Fallback order when the primary provider is throttled or fails
  fallbackCascade: ['anthropic', 'gemini'],

  // Per-model circuit breaker configuration
  circuitBreaker: {
    failureThreshold: 5,
    recoveryTimeoutMs: 30_000,
    halfOpenMaxAttempts: 2,
  },
})
```

`defineConfig` requires at least one provider and checks that `default` and every `fallbackCascade` entry are registered. When `fallbackCascade` is omitted, every other provider except `acp` and `custom` ones becomes a fallback. A fallback provider uses its own `defaultModel` (or `fallbackModels[provider]`); the model requested for the primary provider is never forwarded.

Define your API keys in `.env` and validate them in `start/env.ts`:

```dotenv
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=AIzaSy...
```

```ts
// start/env.ts
import { Env } from '@adonisjs/core/env'

export default await Env.create(new URL('../', import.meta.url), {
  OPENAI_API_KEY: Env.schema.string.optional(),
  ANTHROPIC_API_KEY: Env.schema.string.optional(),
  GEMINI_API_KEY: Env.schema.string.optional(),
  // ...
})
```

When `apiKey` is omitted, the drivers read `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` / `GOOGLE_API_KEY` or `GROQ_API_KEY` from the environment. The same applies to the other settings the config leaves out: `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `OPENAI_ORG_ID` and `OLLAMA_BASE_URL` (default `http://localhost:11434/v1`).

### Custom Base URLs

If you are routing requests through an internal AI proxy, corporate gateway, or services like LiteLLM or Cloudflare AI Gateway, you may configure a custom `baseURL`:

```ts
// config/ai.ts
providers: {
  openai: {
    driver: 'openai',
    apiKey: env.get('OPENAI_API_KEY'),
    baseURL: 'https://gateway.internal.corp/v1',
  },
  anthropic: {
    driver: 'anthropic',
    apiKey: env.get('ANTHROPIC_API_KEY'),
    baseURL: 'https://anthropic-proxy.corp/v1',
  },
}
```

### Self-Hosted & OpenAI-Compatible Providers

For Ollama, use the `ollama` driver (it uses `@ai-sdk/openai-compatible` and defaults to `http://localhost:11434/v1`):

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

For other self-hosted engines (vLLM, LM Studio, Together AI, Fireworks), use the `custom` driver, whose `factory` returns an AI SDK model or a `(modelId) => LanguageModel` function:

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
        headers: { 'X-Tenant-ID': env.get('TENANT_ID', 'default') },
      })
      return (modelId) => provider(modelId)
    },
  },
}
```

Once configured, invoke it directly:

```ts
import ai from 'adonis-ai-kit/services/main'

const response = await ai.generateText({
  prompt: 'Summarize the documentation',
  provider: 'vllm',
  model: 'llama-3.3-70b',
})
```

> [!NOTE]
> `custom` and `acp` providers are never added to the fallback cascade automatically; list them in `fallbackCascade` if you want them there.

### On-Demand Providers & Dynamic Credentials

In multi-tenant SaaS applications, tenants often provide their own API keys (BYOK). Instead of the static provider cascade, pass an ordered `models` chain to `generateText`, `streamText` or `generateObject`. Each entry is a `ResolvedModel` object or a model reference string:

```ts
import ai from 'adonis-ai-kit/services/main'

const response = await ai.generateText({
  prompt: 'Generate an audit summary',
  models: [
    {
      providerID: 'openai',
      modelID: 'gpt-6-sol',
      npm: '@ai-sdk/openai',
      apiKey: tenant.openaiApiKey,
      credentialKey: `tenant:${tenant.id}:openai`,
    },
    'anthropic/claude-sonnet-5-5', // Platform fallback (resolved through config.resolver)
  ],
  onFallback: ({ fromModel, toModel, errorClass }) => {
    logger.warn(`Tenant model failed (${errorClass}). Rerouting ${fromModel} -> ${toModel}`)
  },
})

response.provider // providerID of the model that answered
response.model    // its modelID
```

- Entries are tried in order. Retryable failures (429, 5xx, network) and entries that cannot be attempted (missing provider package, config error, open breaker) move on to the next entry.
- Each entry has its own circuit breaker, keyed by `credentialKey` when present, so an invalid tenant key does not trip the breaker for other users. `fromModel` / `toModel` are these breaker keys.
- String entries are resolved through `config.resolver` (for example a `CatalogModelResolver`); without one a `ProviderConfigError` is thrown.
- An empty `models` array uses the provider cascade.

### Provider Support

**Config drivers** (the `driver` value in `config/ai.ts`):

| Driver | Package | Notes |
| :--- | :--- | :--- |
| `'openai'` | `@ai-sdk/openai` | `apiKey`, `organization`, `project`, `baseURL`, `headers` |
| `'anthropic'` | `@ai-sdk/anthropic` | `apiKey`, `baseURL`, `headers` |
| `'google'` / `'gemini'` | `@ai-sdk/google` | `apiKey`, `baseURL`, `headers` |
| `'groq'` | `@ai-sdk/groq` | `apiKey`, `baseURL`, `headers` |
| `'ollama'` | `@ai-sdk/openai-compatible` | `baseURL` (default `http://localhost:11434/v1`) |
| `'acp'` | `@mcpc-tech/acp-ai-provider` | Local ACP coding agents (see [ACP](#acp-coding-agents-claude-code-opencode)) |
| `'custom'` | any | `factory` returns an AI SDK `LanguageModel` or `(modelId) => LanguageModel` |

**`models` chain packages** (the `npm` field of a `ResolvedModel`, or the protocol of a catalog entry): `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/google-vertex` (and `/anthropic`), `@ai-sdk/azure`, `@ai-sdk/amazon-bedrock`, `@ai-sdk/groq`, `@ai-sdk/mistral`, `@ai-sdk/cohere`, `@ai-sdk/xai`, `@ai-sdk/cerebras`, `@ai-sdk/deepinfra`, `@ai-sdk/togetherai`, `@ai-sdk/perplexity`, `@ai-sdk/gateway`, `@ai-sdk/vercel`, `@ai-sdk/openai-compatible`, `@openrouter/ai-sdk-provider`, `@gitlab/gitlab-ai-provider`. Other packages can be added with `ProviderFactoryRegistry.register()`.

---

## Text Generation

### Prompting & Instructions

The simplest way to interact with an AI model is using the `generateText` method on the `ai` service:

```ts
import ai from 'adonis-ai-kit/services/main'

const response = await ai.generateText({
  system: 'You are an expert AdonisJS software architect.',
  prompt: 'Explain IoC container autowiring in AdonisJS 7 in three bullet points.',
})

console.log(response.text)
```

You may optionally specify a specific provider, model, temperature, or maximum token limit:

```ts
const response = await ai.generateText({
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  temperature: 0.2,
  maxOutputTokens: 1000,
  prompt: 'Refactor this database query...',
})
```

`prompt` must be a string; pass a message list as `messages` (AI SDK `ModelMessage[]`).

### Usage & Live Cost Tracking

Every response returns normalized token usage, the duration, and the USD cost when pricing for the model is known (from the `models.dev` catalog or `config.budget.pricing`):

```ts
const response = await ai.generateText({
  prompt: 'Analyze this report',
})

console.log(response.usage)
// {
//   inputTokens: 1420,      // includes cached tokens
//   outputTokens: 380,      // includes reasoning tokens
//   totalTokens: 1800,
//   cacheReadTokens: 1024,
//   cacheWriteTokens: 0,
//   reasoningTokens: 0,
//   ...
// }

console.log(`Duration: ${response.durationMs}ms`)
console.log(`Estimated Cost: $${response.costUsd?.toFixed(6) ?? 'n/a'}`)
```

> [!TIP]
> Cache reads and writes are priced at the model's cache rates when the pricing has them (otherwise at the input rate), and reasoning tokens at the output rate unless the pricing sets a separate reasoning rate.

### Structured Output

To generate structured data validated at runtime, use `generateObject` with a **Zod** schema:

```ts
import { z } from 'zod'
import ai from 'adonis-ai-kit/services/main'

const invoiceSchema = z.object({
  invoiceNumber: z.string(),
  vendor: z.string(),
  totalAmount: z.number(),
  currency: z.string().default('USD'),
  items: z.array(
    z.object({
      description: z.string(),
      quantity: z.number(),
      unitPrice: z.number(),
    })
  ),
})

const { object } = await ai.generateObject({
  prompt: 'Invoice INV-2026-091 from Acme Corp for 2 servers at $450 each and setup at $100',
  schema: invoiceSchema,
})

console.log(object.vendor) // 'Acme Corp'
console.log(object.totalAmount) // 1000
```

`generateText` and `streamText` also accept `schema`; the parsed value is then exposed as `output`, and it works together with `tools`.

---

## Streaming

### Basic Streaming

When dealing with interactive chat UIs, streaming responses provides immediate feedback to the user:

```ts
import ai from 'adonis-ai-kit/services/main'

const stream = await ai.streamText({
  prompt: 'Write a comprehensive guide on database indexing.',
})

for await (const chunk of stream.textStream) {
  process.stdout.write(chunk)
}
```

The result also exposes `fullStream` (every AI SDK stream part), `usage` and `output` promises, `consume()`, `abort()`, `toTextStreamResponse()` and `toUIMessageStreamResponse()`.

### AdonisJS SSE Macro (`response.streamAI`) {#adonisjs-sse-macro-response-streamai}

The kit integrates directly with AdonisJS HTTP controllers via the `response.streamAI()` macro:

```ts
// app/controllers/chat_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import ai from 'adonis-ai-kit/services/main'

export default class ChatController {
  async chat({ request, response }: HttpContext) {
    const userMessage = request.input('message')

    const stream = await ai.streamText({
      system: 'You are a helpful customer support assistant.',
      prompt: userMessage,
    })

    return response.streamAI(stream, {
      mode: 'sse',
      heartbeatMs: 15_000, // Sends the SSE comment ': ping' every 15s to keep connections alive
    })
  }
}
```

Modes:

- **`sse`** (default): Server-Sent Events.
- **`ui`**: the AI SDK UI message stream (use with `useChat`), including tool parts.
- **`text`**: raw text chunks (`Content-Type: text/plain; charset=utf-8`).

In `sse` mode the macro:
1. Sets the headers `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive` and `X-Accel-Buffering: no` through `response.header()`, so CORS and cookie headers set by middleware are kept. `options.headers` adds or overrides headers.
2. Sends one frame per text delta: `event: message` (or `options.event`) with `data: {"type":"chunk","text":"..."}`.
3. Sends `: ping` heartbeat comments every `heartbeatMs` (default 15000, `0` disables) so proxies and load balancers do not close idle connections.
4. Sends `data: [DONE]` when the stream finishes, or an `event: error` frame with `{"error":"Stream failed"}` when it fails (the real message only with `exposeErrors: true`).

`onChunk`, `onFinish(fullText)` and `onError(error)` callbacks are also available.

### Client Disconnect & Abort Detection

When a client closes their browser tab or cancels a fetch request, continuing LLM generation wastes server resources and tokens.

The `response.streamAI()` macro listens for the `close` event of the Node.js response. If it closes before the response finished, the macro calls `stream.abort('client disconnected')`, which cancels the provider request. An aborted stream is not stored in a conversation.

### Structured Streaming with Tools

You can combine tool calling, structured schemas, and streaming:

```ts
import { z } from 'zod'
import { stepCountIs } from 'ai'
import ai from 'adonis-ai-kit/services/main'

const stream = await ai.streamText({
  prompt: 'Find flights from London to Tokyo under $800 and output the best option.',
  tools: { searchFlights },
  schema: z.object({
    airline: z.string(),
    priceUsd: z.number(),
    flightNumber: z.string(),
  }),
  stopWhen: stepCountIs(5), // takes precedence over `maxSteps`
})

for await (const part of stream.fullStream) {
  if (part.type === 'tool-call') {
    console.log(`Calling tool: ${part.toolName}`)
  }
}

// When stream completes, the parsed object is available
const bestFlight = await stream.output
```

`streamText` falls back to another model only on errors before the first chunk.

---

## Conversations

### Remembering Conversations

For multi-turn chats, `adonis-ai-kit/conversations` stores a conversation's history, checks its owner on every call, and versions every turn:

```ts
import ai from 'adonis-ai-kit/services/main'

// Start a conversation scoped to an authenticated user
const conversation = await ai.conversations.start('user:101')

// First turn
const turn1 = await ai.generateText({
  prompt: 'My favorite programming language is TypeScript.',
  conversation: { id: conversation.id, owner: 'user:101' },
})

// Second turn (automatically remembers prior context)
const turn2 = await ai.generateText({
  prompt: 'What is my favorite programming language?',
  conversation: { id: conversation.id, owner: 'user:101' },
})

console.log(turn2.text) // "Your favorite programming language is TypeScript."
console.log(turn2.conversation) // { id, version }
```

`ai.conversations` also has `get(id, owner)`, `list(owner, { limit, cursor })` and `delete(id, owner)`.

- A turn is stored as one unit after the model answers (the user messages and the model's response messages). A call that fails stores nothing; a stream is stored when it ends normally.
- The system prompt is not stored: it is sent on every call as `system`.
- Binary parts (`Uint8Array`, `ArrayBuffer`, `URL`) cannot be stored: the call throws `E_AI_INVALID_ARGUMENT` before the model is called.
- Stored messages are validated against `ModelMessage` when loaded; a bad one raises `ConversationCorruptError`.

### Owner Verification & Security

Every conversation call checks the owner:

```ts
// Attempting to continue another user's conversation
await ai.generateText({
  prompt: 'Read secret notes',
  conversation: { id: conversation.id, owner: 'user:999' }, // Different user!
})
// Throws: ConversationNotFoundError (the model is not called)
```

To prevent Insecure Direct Object Reference (IDOR) vulnerabilities, a conversation of another owner gives the same answer as an unknown id: `ConversationNotFoundError` (or `false` from `delete`), so the caller cannot tell whether the conversation ID exists. Owners are non-empty strings compared with `===`.

### Optimistic Concurrency Control

Each turn increments the conversation `version` by one:
- If two concurrent requests continue the same version, one succeeds and the other fails with `ConversationConflictError`. The kit does not repeat the model call.
- This prevents race conditions and message divergence in distributed deployments.

### Pruning Conversation History

To stay within model context windows without losing the stored history, use the `prepareHistory` hook. It shapes only what the model sees, for example with `pruneMessages` from `ai`:

```ts
import { pruneMessages } from 'ai'

const turn = await ai.generateText({
  prompt: 'Continue our discussion',
  conversation: {
    id: conversation.id,
    owner: 'user:101',
    prepareHistory: (messages) =>
      pruneMessages({
        messages,
        reasoning: 'before-last-message',
        toolCalls: 'before-last-2-messages',
      }).slice(-40),
  },
})
```

The store retains the complete record, while only the trimmed context is sent to the model.

### Database Store (Lucid ORM Adapter)

By default, an in-memory store is used (`store.durable === false`): a restart drops every conversation, and in `NODE_ENV=production` a warning is logged. The kit has no database dependency; in production, write an adapter that implements `ConversationStore` (`create`, `load`, `append`, `list`, `delete`, and `durable: true`) and configure it:

```ts
// config/ai.ts
import { defineConfig } from 'adonis-ai-kit'
import { LucidConversationStore } from '#services/lucid_conversation_store' // your adapter

export default defineConfig({
  // ...providers
  conversations: {
    store: new LucidConversationStore(),
  },
})
```

`append` must check `owner` and `expectedVersion` in one transaction and throw `ConversationNotFoundError` or `ConversationConflictError`.

#### Database Schema Migration

A table layout that fits the store port:

```ts
// database/migrations/1700000000000_create_ai_conversations_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected conversationsTable = 'ai_conversations'
  protected messagesTable = 'ai_conversation_messages'

  async up() {
    this.schema.createTable(this.conversationsTable, (table) => {
      table.string('id').primary()
      table.string('owner').notNullable()
      table.string('agent_name').nullable()
      table.integer('version').notNullable().defaultTo(0)
      table.jsonb('state').nullable()
      table.jsonb('metadata').nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').notNullable()

      table.index(['owner', 'updated_at'])
    })

    this.schema.createTable(this.messagesTable, (table) => {
      table.increments('id')
      table.string('conversation_id').references('id').inTable(this.conversationsTable).onDelete('CASCADE')
      table.integer('seq').notNullable()
      table.jsonb('message').notNullable()
      table.timestamp('created_at').notNullable()

      table.unique(['conversation_id', 'seq'])
    })
  }

  async down() {
    this.schema.dropTable(this.messagesTable)
    this.schema.dropTable(this.conversationsTable)
  }
}
```

The kit provides a test contract to verify custom store implementations:

```ts
// tests/unit/lucid_store.spec.ts
import { test } from '@japa/runner'
import { conversationStoreContract } from 'adonis-ai-kit/testing'
import { LucidConversationStore } from '#services/lucid_conversation_store'

for (const check of conversationStoreContract(() => new LucidConversationStore())) {
  test(`conversation store: ${check.name}`, () => check.run())
}
```

---

## Agents

### Scaffolded Agent Classes

You can scaffold a typed agent class with the Ace CLI:

```bash
node ace make:ai-agent SupportBot --provider=openai --model=gpt-6-sol
```

This generates `app/ai/agents/support_bot_agent.ts`, a `SupportBotAgent` class with a system prompt and `run()` / `stream()` methods that call `ai.generateText()` / `ai.streamText()`. The file default-exports an instance:

```ts
// app/controllers/support_controller.ts
import supportBot from '../ai/agents/support_bot_agent.js'

const result = await supportBot.run({ prompt: 'Where is my package #89421?' })
console.log(result.text)
```

### Declarative Markdown Manifests

`ai.agent(name)` loads an agent declared as a Markdown file with YAML frontmatter in `resources/agent-configs/` (`agentConfigsDir`). The body is the agent's system prompt:

```markdown
---
id: code-reviewer
description: Reviews pull requests for safety and performance regressions
provider: anthropic
model: claude-sonnet-5-5
stop_steps: 8
skills:
  - security-audit
  - performance-analysis
skillLoading: on-demand
permissions:
  git_diff: allow
  file_read: allow
  post_review_comment: ask
---

You are a senior staff engineer performing rigorous code reviews.
Focus on safety, edge cases, and performance regressions.
```

Frontmatter fields: `id` (defaults to the file name), `description`, `mode` (`primary` or `subagent`, default `subagent`), `provider`, `model`, `temperature`, `maxTokens`, `stop_steps` (default 5), `skills`, `skillLoading` (`eager` or `on-demand`, default `eager`), `permissions` (tool name → `allow` / `ask` / `deny`), `outputSchema`, `phases` and `metadata`.

- `outputSchema` is the **name** of a Zod schema, not the schema itself. It is resolved through the loader's schema resolver, which the app must set once, for example with a `SchemaRegistry` from `adonis-ai-kit/guard`:

```ts
import { SchemaRegistry } from 'adonis-ai-kit/guard'
import { z } from 'zod'
import ai from 'adonis-ai-kit/services/main'

const schemas = new SchemaRegistry().register('TicketSummary', z.object({ summary: z.string() }))
ai.getAgentLoader().setSchemaResolver((name) => schemas.get(name))
```

  Without a resolver the name is ignored, and `runStructured()` then throws because there is no schema.
- `phases` and `metadata` are passed through to the loaded agent's config. The kit does not act on them.

Tools are passed to the runner; the manifest's `permissions` filter them:

```ts
import ai from 'adonis-ai-kit/services/main'

const reviewer = await ai.agent('code-reviewer', {
  tools: { git_diff, file_read, post_review_comment },
  defaultToolPermission: 'deny', // tools the manifest does not list are dropped
})

const result = await reviewer.run('Review pull request #482')
console.log(result.text)
```

A tool the manifest does not mention gets `defaultToolPermission`, which defaults to `allow` (the manifest then acts as a deny/ask list); an MCP tool without an entry is always `deny`. `AgentRunner` also offers `runStream()` / `stream()` and `runStructured(schema, prompt)`.

### Skills & Progressive Disclosure (On-Demand)

Skills are instructional Markdown documents located in `resources/agent-skills/` (`agentSkillsDir`, e.g. `security-audit.md`). A skill may start with frontmatter whose `description` the model sees; without it the first `# heading` is used, then the file name.

- **Eager Loading (Default):** The bodies of all skills listed under `skills:` are added to the system prompt.
- **On-Demand Loading (`skillLoading: on-demand`):**
  Only skill names and descriptions are included in the system prompt. When the agent needs a skill, it calls the built-in `loadSkill` tool, and the body comes back as a tool result.

```markdown
---
skillLoading: on-demand
skills:
  - pci-dss-compliance
  - sql-optimization
---
```

- Each `loadSkill` call uses one step of the tool loop, so raise `stop_steps` if a run needs several skills.
- `loadSkill` is reserved: a caller tool with that name is refused, and a manifest `deny` or `ask` for it is a config error.
- A skill over 256 KB, or a symlink to a file outside the skills directory, is not loaded.
- `runStructured` has no tool loop, so it always gets the full prompt.

> [!TIP]
> Progressive disclosure reduces token consumption for agents with many or large skills. A few short skills are simpler as `eager`.

### Sub-Agents

You can expose an agent as a callable tool for another agent using `agentAsTool`:

```ts
import { stepCountIs } from 'ai'
import ai from 'adonis-ai-kit/services/main'
import { agentAsTool, SubAgentSpend } from 'adonis-ai-kit/agents'
import { stopOnBudget } from 'adonis-ai-kit/budget'

const spend = new SubAgentSpend()
const researcher = await ai.agent('research-specialist')

const manager = await ai.agent('project-manager', {
  tools: {
    delegateResearch: agentAsTool(researcher, {
      spend,
      maxDepth: 1, // Default: a sub-agent cannot call another sub-agent
    }),
  },
})

const result = await manager.run({
  prompt: 'Prepare a competitive landscape analysis',
  // Count the sub-agent's tokens and cost against the parent's budget
  stopWhen: [stepCountIs(8), stopOnBudget({ maxCostUsd: 1 }, ai.getCostTracker(), { extra: spend })],
})
```

#### Sub-Agent Isolation Rules

1. **Task Only:** The sub-agent receives only the task string. The parent agent's conversation history is never forwarded (the parent model can still copy text from its history into the task).
2. **Forced Fail-Closed Permissions:** The sub-agent's tools are only those its manifest allows; every other tool is denied (`defaultToolPermission: 'deny'` is forced). Tool guards are not inherited; pass one with `agentAsTool(runner, { toolGuard })`.
3. **Approval Gating:** A sub-agent cannot ask a human. A manifest with an `ask` tool is refused when the sub-agent tool is created, and an `ask` tool reached at run time fails the parent's tool call with `E_AI_SUBAGENT_APPROVAL_REQUIRED`.
4. **Failures:** A sub-agent that fails returns a tool error (`E_AI_SUBAGENT_FAILED`) to the parent, which goes on. An ACP call failure stops the parent run with `AcpCallFailedError`.
5. **Token & Budget Accountability:** `SubAgentSpend` collects the sub-agent's tokens and cost; they count toward the parent's budget when passed as `extra` to `stopOnBudget`. The cost tracker records the sub-agent under its own agent name.
6. **Nesting:** Sub-agents nest one level by default (`maxDepth: 1`). A `primary` agent cannot be a sub-agent.

### ACP Coding Agents (Claude Code, opencode)

The **Agent Client Protocol (ACP)** driver lets your AdonisJS application drive local coding agents (such as **Claude Code**, **opencode**, Gemini CLI, Codex, Qwen Code, or custom agent executables) as a child process. Install `@mcpc-tech/acp-ai-provider` and configure an `acp` provider:

```ts
// config/ai.ts
providers: {
  // ...
  claude: {
    driver: 'acp',
    agentId: 'claude-code',     // built-in: claude-code, gemini, codex, qwen-code, opencode
    cwd: '/srv/projects/my-app', // absolute path
    permissionPolicy: 'ask',    // default: shell/file permission requests go to the ConfirmationService
  },
}
```

```ts
import ai from 'adonis-ai-kit/services/main'

const run = await ai.generateText({
  provider: 'claude',
  prompt: 'Analyze and fix TypeScript errors in src/guard/index.ts',
})
```

Register a custom agent executable with `registerAcpAgent`:

```ts
import { registerAcpAgent } from 'adonis-ai-kit/acp'

registerAcpAgent('my-agent', {
  id: 'my-agent',
  name: 'My Agent',
  description: 'In-house coding agent',
  command: 'my-agent-acp',
  args: [],
  envVarPrefix: 'ACP_MY_AGENT',
  supportsMcpServers: true,
  // For each target, the first set source is passed to the agent process as `target`
  credentialEnv: [{ target: 'MY_API_KEY', sources: ['MY_API_KEY', 'MY_KEY'] }],
})
```

- **Environment Sanitization:** By default only a safe allowlist (e.g. `PATH`, `HOME`, `LC_*`, `XDG_*`) plus the agent's declared credentials and the provider's `env` reach the child process; database credentials and application secrets are not forwarded. `inheritEnv: true` forwards the full environment. Calling `buildAcpRuntimeConfig` + `createACPProvider` directly bypasses this sanitizing.
- **Permission Requests:** `permissionPolicy` is `ask` (default, via `ai.getConfirmationService()`; denied if nobody answers within `permissionTimeoutMs`), `deny`, or `allow`.
- **Fail-Closed Fallback:** Because an ACP agent can run commands with real-world side effects, a retryable ACP failure is thrown as `AcpCallFailedError` (`E_AI_ACP_CALL_FAILED`, `sideEffectsPossible: true`, the agent's error in `original`) instead of failing over to another model.

### Step Control & Tool Narrowing (`prepareStep`)

Use `prepareStep` to inspect each step of the multi-step tool loop and narrow the tools available:

```ts
const result = await ai.generateText({
  prompt: 'Diagnose the server issue and restart the service if needed.',
  tools: { inspectLogs, checkMetrics, restartService },
  maxSteps: 5,
  prepareStep: ({ stepNumber }) => {
    // Only permit the destructive action after the first diagnostic steps
    if (stepNumber < 2) {
      return { activeTools: ['inspectLogs', 'checkMetrics'] }
    }
    return { activeTools: ['restartService'] }
  },
})
```

- A `model` returned by `prepareStep` is ignored with a warning: fallback, the circuit breaker and cost stay bound to the attempt's model. `AgentRunner` also drops any `instructions` or `system` it returns.
- Tools cannot be added here, only narrowed; a denied tool stays denied even when named in `activeTools`.
- `maxSteps` defaults to 1 (no tool loop beyond the first step).

### Loop Limits & Budget Stops (`stopWhen`)

Protect against infinite agent loops and unbounded token consumption using `stopWhen` (it takes precedence over `maxSteps`):

```ts
import { stepCountIs } from 'ai'
import { stopOnBudget } from 'adonis-ai-kit/budget'
import ai from 'adonis-ai-kit/services/main'

const result = await ai.generateText({
  prompt: 'Deep codebase refactoring',
  tools,
  stopWhen: [
    stepCountIs(10), // Maximum 10 steps
    stopOnBudget({ maxCostUsd: 0.75, maxTokens: 50_000 }, ai.getCostTracker()),
  ],
})
```

`stopOnBudget` ends the loop after the step that exceeds a limit; cost is priced per step by the cost tracker's pricing table.

### Tool Call Repair (`repairToolCall`)

When a model calls an unknown tool or sends invalid input, `repairToolCall` (AI SDK) gives you a chance to fix the call before it fails:

```ts
const result = await ai.generateText({
  prompt: 'Calculate user score',
  tools: { calculate_score: calculateScoreTool },
  repairToolCall: async ({ toolCall }) => {
    if (toolCall.toolName === 'calculateScore') {
      // Map camelCase alias to snake_case tool name
      return { ...toolCall, toolName: 'calculate_score' }
    }
    return null // no repair: the original error is raised
  },
})
```

### Prompt Caching

Mark Anthropic prompt-cache breakpoints for the system prompt and the tools:

```ts
const result = await ai.generateText({
  system: longSystemDocumentation, // Cached!
  prompt: 'How do I configure Redis?',
  tools,
  promptCache: {
    instructions: '1h', // 1-hour cache TTL ('5m' or '1h')
    tools: '1h',
  },
})
```

- At most four breakpoints are sent. A one-hour instructions cache needs a one-hour tools cache (when tools are cached), and a request-level one-hour cache needs every explicit breakpoint to be one hour; other combinations throw `E_AI_INVALID_ARGUMENT` before the call.
- Do not narrow tools per step (`activeTools`, `prepareStep`) when `promptCache.tools` is set: a different tool list changes the cached prefix.

### JSON Recovery

When models wrap JSON output in conversational prose or markdown code fences (` ```json `), `jsonRecovery: true` strips the text around the JSON answer (`extractFirstJsonValue`) before it is parsed with the schema. It is off by default and works with `generateObject` and with `schema` on `generateText` / `streamText`:

```ts
const { object } = await ai.generateObject({
  prompt: 'Generate user profile',
  schema: userSchema,
  jsonRecovery: true, // Strips the prose and fences around the first JSON value
})
```

---

## Tools & Security Guardrails

### Tool Registry

To maintain security across your application, register tools in the centralized `ToolRegistry` (the manager's own is `ai.getToolRegistry()`):

```ts
import { ToolRegistry } from 'adonis-ai-kit/guard'
import { tool } from 'ai'
import { z } from 'zod'

const registry = new ToolRegistry()

// 1. Safe read-only tool
registry.registerTool(
  'fetch_user',
  tool({
    description: 'Fetch user details by ID',
    inputSchema: z.object({ userId: z.string() }),
    execute: async ({ userId }) => ({ id: userId, name: 'Alice' }),
  }),
  'allow'
)

// 2. Destructive tool requiring approval
registry.registerTool(
  'delete_account',
  tool({
    description: 'Permanently delete user account',
    inputSchema: z.object({ userId: z.string() }),
    execute: async ({ userId }) => ({ deleted: true }),
  }),
  'ask'
)

// Per-agent overrides
registry.setAgentPermissions('support-agent', { delete_account: 'deny' })
```

### Permissions (`allow`, `ask`, `deny`)

Every tool in the registry is resolved to a permission tier:

- **`allow`:** The tool executes immediately without human intervention.
- **`ask`:** The tool waits for a human confirmation before running. Without a `ConfirmationService`, every call is refused.
- **`deny`:** The tool is not offered to the model.

A permission is looked up in the agent's matrix (`setAgentPermissions`), then the tool's own default (`registerTool(name, tool, permission)`), then `askByDefault`. In `ToolRegistry`, a tool with no permission is **denied (`deny`)** (configurable with `defaultPermission`).

> [!IMPORTANT]
> `AiManager` reads `toolPermissions` from the call, not the registry: a tool passed directly with no entry there is `allow`, except MCP tools, which stay `deny`. When you pass registry tools, pass their permissions too (see [MCP](#configuring-mcp-servers) and `getToolsWithApprovals`).

### PolicyGuard Rules

The `PolicyGuard` enforces execution boundaries on tool calls: an allow-list, a maximum number of calls, and argument rules:

```ts
import { PolicyGuard, rangeRule, enumRule } from 'adonis-ai-kit/guard'

const guard = new PolicyGuard({
  maxCalls: 3, // Maximum 3 tool calls for this guard instance (create one per request)
  allowedTools: ['issue_refund', 'lookup_order'],
  rules: {
    issue_refund: [
      rangeRule('amount', 0, 100), // Max $100 refund
      enumRule('currency', ['USD', 'EUR']),
      { field: 'reason', validate: (value) => (typeof value === 'string' && value.length > 0 ? null : 'reason is required') },
    ],
  },
})

// Per call through the manager
await ai.generateText({ prompt, tools, toolPermissions, toolGuard: { guard } })

// Or when handing registry tools to your own code
const guarded = registry.getToolsForAgent('support-agent', {
  guard,
  confirmation: ai.getConfirmationService(), // without it, `ask` tools refuse every call
})
```

A rule's `validate(value, allArgs)` returns an error message or `null`. `check()` reserves a call slot, so parallel tool calls cannot all pass `maxCalls` at once.

> [!WARNING]
> Tools from `getToolsForAgent()` already carry the registry's `ask` wrapper. Do not pass them to `ai.generateText` with `toolPermissions` marking them `ask` as well; use `getToolsWithApprovals()` for manager calls.

### Streaming Tools

A streaming tool (an `async function*`) runs once and gives only its final value (the last chunk) when it runs under a tool guard, with an `ask` permission, or with resumable approvals in the call that continues a paused step (`resolveApprovals` / `resume`). Its intermediate chunks are then not shown to the model or to the caller. Without these wrappers it streams as usual.

---

## Human Tool Approval (Human-in-the-Loop)

### In-Process Approvals (`ConfirmationService`)

By default (`approvals: 'blocking'`), an `ask` tool waits in memory for the manager's `ConfirmationService`. Subscribe to new pending actions and approve or reject them from your UI:

```ts
import ai from 'adonis-ai-kit/services/main'

const confirmations = ai.getConfirmationService()

// Listen for approval requests (e.g., notify an admin via WebSocket or Slack)
confirmations.onActionCreated((action) => {
  console.log(`Tool ${action.toolName} requires confirmation for session ${action.sessionId}`)
  console.log('Parameters:', action.params)
})

// Later, from an admin dashboard:
confirmations.approve(actionId)
// or
confirmations.reject(actionId, 'Disallowed by policy')
```

The wait times out after `defaultTimeoutMs` (default 60 seconds; per call `toolGuard.timeoutMs`). A timeout, an abort or a shutdown never approves: the tool call is rejected fail-closed. `getPendingActions()` lists what is waiting. A restart loses the waits; use resumable approvals for long reviews.

### Resumable Approvals (Survives Process Restarts)

In enterprise architectures, approval by a compliance officer or manager may take hours or days. Server deployments or restarts must not drop pending approval state.

With `approvals: 'resumable'` the run stops at the `ask` tool, and its state is stored in the conversation. The AI SDK signs each approval request with an HMAC secret:

```ts
// config/ai.ts
import env from '#start/env'
import { defineConfig, approvalSecret } from 'adonis-ai-kit'

export default defineConfig({
  // ...providers, conversations: { store: new LucidConversationStore() }
  approvals: {
    secret: approvalSecret(env.get('AI_APPROVAL_SECRET')), // At least 32 bytes
    ttlMs: 24 * 60 * 60 * 1000, // Pending approvals wait 24 hours (default)
  },
})
```

`resumable` needs a conversation, `approvals.secret`, and a durable conversation store (`store.durable === true`); the in-memory store is refused unless `approvals.allowVolatileStore: true` (tests and development). Set `approvals.mode: 'resumable'` to make it the default.

When an `ask` tool is invoked during a conversation:

```ts
const run = await ai.generateText({
  prompt: 'Drop partition table_2025_01',
  tools,
  toolPermissions: { drop_partition: 'ask' },
  approvals: 'resumable',
  conversation: { id: conversation.id, owner: 'admin:1' },
})

console.log(run.status) // 'awaiting-approval'
console.log(run.pendingApprovals)
// [
//   {
//     approvalId: '...',
//     toolCallId: '...',
//     toolName: 'drop_partition',
//     input: { partition: 'table_2025_01' },
//     expiresAt: Date // 2026-11-04T10:00:00.000Z
//   }
// ]
```

`ai.conversations.pendingApprovals(id, owner)` returns the same list later. For registry tools, `registry.getToolsWithApprovals(agentName, options)` returns `tools`, `toolApproval` and `toolPermissions`; pass the tools together with `toolPermissions`, otherwise a non-MCP tool is read as `allow` and runs with no approval.

### Resolving Approvals

Later—potentially days later and on a completely different cluster node—resume the run by resolving the pending approvals. Every approval of the paused step needs a decision in the same call:

```ts
const result = await ai.conversations.resolveApprovals(
  conversation.id,
  'admin:1',
  [
    {
      approvalId: run.pendingApprovals[0].approvalId,
      approved: true, // or false to reject
      reason: 'Approved in change ticket CHG-1042', // optional
    },
  ],
  {
    tools,
    toolPermissions: { drop_partition: 'ask' },
  }
)

console.log(result.text) // "Partition table_2025_01 was successfully dropped."
```

`ai.conversations.resume(id, owner, options)` continues a step whose approvals were all decided earlier (for example after a failed model call).

#### Security Guarantees:
- **Tamper-Proof:** The AI SDK signs each request (HMAC, `experimental_toolApprovalSecret`). A changed tool input or a missing signature throws `ApprovalSignatureError` (`E_AI_APPROVAL_INVALID`) and the step is closed with a denial; an unknown or forged `approvalId` throws `ApprovalNotFoundError`; a missing decision throws `ApprovalIncompleteError`.
- **At-Most-Once Execution:** The decision and an "executing" mark are stored before the tool runs. An approved tool that already ran is never run again: a retry uses its stored result. A tool that was executing when the process stopped is reported to the model as "outcome unknown after restart", not run again.
- **Owner & Expiry:** The owner is checked as for every conversation call. A decision after `ttlMs` is a denial (`reason: 'expired'`, listed in `expiredApprovalIds`). Concurrent decisions on one step: one wins, the other gets `ConversationConflictError`.
- **Anti-Replay:** A replayed decision is `ApprovalNotFoundError`. A call's own `messages` may not contain `tool-approval-request` or `tool-approval-response` parts (`E_AI_APPROVAL_REPLAY`), so an approval cannot be copied into another conversation.
- **Secret Rotation:** Rotating the secret makes pending requests unverifiable, and they are refused. `approvalSecret()` redacts the value in JSON, `String()` and logs.
- **Limits:** A provider-executed tool with `ask` is refused in `resumable` mode (`E_AI_CONFIG_ERROR`). Sub-agents cannot ask, and ACP agents keep `ConfirmationService`.

---

## MCP Servers as Tools

The **Model Context Protocol (MCP)** enables AI agents to connect to external tools and data sources. MCP tools reach the model only as `ToolRegistry` tools.

Install the optional peer dependency (v2):

```bash
npm install @ai-sdk/mcp
```

### Configuring MCP Servers

Register local stdio or remote HTTP/SSE MCP servers in `config/ai.ts`:

```ts
// config/ai.ts
export default defineConfig({
  // ...providers
  mcp: {
    servers: {
      filesystem: {
        command: 'node',
        args: ['./mcp/filesystem-server.js'],
        env: { ROOT_DIR: '/var/data/shared' },
      },
      knowledgeBase: {
        type: 'http', // or 'sse'
        url: 'https://kb.internal.corp/mcp',
        headers: {
          Authorization: `Bearer ${env.get('KB_MCP_TOKEN')}`,
        },
      },
    },
    requirePins: false,
  },
})
```

Register them with the tool registry and grant permissions:

```ts
const registry = ai.getToolRegistry()
await ai.mcp.registerTools(registry) // connects lazily; a server that fails is skipped with a warning

// Expose specific MCP tools with granular permissions
registry.setAgentPermissions('support-agent', {
  mcp__filesystem__read_file: 'allow',
  mcp__filesystem__write_file: 'ask', // Requires approval
})

// Per call: pass the tools AND the same permissions. `ask` tools come back unwrapped,
// so the manager asks once (ConfirmationService, or a pause with approvals: 'resumable').
const { tools, toolPermissions } = registry.getToolsWithApprovals('support-agent')
await ai.generateText({ prompt, tools, toolPermissions })
```

`servers.<key>.tools: ['read_file']` registers only the listed tools of a server. `ai.shutdown()` (or `ai.mcp.close()`) closes the clients; a later `registerTools()` reconnects.

### Security Model: Deny by Default

External MCP servers are treated as untrusted boundaries:
1. **Explicit Permission Required:** An MCP tool without a permission entry is `deny`, in `ToolRegistry` and in `AiManager` / `AgentRunner` when passed directly. `AiManager` reads `toolPermissions`, so pass the registry's permissions there (otherwise the tool is dropped with a warning).
2. **Standardized Naming:** MCP tools are named `mcp__<server>__<tool>`; characters outside `[A-Za-z0-9_-]` become `_`. The server key must start with a letter or digit and be 1-32 characters of `[A-Za-z0-9_-]`. A name over 64 characters, or one already registered, is not registered (warning) and is never cut.
3. **stdio Isolation:** A stdio child gets only a whitelist of the environment (for example `PATH`) plus `env` from the config. Remote servers refuse redirects.

### Untrusted Metadata Sanitization

Remote MCP servers may contain malicious descriptions designed to perform prompt injection:
- Tool descriptions are stripped of control characters and invisible or format characters (bidi controls, zero-width characters, variation selectors, tag characters, noncharacters; Unicode category `Cf`), capped at 1,024 characters and prefixed with `[MCP:<server>]`. A `description` inside the input schema is cleaned the same way.
- Other schema text (`title`, `enum`, `default`, property names, ...) is only checked: a tool holding an invisible character there is not registered.
- A tool whose input schema has a value inside more than 64 nested JSON levels (each object or array is one level, so about 30 nested properties) is not registered (fail-closed).
- `servers.<key>.describe: { read_file: '...' }` replaces a tool description with text you wrote. Server `instructions` never reach the system prompt.
- Tool **results** are not filtered: use `ask` for tools with side effects.

### Pinning Tool Definitions Against Rug-Pulls

A compromised or rogue MCP server could alter its tool definitions after you reviewed them (a "rug-pull" attack).

Generate fingerprints for your server's tools (a SHA-256 digest of each tool's description, input schema and title, base64url-encoded):

```ts
const digests = await ai.mcp.fingerprint('filesystem')
console.log(digests)
// {
//   read_file: 'q3V0mY1nR4...',
//   write_file: 'Zx8kP2tLw0...'
// }
```

Lock them in `config/ai.ts`:

```ts
mcp: {
  servers: {
    filesystem: {
      command: 'node',
      args: ['./mcp/filesystem-server.js'],
      pins: {
        read_file: 'q3V0mY1nR4...',
        write_file: 'Zx8kP2tLw0...',
      },
    },
  },
  requirePins: true, // Also refuse tools without a pin
}
```

A pinned tool whose definition changed is not registered (warning). If it was registered before the change, its registration is replaced by one that refuses every call (`PolicyViolationError`), so the changed tool never runs. It stays refused until the server offers the pinned definition again or you review the change and update the pin.

---

## Cost Tracking & Token Budget

### Live USD Cost Calculations

Every invocation computes its cost when pricing for the model is known:

```ts
const response = await ai.generateText({ prompt: 'Generate quarterly earnings report' })

console.log(response.costUsd) // e.g. 0.04215 (undefined when no pricing is known)
```

Prices (USD per 1M tokens) come from the `models.dev` catalog (`catalog.autoPricing`, default on) or `config.budget.pricing`, and account for:
- Input token rates.
- Output token rates.
- Cache-read and cache-write rates (billed at the input rate when the pricing has none).
- Reasoning tokens (billed at the output rate unless `reasoningCostPer1M` is set).

Tokens a failed attempt consumed are recorded in the cost tracker with `failed: true`.

`budget.maxTokensPerRequest` and `budget.maxCostPerRequestUsd` only log a warning when a call goes over them; they do not stop the call. To stop a tool loop, use `stopOnBudget`. To hold capacity before a call, use `BudgetEnforcer`.

### CostTracker (Ring Buffer)

The manager's `CostTracker` records every call in a memory-bounded ring buffer:

```ts
import ai from 'adonis-ai-kit/services/main'

const tracker = ai.getCostTracker()

console.log(tracker.getTotalCost())   // USD
console.log(tracker.getTotalTokens())
console.log(tracker.getByAgent()['support-agent']) // { tokens, cost, calls, avgDurationMs, totalDurationMs }
console.log(tracker.getByModel())
```

A standalone tracker is created with `new CostTracker({ maxRecords: 10_000, pricing })` from `adonis-ai-kit/budget`. When `maxRecords` (default 10,000) is reached, the oldest records cycle out, while the running aggregates stay exact.

### Atomic Token Budget Enforcement

In high-concurrency environments, checking budget before a call can lead to race conditions. The `BudgetEnforcer` (one instance per session) provides pre-flight atomic reservations:

```ts
import { BudgetEnforcer } from 'adonis-ai-kit/budget'

const enforcer = new BudgetEnforcer({
  perSessionMaxCostUsd: 5.0,     // Max $5 for this session
  perSessionMaxTokens: 250_000,
  perAgentMaxTokens: 50_000,
})

// 1. Reserve tokens atomically for an agent before calling the LLM
const reservation = enforcer.reserve('support-agent', 4_000, 0.05)
if (!reservation) {
  throw new Error('Budget quota exceeded')
}

try {
  const result = await ai.generateText({ prompt: '...', agentName: 'support-agent' })

  // 2. Settle with actual usage
  enforcer.settle(reservation, result.usage.totalTokens, result.costUsd ?? 0)
} catch (error) {
  // 3. Release reserved capacity if call failed
  enforcer.release(reservation)
  throw error
}
```

A call may proceed while `used + reserved + projected` stays strictly below the limit. Defaults: 50,000 tokens per agent, 200,000 per session, no cost limit.

### Live Catalog Discovery (`models.dev`) {#live-catalog-discovery-models-dev}

The kit integrates with **models.dev** to pull model pricing and limits.

- Cached in memory and on disk (`catalog.cachePath`), written atomically, and refreshed after `catalog.ttlMs` (default 24 hours).
- When the network fails, a stale cache is used, else a built-in fallback catalog.
- `ai.resolveModel('openai/gpt-6-sol')` resolves a model reference against the catalog; a `CatalogModelResolver` resolves string entries of `models` chains.

---

## SRE Resilience & Failover

### Cascading Multi-Provider Failover

If your primary provider encounters rate limits (`429`), overload, timeouts or upstream outages (`5xx`), the kit automatically fails over to configured alternatives:

```ts
// config/ai.ts
export default defineConfig({
  default: 'openai',
  providers: { /* openai, anthropic, gemini */ },
  fallbackCascade: ['anthropic', 'gemini'],
  fallbackModels: { anthropic: 'claude-sonnet-5-5' }, // optional, else the provider's defaultModel
})
```

If OpenAI fails, the request is retried on Anthropic with its configured model, then on Gemini. Set `maxRetries: 0` on a call to skip the AI SDK's own retries and fail over sooner.

### Circuit Breaker (Per `provider:model`) {#circuit-breaker-per-provider-model}

To avoid flooding a failing provider with requests, the kit maintains an isolated circuit breaker for each `provider:model` pair (in `models` chains, for each `credentialKey`):

```ts
circuitBreaker: {
  failureThreshold: 5,        // Open circuit after 5 consecutive failures
  recoveryTimeoutMs: 30_000,  // Wait 30s before attempting recovery
  halfOpenMaxAttempts: 2,     // Require 2 successful probe requests to close circuit
  halfOpenMaxConcurrent: 1,   // Probes allowed in flight while half-open
  onStateChange: (key, from, to) => logger.warn(`${key}: ${from} -> ${to}`),
}
```

- When open, requests skip that candidate and move to the next one without a network call.
- Separate keys ensure that a failure in `openai:gpt-6-sol` does not open the breaker of another OpenAI model.

### Fail-Closed Side-Effect Protection

> [!IMPORTANT]
> A critical difference between `adonis-ai-kit` and naive retry loops: **Failover is refused once a side effect may have occurred.**

Failover is refused:
1. After any local tool has already executed.
2. After a provider-executed tool call (e.g. server-side web search) has been made.
3. After a retryable failure of an ACP coding agent (its call may have run tools inside the agent): it throws `AcpCallFailedError`, so an ACP timeout does not switch to another model.

A failure after a tool has executed throws the attempt's own error to prevent duplicate real-world actions (such as sending duplicate emails or re-charging credit cards). This applies to `AiManager` and `runModelChain`; direct AI SDK calls need `attemptSideEffectHooks`.

### Error Taxonomy & Retry Policies

The error classifier categorizes provider exceptions:

- **Retryable / Failover Eligible:** `429` rate limit, `409` / `425` / `529` overloaded, `408` timeout, `5xx` server errors, network errors, and "no output generated".
- **Fail-Fast (No Failover):** `400` invalid request, `401` / `403` auth errors, `404` model not found, and caller aborts (`abortSignal`, `stream.abort()`).
- **Context Limit (`prompt_too_long`):** Advances to the next model without counting against the circuit breaker.
- **Exhausted Fallbacks:** When every candidate fails with a retryable error, or its breaker is open, the call throws `CascadingFallbackError` (`E_AI_FALLBACK_FAILED`). Its `attempts` array lists each provider, model and error. A non-retryable error is thrown as it is, without trying the next candidate.

---

## Testing

### Fakes & Test Doubles

The `adonis-ai-kit/testing` module replaces the model, not the manager, so fallback, the circuit breaker, guards and cost tracking run for real, without network calls or API credits:

```ts
// tests/unit/chat_test.spec.ts
import { test } from '@japa/runner'
import { fakeModel, fakeProvider, fakeTools } from 'adonis-ai-kit/testing'
import { AiManager, defineConfig } from 'adonis-ai-kit'

test.group('Chat bot', () => {
  test('executes tool and answers question', async ({ assert }) => {
    // 1. Script mock responses (one entry per model call)
    const model = fakeModel([
      { toolCalls: [{ name: 'lookupUser', input: { id: '42' } }] },
      { text: 'User 42 is Alice.', usage: { input: 100, output: 20 } },
    ])

    const tools = fakeTools({
      lookupUser: () => ({ name: 'Alice', id: '42' }),
    })

    const manager = new AiManager(
      defineConfig({
        default: 'mock',
        providers: { mock: fakeProvider(model) },
      })
    )

    const response = await manager.generateText({
      prompt: 'Who is user 42?',
      tools: tools.tools,
      maxSteps: 2,
    })

    assert.equal(response.text, 'User 42 is Alice.')
    tools.assertToolCalled('lookupUser', { id: '42' })
    model.assertCalledTimes(2)
  })
})
```

- A script entry is a `FakeStep` (`text`, `toolCalls`, `object`, `usage`, `finishReason`, `error`) or a function of the call. An exhausted script throws `FakeScriptExhaustedError`.
- Usage defaults to 10 input and 10 output tokens (`usage: { input, output, cacheRead, cacheWrite, reasoning }`).
- Model assertions: `calls`, `assertCalledTimes`, `assertPromptContains`, `assertToolOffered`, `assertToolNotOffered`, `assertProviderOption`. Tool assertions: `inputs`, `assertToolCalled(name, match?)`, `assertToolNotCalled`.
- `fakeLanguageModels({ 'provider/model': model })` and `fakeResolver()` cover `models` chains.

### Simulating Provider Outages

Verify your fallback configuration with `fakeApiError(status)`, which is classified like a provider error:

```ts
import { fakeModel, fakeProvider, fakeApiError } from 'adonis-ai-kit/testing'

test('falls back to secondary provider on 429', async ({ assert }) => {
  const primary = fakeModel([{ error: fakeApiError(429) }])
  const fallback = fakeModel([{ text: 'Fallback response' }])

  const manager = new AiManager(
    defineConfig({
      default: 'primary',
      providers: {
        primary: fakeProvider(primary),
        fallback: fakeProvider(fallback),
      },
      fallbackCascade: ['fallback'],
    })
  )

  // maxRetries: 0 stops the AI SDK from retrying the 429 on the same model
  const response = await manager.generateText({ prompt: 'Hello', maxRetries: 0 })
  assert.equal(response.text, 'Fallback response')
})
```

### Testing Custom Conversation Stores

If you write a custom `ConversationStore` adapter, run the standard contract test suite:

```ts
import { test } from '@japa/runner'
import { conversationStoreContract } from 'adonis-ai-kit/testing'
import { MyCustomStore } from '#services/my_custom_store'

for (const check of conversationStoreContract(() => new MyCustomStore())) {
  test(`store contract: ${check.name}`, () => check.run())
}
```

---

## Ace CLI Commands

`adonis-ai-kit` provides first-party commands for the AdonisJS **Ace CLI**:

### `ai:test` {#ai-test}

Send a short prompt to every configured provider and report latency, circuit breaker state and cost:

```bash
node ace ai:test
node ace ai:test --provider=anthropic --model=claude-sonnet-5-5 --prompt="Say PONG"
```

The table has the columns `Provider`, `Model`, `Status` (`✔ OK`, `⚠ FALLBACK (<provider>)` when another provider answered, or `✖ FAILED`), `Latency`, `Circuit Breaker` and `Cost ($)`, followed by the total session cost and tokens.

### `make:ai-agent` {#make-ai-agent}

Scaffold a typed agent class in `app/ai/agents/`:

```bash
node ace make:ai-agent CodeReviewer --provider=anthropic --model=claude-sonnet-5-5 --max-tokens=4096
```

Creates `app/ai/agents/code_reviewer_agent.ts` with a `CodeReviewerAgent` class (agent name `codereviewer-agent`), a system prompt, and `run()` / `stream()` methods that call `ai.generateText()` / `ai.streamText()` with the provider, model and `maxOutputTokens` (default 2048). The file default-exports an instance. An existing file is not overwritten.
