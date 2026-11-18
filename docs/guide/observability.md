# Events & Observability

Every `generateText`, `streamText` and `generateObject` call reports what happens to it as events: when it starts, each
model it tries, each step of its tool loop, each fallback, and how it ends.

## The events

| Event | When | Main fields |
| :--- | :--- | :--- |
| `call:started` | The call begins | `kind` (`text`, `stream`, `object`), `metadata`, `at` |
| `attempt:started` | A model is tried | `provider`, `model`, `breakerKey` |
| `step:finished` | A step of the tool loop ends | `stepNumber` (from 0 per attempt), `toolCalls`, `usage`, `finishReason` |
| `fallback` | The call moves on to another model | `from` (breaker key), `to`, `errorClass` |
| `call:completed` | The call ended with an answer | `provider`, `model`, `usage`, `costUsd`, `durationMs`, `status` |
| `call:failed` | The call ended with an error | `errorClass`, `message`, `durationMs` |
| `breaker:state` | A circuit breaker changed state | `key`, `from`, `to` |

Every event of a call carries the same `callId` and the `agentName`. A `call:started` is always followed by exactly one
`call:completed` or `call:failed`, also when the call is refused before a model is called (for example an invalid
argument). A stream reports its end when it ends: after it is consumed, fails or is aborted. A stream that nobody reads
does not end. `breaker:state` is not tied to a call and is sent only when the manager built its own breaker.

`toolCalls` lists each tool call of the step with its `input`, its `output` when the step has it, and `invalid: true`
when the model named an unknown tool or gave input that does not parse (that tool did not run).

## In an AdonisJS app

The service provider forwards every event to the AdonisJS emitter as `ai:<type>`. The names are typed:

```ts
// start/events.ts
import emitter from '@adonisjs/core/services/emitter'

emitter.on('ai:call:completed', (event) => {
  logger.info({ agent: event.agentName, model: event.model, costUsd: event.costUsd }, 'ai call')
})

emitter.on('ai:fallback', (event) => {
  logger.warn(`${event.from} -> ${event.to} (${event.errorClass})`)
})
```

## Per call

`onEvent` receives the events of one call, for example to stream progress to the browser:

```ts
await ai.generateText({
  prompt,
  tools,
  onEvent: (event) => {
    if (event.type === 'step:finished') sendProgress(event.toolCalls.map((call) => call.toolName))
  },
})
```

A handler that throws or returns a rejected promise is logged with `warn` and never fails the call.

## Outside AdonisJS

Pass an `observer` to the manager. `emitterObserver(emitter)` adapts anything with `emit(name, payload)`, such as a Node
`EventEmitter`:

```ts
import { EventEmitter } from 'node:events'
import { AiManager, emitterObserver } from 'adonis-ai-kit/core'

const bus = new EventEmitter()
const ai = new AiManager(config, { observer: emitterObserver(bus) })
bus.on('ai:call:failed', (event) => alert(event))
```

## Buffering until a consumer exists

`EventBuffer` (from `adonis-ai-kit/events`) keeps events in a bounded queue until a sink is attached, then hands them over
in order. When the queue is full (`maxQueueSize`, default 1000) the oldest event is dropped and a warning is logged. It
also counts events by type.

```ts
import { EventBuffer } from 'adonis-ai-kit/events'

const buffer = new EventBuffer<AiEvent>({ logger })
const ai = new AiManager(config, { observer: buffer })
// later, once the transport is ready
buffer.attachSink({ emit: (event) => transport.send(event) })
buffer.getCount('call:failed')
```

## AI SDK telemetry

`telemetry` on a call is passed to the AI SDK as is, for OpenTelemetry tracing:

```ts
await ai.generateText({ prompt, telemetry: { isEnabled: true, functionId: 'support-reply' } })
```
