import type { AiEvent, AiObserver } from './types.js'

/** Anything with an `emit(name, payload)` method, such as the AdonisJS emitter or a Node `EventEmitter`. */
export interface NamedEventEmitter {
  emit(name: string, payload: unknown): unknown
}

/** Sends every event to `emitter` under its type with an `ai:` prefix: `call:completed` becomes `ai:call:completed`. */
export function emitterObserver(emitter: NamedEventEmitter): AiObserver {
  return {
    emit(event: AiEvent) {
      return emitter.emit(`ai:${event.type}`, event) as void | Promise<void>
    },
  }
}
