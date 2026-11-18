import type { ErrorClass } from '../error_classifier.js'
import type { CircuitBreakerState, TokenUsage } from '../types.js'

/** One tool call of a finished step. `output` is set when the step has the tool's result. */
export interface AiToolCallInfo {
  toolName: string
  toolCallId: string
  input: unknown
  output?: unknown
  /** The model named a tool that does not exist or gave input that does not parse; the tool did not run. */
  invalid: boolean
}

/** Fields every event of one call carries. */
interface CallRef {
  /** Unique per call (`generateText`, `streamText`, `generateObject`, or a resumed approval step). */
  callId: string
  agentName: string
}

/**
 * The lifecycle of a call. Every `call:started` is followed by exactly one `call:completed` or `call:failed`.
 * In between come one `attempt:started` per model tried, `step:finished` per finished step, and `fallback` each time
 * the call moves on to another model.
 */
export type AiEvent =
  | (CallRef & {
      type: 'call:started'
      kind: 'text' | 'stream' | 'object'
      metadata?: Record<string, unknown>
      at: number
    })
  | (CallRef & { type: 'attempt:started'; provider: string; model: string; breakerKey: string })
  | (CallRef & {
      type: 'step:finished'
      provider: string
      model: string
      /** 0 for the first step of the attempt. */
      stepNumber: number
      toolCalls: AiToolCallInfo[]
      usage: TokenUsage
      finishReason: string
    })
  | (CallRef & {
      type: 'fallback'
      /** Breaker key of the model that failed. */
      from: string
      /** The next model: its breaker key in a `models` chain, the provider name in the provider cascade. */
      to: string
      errorClass: ErrorClass
    })
  | (CallRef & {
      type: 'call:completed'
      provider: string
      model: string
      usage: TokenUsage
      costUsd?: number
      durationMs: number
      finishReason: string
      status: 'completed' | 'awaiting-approval'
    })
  | (CallRef & {
      type: 'call:failed'
      errorClass: ErrorClass
      message: string
      durationMs: number
    })
  | { type: 'breaker:state'; key: string; from: CircuitBreakerState; to: CircuitBreakerState }

export type AiEventType = AiEvent['type']

/** Receives events. An error it throws, or a promise it rejects, is logged and never fails the call. */
export interface AiObserver {
  emit(event: AiEvent): void | Promise<void>
}
