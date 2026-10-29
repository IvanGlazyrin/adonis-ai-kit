import { Readable } from 'node:stream'
import { HttpResponse } from '@adonisjs/core/http'
import type { StreamAIOptions, StreamTextResult } from './types.js'

const DEFAULT_HEARTBEAT_MS = 15_000

/** Headers for a plain or SSE body; the UI mode takes its headers from the SDK response. */
function streamHeaders(mode: 'sse' | 'text'): Record<string, string> {
  if (mode === 'sse') {
    return {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    }
  }
  return {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  }
}

/** AI SDK UI message stream: hand over the SDK's own protocol, compatible with `useChat`. */
function pipeUiStream(
  response: HttpResponse,
  streamResult: StreamTextResult,
  setHeaders: (headers: Record<string, string>) => void,
  abortGeneration: () => void
): void {
  const uiResponse = streamResult.toUIMessageStreamResponse()
  const headers: Record<string, string> = {}
  uiResponse.headers.forEach((value, key) => {
    headers[key] = value
  })
  setHeaders(headers)
  response.status(uiResponse.status)
  if (!uiResponse.body) {
    response.send('')
    return
  }
  const body = Readable.fromWeb(uiResponse.body as import('node:stream/web').ReadableStream)
  body.on('close', () => {
    if (!body.readableEnded) abortGeneration()
  })
  response.stream(body)
}

/**
 * Registers the response.streamAI macro on the AdonisJS HttpResponse class.
 * Streams LLM output to React/Inertia clients via Server-Sent Events, the AI SDK UI message
 * stream (`useChat`), or raw text.
 *
 * Headers are set through `response.header()` so CORS/cookie headers set by middleware survive,
 * the body goes through `response.stream()`, and a client disconnect aborts the LLM call.
 */
export function registerResponseMacro() {
  HttpResponse.macro('streamAI', function (
    this: HttpResponse,
    streamResult: StreamTextResult,
    options: StreamAIOptions = {}
  ) {
    const res = this.response

    if (res.headersSent) {
      return
    }

    const mode = options.mode ?? 'sse'
    const eventName = options.event ?? 'message'
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS

    const setHeaders = (headers: Record<string, string>) => {
      for (const [key, value] of Object.entries({ ...headers, ...(options.headers ?? {}) })) {
        this.header(key, value)
      }
    }

    let aborted = false
    const abortGeneration = () => {
      if (aborted) return
      aborted = true
      streamResult.abort?.('client disconnected')
    }

    // The client went away (or the response finished): stop spending tokens.
    res.on('close', () => {
      if (!res.writableFinished) abortGeneration()
    })

    // AI SDK UI message stream: hand over the SDK's own protocol, compatible with `useChat`.
    if (mode === 'ui') {
      pipeUiStream(this, streamResult, setHeaders, abortGeneration)
      return
    }

    setHeaders(streamHeaders(mode))
    this.status(200)

    let waiter: (() => void) | null = null
    const out = new Readable({
      read() {
        const resume = waiter
        waiter = null
        resume?.()
      },
      destroy(err, callback) {
        abortGeneration()
        const resume = waiter
        waiter = null
        resume?.()
        callback(err)
      },
    })

    /** Pushes a frame, waiting for the consumer when its buffer is full (backpressure). */
    const write = async (frame: string): Promise<void> => {
      if (out.destroyed) return
      if (!out.push(frame)) {
        await new Promise<void>((resolve) => {
          waiter = resolve
        })
      }
    }

    let heartbeat: ReturnType<typeof setInterval> | undefined
    if (mode === 'sse' && heartbeatMs > 0) {
      heartbeat = setInterval(() => {
        if (!out.destroyed) out.push(': ping\n\n')
      }, heartbeatMs)
      heartbeat.unref?.()
    }

    ;(async () => {
      let fullText = ''
      try {
        for await (const chunk of streamResult.textStream) {
          if (out.destroyed) break

          fullText += chunk
          options.onChunk?.(chunk)

          if (mode === 'sse') {
            const data = JSON.stringify({ type: 'chunk', text: chunk })
            await write(`event: ${eventName}\ndata: ${data}\n\n`)
          } else {
            await write(chunk)
          }
        }

        if (!out.destroyed) {
          if (mode === 'sse') {
            await write('data: [DONE]\n\n')
          }
          options.onFinish?.(fullText)
        }
      } catch (err) {
        if (!out.destroyed) {
          const error = err instanceof Error ? err : new Error(String(err))
          options.onError?.(error)
          if (mode === 'sse') {
            const message = options.exposeErrors ? error.message : 'Stream failed'
            await write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`)
          }
        }
      } finally {
        if (heartbeat) clearInterval(heartbeat)
        out.push(null)
      }
    })()

    this.stream(out)
  })
}

// Module augmentations so TypeScript recognizes response.streamAI
declare module '@adonisjs/core/http' {
  interface HttpResponse {
    streamAI(streamResult: StreamTextResult, options?: StreamAIOptions): void
  }
}
