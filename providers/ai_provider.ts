import { type ApplicationService } from '@adonisjs/core/types'
import type { AiConfig } from '../src/types.js'
import type { AiManager } from '../src/ai_manager.js'

declare module '@adonisjs/core/types' {
  export interface ContainerBindings {
    ai: AiManager
  }
}

/**
 * AdonisJS 7 Service Provider for the AI subsystem.
 * Registers 'ai' singleton in container and installs HTTP response macros.
 */
export default class AiProvider {
  private manager?: AiManager

  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton('ai', async () => {
      const { AiManager } = await import('../src/ai_manager.js')
      const config = this.app.config.get<AiConfig>('ai', {
        default: 'openai',
        providers: {},
      })
      const logger = await this.app.container.make('logger')
      this.manager = new AiManager(config, { logger })
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
