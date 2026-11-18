import { type ApplicationService } from '@adonisjs/core/types'
import type { AiConfig } from '../src/types.js'
import type { AiManager } from '../src/ai_manager.js'
import type { AiEvent } from '../src/events/types.js'

/** The event of one `type`, as the AdonisJS emitter sends it under `ai:<type>`. */
type AiEventOf<T extends AiEvent['type']> = Extract<AiEvent, { type: T }>

declare module '@adonisjs/core/types' {
  export interface ContainerBindings {
    ai: AiManager
  }

  export interface EventsList {
    'ai:call:started': AiEventOf<'call:started'>
    'ai:attempt:started': AiEventOf<'attempt:started'>
    'ai:step:finished': AiEventOf<'step:finished'>
    'ai:fallback': AiEventOf<'fallback'>
    'ai:call:completed': AiEventOf<'call:completed'>
    'ai:call:failed': AiEventOf<'call:failed'>
    'ai:breaker:state': AiEventOf<'breaker:state'>
  }
}

/**
 * AdonisJS 7 Service Provider for the AI subsystem.
 * Registers 'ai' singleton in container, forwards its call events to the emitter as `ai:<type>`,
 * and installs HTTP response macros.
 */
export default class AiProvider {
  private manager?: AiManager

  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton('ai', async () => {
      const { AiManager } = await import('../src/ai_manager.js')
      const { emitterObserver } = await import('../src/events/emitter_observer.js')
      const config = this.app.config.get<AiConfig>('ai', {
        default: 'openai',
        providers: {},
      })
      const logger = await this.app.container.make('logger')
      const emitter = await this.app.container.make('emitter')
      this.manager = new AiManager(config, {
        logger,
        observer: emitterObserver(emitter as unknown as { emit(name: string, payload: unknown): unknown }),
      })
      return this.manager
    })
  }

  async boot() {
    const { registerResponseMacro } = await import('../src/response_macro.js')
    registerResponseMacro()
  }

  /**
   * Stops ACP agent processes and settles pending confirmations on application shutdown.
   */
  async shutdown() {
    await this.manager?.shutdown()
  }
}
