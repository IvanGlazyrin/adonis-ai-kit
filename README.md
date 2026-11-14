# adonis-ai-kit

An AI toolkit for AdonisJS 7, built on the Vercel AI SDK 7: provider fallback, circuit breakers, a tool registry that denies by default, cost tracking, MCP servers as tools, and ACP coding agents.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![npm](https://img.shields.io/npm/v/adonis-ai-kit.svg)](https://www.npmjs.com/package/adonis-ai-kit)
[![AdonisJS](https://img.shields.io/badge/AdonisJS-7.x-5A45FF.svg)](https://adonisjs.com)
[![Vercel AI SDK](https://img.shields.io/badge/Vercel%20AI%20SDK-v7.x-black.svg)](https://sdk.vercel.ai)
[![Node](https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen.svg)](https://nodejs.org)

## Installation

```bash
node ace add adonis-ai-kit
```

This installs the package and runs its configure hook. The hook registers the provider and the Ace commands in `adonisrc.ts`, adds `OPENAI_API_KEY` to `.env`, validates `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` in `start/env.ts`, and creates `config/ai.ts` (an existing `config/ai.ts` is kept). Install the provider packages you use, for example `npm install @ai-sdk/openai`.

To install by hand, see [docs/guide/installation.md](docs/guide/installation.md). The package is named `adonis-ai-kit` on npm; the `adonis-ai` name belongs to another project.

## Configuration

A minimal `config/ai.ts`. The second provider is the fallback when the first one is rate limited (429) or down (5xx):

```ts
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
  },
  fallbackCascade: ['anthropic'],
})
```

All options are in [docs/guide/configuration.md](docs/guide/configuration.md).

## Generate text

```ts
import ai from 'adonis-ai-kit/services/main'

const result = await ai.generateText({
  prompt: 'Explain vector indexing in 3 sentences',
})

console.log(result.text)
console.log(`Duration: ${result.durationMs}ms, cost: $${result.costUsd ?? 'n/a'}`)
console.log(`Tokens: in=${result.usage.inputTokens}, out=${result.usage.outputTokens}`)
```

`costUsd` is set when pricing for the model is known (the models.dev catalog or `budget.pricing`). Fallback is refused once a side effect may have happened, for example after a local tool has run. See [docs/guide/resilience-and-fallbacks.md](docs/guide/resilience-and-fallbacks.md).

## Stream to the browser

The kit adds a `response.streamAI()` macro to the AdonisJS HTTP response. It sets the Server-Sent Events headers, sends heartbeats, and aborts the model call when the client disconnects:

```ts
import type { HttpContext } from '@adonisjs/core/http'
import ai from 'adonis-ai-kit/services/main'

export default class ChatController {
  async stream({ request, response }: HttpContext) {
    const stream = await ai.streamText({ prompt: request.input('message') })

    return response.streamAI(stream, { mode: 'sse', heartbeatMs: 15_000 })
  }
}
```

The `mode` is `sse` (default), `ui` (AI SDK UI message stream) or `text`. See [docs/guide/streaming.md](docs/guide/streaming.md).

## Features

Each line links to its page in the guide.

- [Text and structured output](docs/guide/text-and-chat.md): `generateText`, `generateObject` with Zod, token usage and cost per call.
- [Streaming](docs/guide/streaming.md): `streamText` and the `response.streamAI()` macro.
- [Conversations](docs/guide/conversations.md): stored history with an owner check and a durable store adapter.
- [Fallback and circuit breakers](docs/guide/resilience-and-fallbacks.md): provider cascade, per-key circuit breakers, no fallback after a side effect.
- [Model chains and credentials](docs/guide/configuration.md#dynamic-multi-tenant-credentials): per-user or per-tenant keys through `models`.
- [Tools and guardrails](docs/guide/tools-guardrails.md): `ToolRegistry` (deny by default), `PolicyGuard`, `allow` / `ask` / `deny`.
- [Human approval](docs/guide/resumable-approvals.md): in-process confirmations, and signed resumable approvals that survive a restart.
- [MCP servers as tools](docs/guide/mcp-tools.md): stdio and HTTP servers, deny by default, pinned tool definitions.
- [ACP coding agents](docs/guide/acp-agents.md): Claude Code, opencode and other agents as child processes with a sanitized environment.
- [Agents and skills](docs/guide/agents.md): Markdown manifests, on-demand skills, sub-agents.
- [Step control and prompt cache](docs/guide/step-control-and-cache.md): `prepareStep`, `stopWhen`, Anthropic cache breakpoints, JSON recovery.
- [Token budget and cost](docs/guide/budget-and-cost.md): `CostTracker`, cost sink, `BudgetEnforcer`, `stopOnBudget`.
- [Model catalog](docs/guide/catalog.md): live pricing and limits from models.dev.
- [Testing](docs/guide/testing.md): `adonis-ai-kit/testing` fakes for models, tools and failures.
- [Ace commands](docs/guide/cli.md): `ai:test` and `make:ai-agent`.

Start with the [introduction](docs/guide/introduction.md), which also compares the kit with Laravel AI and Prism and shows the architecture. A single-page reference is in [docs/ai-sdk.md](docs/ai-sdk.md).

## Testing and development

```bash
git clone https://github.com/IvanGlazyrin/adonis-ai-kit.git
cd adonis-ai-kit
npm install
npm run typecheck
npm test
npm run build
npm run test:regression   # needs the build first
npm run docs:dev          # the documentation site
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

### Release

Pushing a tag that matches `v*` runs `.github/workflows/release.yml`. It builds, runs the typecheck, the unit tests and the regression tests, then runs `npm publish` through npm trusted publishing (OIDC). The workflow needs no `NPM_TOKEN` secret.

```bash
npm version patch        # bumps package.json and creates the v* tag
git push --follow-tags
```

## License

MIT © [Ivan Glazyrin](https://github.com/IvanGlazyrin) (glazrus97@gmail.com)
