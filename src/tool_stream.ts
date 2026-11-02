/** Whether a tool's result is an async iterable, such as the stream of an `async function*` tool. */
export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === 'object' && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
}

/**
 * The value of a tool's `execute` call, from the value `execute` returned. The AI SDK treats only a return value that is
 * an async iterable itself (an `async function*`) as a stream; an `async` function returns a Promise, whose result is
 * never iterated. So a stream is drained only when the call returned one synchronously, and a Promise is awaited as it is.
 */
export async function resultOf(returned: unknown): Promise<unknown> {
  return isAsyncIterable(returned) ? finalValueOf(returned) : await returned
}

/**
 * The value a tool gives the model. A wrapper that awaits `execute` cannot pass a stream on, so the stream runs to its
 * end and its last chunk is the value. The intermediate chunks are not shown when a wrapper is in between.
 */
export async function finalValueOf(result: unknown): Promise<unknown> {
  if (!isAsyncIterable(result)) return result
  let last: unknown
  for await (const chunk of result) last = chunk
  return last
}
