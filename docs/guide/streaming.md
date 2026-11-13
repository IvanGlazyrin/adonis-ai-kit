# Streaming & SSE Macro

## Basic Streaming

Streaming tokens as they arrive delivers an instantaneous, responsive user interface:

```ts
import ai from 'adonis-ai-kit/services/main'

const stream = await ai.streamText({
  prompt: 'Generate a guide on building REST APIs with AdonisJS.',
})

for await (const chunk of stream.textStream) {
  process.stdout.write(chunk)
}
```

`streamText` also accepts `onChunk(chunk)`, called for every text delta, and `onFinish({ text, usage, costUsd })`, called when the stream ends normally.

---

## AdonisJS SSE Macro (`response.streamAI`) {#adonisjs-sse-macro-response-streamai}

The kit registers an idiomatic HTTP response macro directly on the AdonisJS `HttpContext.response`:

```ts
// app/controllers/assistant_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import ai from 'adonis-ai-kit/services/main'

export default class AssistantController {
  async ask({ request, response }: HttpContext) {
    const stream = await ai.streamText({
      system: 'You are an AdonisJS assistant.',
      prompt: request.input('question'),
    })

    // Returns a standards-compliant Server-Sent Events stream
    return response.streamAI(stream, {
      mode: 'sse',
      heartbeatMs: 15_000,
    })
  }
}
```

### Modes

- **`sse`** (default): Server-Sent Events, one frame per text delta: `event: message` (or `options.event`) with `data: {"type":"chunk","text":"..."}`.
- **`ui`**: the AI SDK UI message stream (use with `useChat`), including tool parts.
- **`text`**: raw text chunks (`Content-Type: text/plain; charset=utf-8`).

### SSE Protocol Features

1. **Headers Managed Automatically** (set through `response.header()`, so CORS and cookie headers from middleware are kept; `options.headers` adds or overrides):
   ```http
   Content-Type: text/event-stream
   Cache-Control: no-cache, no-transform
   Connection: keep-alive
   X-Accel-Buffering: no
   ```
2. **Heartbeat Keepalive Frames:** Sends `: ping` comments every `heartbeatMs` (default 15000, `0` disables) so load balancers (e.g. AWS ALB, Cloudflare, NGINX) do not close idle connections during long reasoning steps.
3. **Completion Marker:** Emits `data: [DONE]` when the stream finishes.
4. **Error Frame:** A failed stream sends `event: error` with `{"error":"Stream failed"}`; the real message only with `exposeErrors: true`. `onChunk`, `onFinish(fullText)` and `onError(error)` callbacks are available.

---

## Client Disconnect & Instant Abort Detection

Continuing to generate tokens after a user navigates away or closes their browser wastes money and server throughput.

The `response.streamAI()` macro listens for the `close` event of the Node.js response. When it closes before the response finished:
1. `stream.abort('client disconnected')` is called.
2. The request to the LLM provider (OpenAI, Anthropic, etc.) is cancelled, so no further tokens are generated.
3. An aborted stream is not stored in a conversation.

---

## Structured Streaming with Tools

`schema`, `stopWhen`, `maxRetries` and `onStepFinish` work for `streamText` too:

```ts
import { stepCountIs } from 'ai'
import { z } from 'zod'

const stream = await ai.streamText({
  prompt: 'Find the cheapest flight and summarise it.',
  tools: { searchFlights },
  schema: z.object({ airline: z.string(), priceUsd: z.number() }),
  stopWhen: stepCountIs(6), // takes precedence over `maxSteps`
})

for await (const part of stream.fullStream) {
  // forward parts to the client...
}
const flight = await stream.output // parsed against the schema
```

`streamText` falls back to another model only on errors before the first chunk.
