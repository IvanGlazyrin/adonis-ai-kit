import { test } from '@japa/runner'
import { HttpResponse } from '@adonisjs/core/http'
import { registerResponseMacro } from '../../src/response_macro.js'
import type { StreamTextResult } from '../../src/types.js'

registerResponseMacro()

/** The HttpResponse surface the macro uses, recorded so the tests can see what was written. */
const fakeResponse = (headersSent = false) => {
  const listeners: Record<string, Array<() => void>> = {}
  const headers: Record<string, string> = {}
  const state = { status: 0, body: null as any, sent: undefined as unknown, headers, closeFns: listeners }
  const res = {
    headersSent,
    writableFinished: false,
    on(event: string, fn: () => void) {
      ;(listeners[event] ??= []).push(fn)
    },
  }
  const ctx = {
    response: res,
    header(key: string, value: string) {
      headers[key.toLowerCase()] = value
    },
    status(code: number) {
      state.status = code
    },
    stream(body: unknown) {
      state.body = body
    },
    send(body: unknown) {
      state.sent = body
    },
  }
  return { ctx, state, emitClose: () => (listeners.close ?? []).forEach((fn) => fn()) }
}

/** A stand-in for StreamTextResult with a fixed text stream and optional failure. */
const streamOf = (chunks: string[], opts: { fail?: Error; abort?: (r?: unknown) => void } = {}) => {
  const textStream = (async function* () {
    for (const c of chunks) yield c
    if (opts.fail) throw opts.fail
  })()
  return {
    textStream,
    abort: opts.abort,
    toUIMessageStreamResponse: () =>
      new Response('ui-payload', { status: 200, headers: { 'x-ui': 'yes' } }),
  } as unknown as StreamTextResult
}

/** Drains the readable the macro handed to response.stream(). */
const drain = async (body: AsyncIterable<unknown>) => {
  let out = ''
  for await (const part of body) out += typeof part === 'string' ? part : Buffer.from(part as Uint8Array).toString()
  return out
}

const stream = (ctx: any, streamResult: StreamTextResult, options?: any) =>
  (HttpResponse.prototype as any).streamAI.call(ctx, streamResult, options)

test.group('response.streamAI macro', () => {
  test('sse mode sends event frames and a DONE marker, then reports the full text', async ({ assert }) => {
    const { ctx, state } = fakeResponse()
    const finished: string[] = []

    stream(ctx, streamOf(['Hel', 'lo']), { onFinish: (t: string) => finished.push(t), heartbeatMs: 0 })

    assert.equal(state.status, 200)
    assert.equal(state.headers['content-type'], 'text/event-stream')
    assert.equal(state.headers['cache-control'], 'no-cache, no-transform')
    const body = await drain(state.body)
    assert.include(body, 'event: message\ndata: {"type":"chunk","text":"Hel"}\n\n')
    assert.include(body, 'event: message\ndata: {"type":"chunk","text":"lo"}\n\n')
    assert.isTrue(body.endsWith('data: [DONE]\n\n'))
    assert.deepEqual(finished, ['Hello'])
  })

  test('the event name and extra headers come from the options', async ({ assert }) => {
    const { ctx, state } = fakeResponse()
    stream(ctx, streamOf(['x']), { event: 'token', headers: { 'X-Trace': 'abc' }, heartbeatMs: 0 })

    const body = await drain(state.body)
    assert.include(body, 'event: token\n')
    assert.equal(state.headers['x-trace'], 'abc')
  })

  test('text mode writes plain chunks with a text content type and no event frames', async ({ assert }) => {
    const { ctx, state } = fakeResponse()
    stream(ctx, streamOf(['one ', 'two']), { mode: 'text' })

    assert.equal(state.headers['content-type'], 'text/plain; charset=utf-8')
    assert.equal(await drain(state.body), 'one two')
  })

  test('ui mode hands over the SDK response status, headers and body', async ({ assert }) => {
    const { ctx, state } = fakeResponse()
    stream(ctx, streamOf([]), { mode: 'ui' })

    assert.equal(state.status, 200)
    assert.equal(state.headers['x-ui'], 'yes')
    assert.equal(await drain(state.body), 'ui-payload')
  })

  test('a stream failure is sent as an error event with a generic message by default', async ({ assert }) => {
    const { ctx, state } = fakeResponse()
    const errors: Error[] = []

    stream(ctx, streamOf(['a'], { fail: new Error('secret detail') }), {
      onError: (e: Error) => errors.push(e),
      heartbeatMs: 0,
    })

    const body = await drain(state.body)
    assert.include(body, 'event: error\ndata: {"error":"Stream failed"}\n\n')
    assert.notInclude(body, 'secret detail')
    assert.equal(errors[0]?.message, 'secret detail')
  })

  test('exposeErrors reveals the failure message to the client', async ({ assert }) => {
    const { ctx, state } = fakeResponse()
    stream(ctx, streamOf([], { fail: new Error('visible') }), { exposeErrors: true, heartbeatMs: 0 })

    assert.include(await drain(state.body), 'data: {"error":"visible"}')
  })

  test('a client disconnect aborts the generation once', async ({ assert }) => {
    const { ctx, emitClose } = fakeResponse()
    const reasons: unknown[] = []

    stream(ctx, streamOf([], { abort: (r) => reasons.push(r) }), { heartbeatMs: 0 })
    emitClose()
    emitClose()

    assert.deepEqual(reasons, ['client disconnected'])
  })

  test('a response that already finished is not aborted on close', async ({ assert }) => {
    const { ctx, emitClose } = fakeResponse()
    ;(ctx.response as any).writableFinished = true
    const reasons: unknown[] = []

    stream(ctx, streamOf([], { abort: (r) => reasons.push(r) }), { heartbeatMs: 0 })
    emitClose()

    assert.deepEqual(reasons, [])
  })

  test('when headers were already sent the macro does nothing', async ({ assert }) => {
    const { ctx, state } = fakeResponse(true)
    stream(ctx, streamOf(['x']), { heartbeatMs: 0 })

    assert.equal(state.status, 0)
    assert.isNull(state.body)
  })
})
