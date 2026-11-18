import { test } from '@japa/runner'
import { EventBuffer } from '../../../src/events/event_buffer.js'
import { emitterObserver } from '../../../src/events/emitter_observer.js'
import type { AiEvent } from '../../../src/events/types.js'

type E = { type: string; n: number }

test.group('EventBuffer', () => {
  test('queues events until a sink is attached and flushes them in order', ({ assert }) => {
    const buffer = new EventBuffer<E>()
    buffer.emit({ type: 'a', n: 1 })
    buffer.emit({ type: 'b', n: 2 })
    const got: number[] = []

    buffer.attachSink({ emit: (event) => got.push(event.n) })

    assert.deepEqual(got, [1, 2])
    assert.equal(buffer.getQueueSize(), 0)
  })

  test('drops the oldest event when the queue is full', ({ assert }) => {
    const warnings: string[] = []
    const logger = { info() {}, warn: (m: string) => warnings.push(m), error() {} }
    const buffer = new EventBuffer<E>({ maxQueueSize: 2, logger })
    buffer.emit({ type: 'a', n: 1 })
    buffer.emit({ type: 'a', n: 2 })
    buffer.emit({ type: 'a', n: 3 })

    assert.equal(buffer.getDroppedEvents(), 1)
    assert.lengthOf(warnings, 1)
    const got: number[] = []
    buffer.attachSink({ emit: (event) => got.push(event.n) })
    assert.deepEqual(got, [2, 3])
    assert.equal(buffer.getDroppedEvents(), 0)
  })

  test('counts events by type', ({ assert }) => {
    const buffer = new EventBuffer<E>()
    buffer.emit({ type: 'a', n: 1 })
    buffer.emit({ type: 'a', n: 2 })
    buffer.attachSink({ emit() {} })
    buffer.emit({ type: 'b', n: 3 })

    assert.equal(buffer.getCount('a'), 2)
    assert.equal(buffer.getCount('b'), 1)
    assert.equal(buffer.getCount('c'), 0)
  })

  test('sends events straight to the sink once attached', ({ assert }) => {
    const buffer = new EventBuffer<E>()
    const got: number[] = []
    buffer.attachSink({ emit: (event) => got.push(event.n) })

    buffer.emit({ type: 'a', n: 7 })

    assert.deepEqual(got, [7])
    assert.equal(buffer.getQueueSize(), 0)
  })
})

test.group('emitterObserver', () => {
  test('emitterObserver maps the type to an ai:-prefixed name', ({ assert }) => {
    const seen: Array<[string, unknown]> = []
    const observer = emitterObserver({ emit: (name, payload) => seen.push([name, payload]) })
    const event: AiEvent = { type: 'breaker:state', key: 'k', from: 'closed', to: 'open' }

    void observer.emit(event)

    assert.deepEqual(seen, [['ai:breaker:state', event]])
  })
})
