import { randomUUID } from 'node:crypto'
import { classifyErrorClass } from './error_classifier.js'
import type { AiEvent, AiObserver } from './events/types.js'
import type { Logger } from './logger.js'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A call event without the fields the call fills in. */
export type CallEventBody = DistributiveOmit<Exclude<AiEvent, { type: 'breaker:state' }>, 'callId' | 'agentName'>

type EventSinkFn = (event: AiEvent) => unknown

/** Hands `event` to every sink. A throw or a rejected promise is logged and never reaches the caller. */
export function deliverEvent(event: AiEvent, sinks: Array<EventSinkFn | undefined>, logger?: Logger): void {
  for (const sink of sinks) {
    if (!sink) continue
    try {
      const pending = sink(event)
      if (pending && typeof (pending as PromiseLike<unknown>).then === 'function') {
        Promise.resolve(pending).catch((err: unknown) => logger?.warn(`[AiManager] Event handler failed for ${event.type}: ${String(err)}`))
      }
    } catch (err) {
      logger?.warn(`[AiManager] Event handler failed for ${event.type}: ${String(err)}`)
    }
  }
}

/** The observer as a sink function, or `undefined` without one. */
export function observerSink(observer: AiObserver | undefined): EventSinkFn | undefined {
  return observer ? (event) => observer.emit(event) : undefined
}

/**
 * The events of one call. Stamps each event with the call's id and agent name, and makes sure the call ends with
 * exactly one `call:completed` or `call:failed`.
 */
export class CallEvents {
  readonly callId = randomUUID()
  private readonly startedAt = Date.now()
  private ended = false

  constructor(
    readonly agentName: string,
    private readonly sinks: Array<EventSinkFn | undefined>,
    private readonly logger?: Logger
  ) {}

  emit(body: CallEventBody): void {
    deliverEvent({ ...body, callId: this.callId, agentName: this.agentName } as AiEvent, this.sinks, this.logger)
  }

  started(kind: 'text' | 'stream' | 'object', metadata?: Record<string, unknown>): void {
    this.emit({ type: 'call:started', kind, metadata, at: this.startedAt })
  }

  completed(fields: {
    provider: string
    model: string
    usage: Extract<AiEvent, { type: 'call:completed' }>['usage']
    costUsd?: number
    finishReason: string
    status: 'completed' | 'awaiting-approval'
  }): void {
    if (this.ended) return
    this.ended = true
    this.emit({ type: 'call:completed', ...fields, durationMs: Date.now() - this.startedAt })
  }

  failed(err: unknown): void {
    if (this.ended) return
    this.ended = true
    this.emit({
      type: 'call:failed',
      errorClass: classifyErrorClass(err),
      message: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - this.startedAt,
    })
  }
}
