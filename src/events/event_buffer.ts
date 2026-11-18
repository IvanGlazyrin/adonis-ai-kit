import type { Logger } from '../logger.js'

/** Where buffered events end up. */
export interface EventSink<E> {
  emit(event: E): void
}

export interface EventBufferOptions {
  /** Events kept while no sink is attached; the oldest is dropped beyond it. Default: 1000. */
  maxQueueSize?: number
  logger?: Logger
}

const DEFAULT_MAX_QUEUE_SIZE = 1000

/**
 * Collects events before their consumer exists. Without a sink, events wait in a bounded queue (the oldest is dropped
 * when it is full); `attachSink()` hands the queue over in order, and later events go straight to the sink.
 * Counts every event by `type`, whether queued or delivered.
 */
export class EventBuffer<E extends { type: string }> implements EventSink<E> {
  private queue: E[] = []
  private sink: EventSink<E> | null = null
  private readonly counters = new Map<string, number>()
  private droppedEvents = 0
  private readonly maxQueueSize: number
  private readonly logger?: Logger

  constructor(options: EventBufferOptions = {}) {
    const max = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE
    this.maxQueueSize = Number.isInteger(max) && max >= 1 ? max : DEFAULT_MAX_QUEUE_SIZE
    this.logger = options.logger
  }

  emit(event: E): void {
    this.counters.set(event.type, (this.counters.get(event.type) ?? 0) + 1)
    if (this.sink) {
      this.sink.emit(event)
      return
    }
    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift()
      this.droppedEvents++
      if (this.droppedEvents === 1 || this.droppedEvents % 100 === 0) {
        this.logger?.warn(
          `[EventBuffer] Queue full, dropped ${this.droppedEvents} events. Attach a sink to stop losing events.`
        )
      }
    }
    this.queue.push(event)
  }

  /** Sends the queued events to `sink` in order, then sends every later event straight to it. */
  attachSink(sink: EventSink<E>): void {
    this.sink = sink
    if (this.droppedEvents > 0) {
      this.logger?.warn(`[EventBuffer] Sink attached; ${this.droppedEvents} events were dropped before it.`)
      this.droppedEvents = 0
    }
    const queued = this.queue
    this.queue = []
    for (const event of queued) sink.emit(event)
  }

  getCount(type: string): number {
    return this.counters.get(type) ?? 0
  }

  getQueueSize(): number {
    return this.queue.length
  }

  /** Events dropped since the last `attachSink()` (or since creation). */
  getDroppedEvents(): number {
    return this.droppedEvents
  }
}
