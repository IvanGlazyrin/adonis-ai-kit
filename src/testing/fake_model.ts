import { APICallError } from 'ai'
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'
import { isDeepStrictEqual } from 'node:util'

/** One tool call the fake model makes. Its `execute` runs in the AI SDK loop, so pass the tool via `fakeTools()`. */
export interface FakeToolCall {
  name: string
  input?: unknown
  /** Tool call id; generated when omitted. */
  id?: string
}

/**
 * Token usage of one call. Defaults to 10 input and 10 output tokens. `input` includes `cacheRead` and
 * `cacheWrite`; `output` includes `reasoning`, as in the AI SDK.
 */
export interface FakeUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
}

/** What the fake model answers for one call. */
export interface FakeStep {
  /** Text answer. */
  text?: string
  /** Tool calls the model makes in this answer. */
  toolCalls?: FakeToolCall[]
  /** Structured answer, sent as JSON text (for calls with `schema`). Replaces `text`. */
  object?: unknown
  /** Usage of this call. */
  usage?: FakeUsage
  finishReason?: 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'other'
  /**
   * Thrown before any output, from `doGenerate` and `doStream` alike, so a fallback sees it as a failed
   * attempt. Use `fakeApiError()` for HTTP-style failures.
   */
  error?: unknown
}

/** One entry of a script: a fixed answer, or a function that sees the call and answers from it. */
export type FakeScriptEntry = FakeStep | ((call: FakeCall) => FakeStep)

/** A call the fake model received. */
export interface FakeCall {
  /** `generate` for `doGenerate`, `stream` for `doStream`. */
  mode: 'generate' | 'stream'
  /** Prompt messages sent to the model, system prompt included. */
  prompt: ReadonlyArray<{ role: string; content?: unknown; providerOptions?: unknown }>
  /** Names of the tools offered to the model in this call (after `deny` permissions were applied). */
  toolNames: string[]
  /** Provider options of the call (`providerOptions` of the AI SDK call). */
  providerOptions?: Record<string, unknown>
  /** The raw call options, for anything the helpers do not cover. */
  options: CallOptions
}

type CallOptions = Parameters<MockLanguageModelV4['doGenerate']>[0]
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>
type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = StreamResult extends { stream: ReadableStream<infer P> } ? P : never

/** The script ran out of answers. Thrown on the call after the last entry; fail-closed by design. */
export class FakeScriptExhaustedError extends Error {
  constructor(detail: string) {
    super(`fake model script is exhausted (${detail}); add an entry for this call`)
    this.name = 'FakeScriptExhaustedError'
  }
}

/** An assertion on a fake model or fake tools did not hold. */
export class FakeAssertionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FakeAssertionError'
  }
}

/** Assertions on what a fake model received. */
export interface FakeModelAssertions {
  /** Every call so far, in order, generate and stream alike. */
  readonly calls: readonly FakeCall[]
  /** Fails unless the model received exactly `times` calls. */
  assertCalledTimes(times: number): void
  /** Fails unless some call's prompt contains `text` (as a substring of its JSON). */
  assertPromptContains(text: string): void
  /** Fails unless some call offered the tool `name`. */
  assertToolOffered(name: string): void
  /** Fails if any call offered the tool `name` (for example one denied by `toolPermissions`). */
  assertToolNotOffered(name: string): void
  /**
   * Fails unless some call carries `value` at `path` (dot-separated) in its provider options, in a prompt
   * message's `providerOptions`, or in a tool's `providerOptions`. Used for prompt-cache markers.
   */
  assertProviderOption(path: string, value: unknown): void
}

/** A fake `LanguageModel` for tests: scripted answers, recorded calls, assertions. */
export type FakeModel = MockLanguageModelV4 & FakeModelAssertions

/**
 * A language model that answers from `script`, one entry per call, in both `doGenerate` and `doStream`.
 * The default `provider` is `fake` and the default `modelId` is `fake-model`.
 */
export function fakeModel(
  script: FakeScriptEntry[],
  options: { provider?: string; modelId?: string } = {}
): FakeModel {
  const calls: FakeCall[] = []
  let next = 0

  const answer = (mode: FakeCall['mode'], callOptions: CallOptions): FakeStep => {
    const call = toFakeCall(mode, callOptions)
    calls.push(call)
    if (next >= script.length) {
      throw new FakeScriptExhaustedError(`call ${calls.length}, script has ${script.length} entries`)
    }
    const entry = script[next++]
    return typeof entry === 'function' ? entry(call) : entry
  }

  const mock = new MockLanguageModelV4({
    provider: options.provider ?? 'fake',
    modelId: options.modelId ?? 'fake-model',
    doGenerate: async (callOptions) => {
      const step = answer('generate', callOptions)
      if (step.error !== undefined) throw step.error
      return generateResult(step, calls.length)
    },
    doStream: async (callOptions) => {
      const step = answer('stream', callOptions)
      if (step.error !== undefined) throw step.error
      return { stream: convertArrayToReadableStream(streamParts(step, calls.length)) } as StreamResult
    },
  })

  return Object.assign(mock, {
    calls: calls as readonly FakeCall[],
    assertCalledTimes(times: number) {
      if (calls.length !== times) {
        throw new FakeAssertionError(`expected ${times} calls, got ${calls.length}`)
      }
    },
    assertPromptContains(text: string) {
      if (!calls.some((call) => JSON.stringify(call.prompt).includes(text))) {
        throw new FakeAssertionError(`no call's prompt contains ${JSON.stringify(text)}`)
      }
    },
    assertToolOffered(name: string) {
      if (!calls.some((call) => call.toolNames.includes(name))) {
        throw new FakeAssertionError(`tool "${name}" was never offered to the model`)
      }
    },
    assertToolNotOffered(name: string) {
      if (calls.some((call) => call.toolNames.includes(name))) {
        throw new FakeAssertionError(`tool "${name}" was offered to the model, expected it not to be`)
      }
    },
    assertProviderOption(path: string, value: unknown) {
      const segments = path.split('.')
      const found = calls.some((call) => providerOptionRoots(call.options).some((root) => {
        const at = valueAt(root, segments)
        return at.found && isDeepStrictEqual(at.value, value)
      }))
      if (!found) {
        throw new FakeAssertionError(`no call has ${path} = ${JSON.stringify(value)} in its provider options`)
      }
    },
  }) satisfies FakeModelAssertions
}

/** Fake answers a `FakeStep` can name, as an `APICallError` that the error classifier understands. */
export function fakeApiError(statusCode: number, message = `fake provider error ${statusCode}`): APICallError {
  const retryable = statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500
  return new APICallError({
    message,
    url: 'https://fake.invalid/v1/chat',
    requestBodyValues: {},
    statusCode,
    isRetryable: retryable,
  })
}

function toFakeCall(mode: FakeCall['mode'], options: CallOptions): FakeCall {
  return {
    mode,
    prompt: options.prompt as FakeCall['prompt'],
    toolNames: (options.tools ?? []).map((tool) => tool.name),
    providerOptions: options.providerOptions as Record<string, unknown> | undefined,
    options,
  }
}

/** Every object that may carry provider options in one call: the call itself, its messages and its tools. */
function providerOptionRoots(options: CallOptions): unknown[] {
  return [
    options.providerOptions,
    ...options.prompt.map((message) => (message as { providerOptions?: unknown }).providerOptions),
    ...(options.tools ?? []).map((tool) => (tool as { providerOptions?: unknown }).providerOptions),
  ]
}

function valueAt(root: unknown, segments: string[]): { found: boolean; value?: unknown } {
  let current: unknown = root
  for (const segment of segments) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
      return { found: false }
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return { found: true, value: current }
}

/** Text the step answers with: the structured object as JSON when one is set, else `text`. */
function answerText(step: FakeStep): string | undefined {
  return step.object !== undefined ? JSON.stringify(step.object) : step.text
}

function usageOf(usage: FakeUsage = {}) {
  const input = usage.input ?? 10
  const output = usage.output ?? 10
  const cacheRead = usage.cacheRead ?? 0
  const cacheWrite = usage.cacheWrite ?? 0
  const reasoning = usage.reasoning ?? 0
  return {
    inputTokens: {
      total: input,
      noCache: Math.max(0, input - cacheRead - cacheWrite),
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: output,
      text: Math.max(0, output - reasoning),
      reasoning,
    },
  }
}

function finishReasonOf(step: FakeStep) {
  const unified = step.finishReason ?? (step.toolCalls?.length ? 'tool-calls' : 'stop')
  return { unified, raw: unified }
}

/** Tool call ids: the step's own id, else one derived from the call number, so ids stay unique per call. */
function toolCallIdOf(callNumber: number, index: number, id?: string): string {
  return id ?? `fake-call-${callNumber}-${index}`
}

function generateResult(step: FakeStep, callNumber: number): GenerateResult {
  const content: unknown[] = []
  const text = answerText(step)
  if (text !== undefined) content.push({ type: 'text', text })
  ;(step.toolCalls ?? []).forEach((call, index) => {
    content.push({
      type: 'tool-call',
      toolCallId: toolCallIdOf(callNumber, index, call.id),
      toolName: call.name,
      input: JSON.stringify(call.input ?? {}),
    })
  })
  return {
    content,
    finishReason: finishReasonOf(step),
    usage: usageOf(step.usage),
    warnings: [],
  } as unknown as GenerateResult
}

function streamParts(step: FakeStep, callNumber: number): StreamPart[] {
  const parts: unknown[] = [{ type: 'stream-start', warnings: [] }]
  const text = answerText(step)
  if (text !== undefined) {
    parts.push(
      { type: 'text-start', id: 'text-0' },
      { type: 'text-delta', id: 'text-0', delta: text },
      { type: 'text-end', id: 'text-0' }
    )
  }
  ;(step.toolCalls ?? []).forEach((call, index) => {
    parts.push({
      type: 'tool-call',
      toolCallId: toolCallIdOf(callNumber, index, call.id),
      toolName: call.name,
      input: JSON.stringify(call.input ?? {}),
    })
  })
  parts.push({ type: 'finish', finishReason: finishReasonOf(step), usage: usageOf(step.usage) })
  return parts as StreamPart[]
}
