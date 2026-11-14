import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { stubsRoot } from '../stubs/main.js'

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/
/** Provider keys and model ids: letters, digits and `_ . / : @ -`. Nothing that can leave a string literal. */
const IDENTIFIER_PATTERN = /^[\w./:@-]+$/

export default class MakeAiAgentCommand extends BaseCommand {
  static commandName = 'make:ai-agent'
  static description =
    'Scaffold a typed wrapper class around the ai service (not a Markdown agent manifest for ai.agent())'

  static options: CommandOptions = {
    startApp: false,
  }

  @args.string({ description: 'Name of the AI Agent class (e.g. MarketAnalysis, SupportChat, Coder)' })
  declare name: string

  @flags.string({ description: 'AI provider to use (default: app default)' })
  declare provider?: string

  @flags.string({ description: 'Model to use (e.g. gpt-6-sol, claude-sonnet-5-5)' })
  declare model?: string

  @flags.number({ description: 'Max token budget per request', default: 2048 })
  declare maxTokens: number

  async run() {
    const rawName = String(this.name).replace(/Agent$/i, '')
    const problem = this.validate(rawName)
    if (problem) {
      this.logger.error(problem)
      this.exitCode = 1
      return
    }

    const className = rawName.charAt(0).toUpperCase() + rawName.slice(1) + 'Agent'
    const fileName = rawName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase() + '_agent.ts'

    const codemods = await this.createCodemods()
    const result = await codemods.makeUsingStub(stubsRoot, 'make/agent.stub', {
      fileName,
      className,
      agentName: `${rawName.toLowerCase()}-agent`,
      provider: this.provider ?? '',
      model: this.model ?? '',
      maxTokens: this.maxTokens,
    })

    if (result.status === 'skipped') {
      this.logger.error(`Agent file already exists: ${result.destination}`)
    }
  }

  /** The first problem with the input, or `null` when it can be written into a source file safely. */
  private validate(rawName: string): string | null {
    if (!NAME_PATTERN.test(String(this.name)) || rawName === '') {
      return `Invalid name "${this.name}": use letters and digits only, starting with a letter (for example MarketAnalysis)`
    }
    if (this.provider !== undefined && !IDENTIFIER_PATTERN.test(this.provider)) {
      return `Invalid --provider "${this.provider}": use letters, digits and _ . / : @ - only`
    }
    if (this.model !== undefined && !IDENTIFIER_PATTERN.test(this.model)) {
      return `Invalid --model "${this.model}": use letters, digits and _ . / : @ - only`
    }
    if (!Number.isInteger(this.maxTokens) || this.maxTokens < 1) {
      return `Invalid --max-tokens "${this.maxTokens}": use a positive integer`
    }
    return null
  }
}
