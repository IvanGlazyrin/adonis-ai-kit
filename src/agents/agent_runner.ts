import type { z } from 'zod'
import type { ToolSet } from 'ai'
import type {
  GenerateObjectOptions,
  GenerateObjectResult,
  GenerateTextOptions,
  GenerateTextResult,
  StreamTextOptions,
  StreamTextResult,
} from '../types.js'
import type { AiManager } from '../ai_manager.js'
import type { AgentPromptConfig } from './loader.js'
import type { ToolPermission } from './manifest.js'

export interface AgentRunnerOptions {
  tools?: ToolSet
  system?: string
  model?: string
  provider?: string
  temperature?: number
  maxOutputTokens?: number
  /** @deprecated Use `maxOutputTokens`. */
  maxTokens?: number
  sessionId?: string
  toolGuard?: GenerateTextOptions['toolGuard']
  /**
   * Permission of tools the agent manifest does not mention. Default: 'allow' (the manifest then
   * acts as a deny/ask list). Use 'deny' for strict allow-list mode.
   */
  defaultToolPermission?: ToolPermission
}

/** Caller-supplied call fields that every agent call resolves the same way. */
interface SharedCallFields {
  system?: string
  model?: string
  provider?: string
  temperature?: number
  maxOutputTokens?: number
  /** @deprecated Use `maxOutputTokens`. */
  maxTokens?: number
}

interface SharedCallOptions {
  agentName: string
  system: string
  model?: string
  provider?: string
  temperature?: number
  maxOutputTokens?: number
}

export class AgentRunner {
  private manager: AiManager
  private config: AgentPromptConfig
  private defaultOptions: AgentRunnerOptions

  constructor(
    manager: AiManager,
    config: AgentPromptConfig,
    options: AgentRunnerOptions = {}
  ) {
    this.manager = manager
    this.config = config
    this.defaultOptions = options
  }

  getId(): string {
    return this.config.id
  }

  getDescription(): string {
    return this.config.description
  }

  getSystemPrompt(): string {
    return this.config.systemPrompt
  }

  getConfig(): AgentPromptConfig {
    return this.config
  }

  getPermissions(): Record<string, ToolPermission> {
    return this.config.permissions
  }

  private permissionFor(toolName: string): ToolPermission {
    const own = Object.hasOwn(this.config.permissions, toolName)
      ? this.config.permissions[toolName]
      : undefined
    return own ?? this.defaultOptions.defaultToolPermission ?? 'allow'
  }

  /**
   * Filters tools according to the agent manifest. `deny` tools are removed; the permissions map is
   * returned so the manager enforces `ask` (human confirmation) and the tool guard at call time.
   */
  private prepareTools(runtimeTools?: ToolSet): {
    tools: ToolSet | undefined
    toolPermissions: Record<string, ToolPermission>
  } {
    const rawTools = runtimeTools ?? this.defaultOptions.tools
    const toolPermissions: Record<string, ToolPermission> = {}
    if (!rawTools || Object.keys(rawTools).length === 0) {
      return { tools: undefined, toolPermissions }
    }

    const filtered: ToolSet = {}
    for (const [name, tool] of Object.entries(rawTools)) {
      const permission = this.permissionFor(name)
      if (permission === 'deny') {
        continue
      }
      filtered[name] = tool
      toolPermissions[name] = permission
    }

    return {
      tools: Object.keys(filtered).length > 0 ? filtered : undefined,
      toolPermissions,
    }
  }

  private mergedSystem(extra?: string): string {
    return [this.config.systemPrompt, this.defaultOptions.system, extra].filter(Boolean).join('\n\n')
  }

  /**
   * Fields every agent call resolves the same way: caller value, then runner default, then manifest.
   */
  private sharedCallOptions(baseOpts: SharedCallFields): SharedCallOptions {
    return {
      agentName: this.config.id,
      system: this.mergedSystem(baseOpts.system),
      model: baseOpts.model ?? this.defaultOptions.model ?? this.config.model,
      provider: baseOpts.provider ?? this.defaultOptions.provider ?? this.config.provider,
      temperature: baseOpts.temperature ?? this.defaultOptions.temperature ?? this.config.temperature,
      maxOutputTokens: this.maxOutputTokens(baseOpts),
    }
  }

  /**
   * Executes a text generation step with agent instructions, budget tracking, and tool permissions.
   *
   * Security: `tools`, `toolPermissions`, `system` and `toolGuard` are spread AFTER the caller's
   * options so a caller can neither re-introduce a denied tool nor replace the agent's prompt.
   */
  async run(promptOrOptions: string | GenerateTextOptions): Promise<GenerateTextResult> {
    const baseOpts: GenerateTextOptions =
      typeof promptOrOptions === 'string' ? { prompt: promptOrOptions } : { ...promptOrOptions }

    const { tools, toolPermissions } = this.prepareTools(baseOpts.tools)

    return this.manager.generateText({
      ...baseOpts,
      ...this.sharedCallOptions(baseOpts),
      maxSteps: baseOpts.maxSteps ?? this.config.stopSteps,
      tools,
      toolPermissions,
      toolGuard: baseOpts.toolGuard ?? this.defaultOptions.toolGuard,
    })
  }

  /**
   * Streams responses with agent instructions, skills, and budget attribution.
   */
  async runStream(promptOrOptions: string | StreamTextOptions): Promise<StreamTextResult> {
    const baseOpts: StreamTextOptions =
      typeof promptOrOptions === 'string' ? { prompt: promptOrOptions } : { ...promptOrOptions }

    const { tools, toolPermissions } = this.prepareTools(baseOpts.tools)

    return this.manager.streamText({
      ...baseOpts,
      ...this.sharedCallOptions(baseOpts),
      maxSteps: baseOpts.maxSteps ?? this.config.stopSteps,
      tools,
      toolPermissions,
      toolGuard: baseOpts.toolGuard ?? this.defaultOptions.toolGuard,
    })
  }

  /** Alias of `runStream()`. */
  stream(promptOrOptions: string | StreamTextOptions): Promise<StreamTextResult> {
    return this.runStream(promptOrOptions)
  }

  /**
   * Generates structured output conforming to a Zod schema or the agent's outputSchema.
   */
  async runStructured<T>(
    schema?: z.ZodType<T>,
    promptOrOptions?: string | Partial<GenerateObjectOptions<T>>
  ): Promise<GenerateObjectResult<T>> {
    const targetSchema = schema ?? (this.config.outputSchema as z.ZodType<T> | undefined)
    if (!targetSchema) {
      throw new Error(`No schema provided for structured output in agent "${this.config.id}"`)
    }

    const baseOpts: Partial<GenerateObjectOptions<T>> =
      typeof promptOrOptions === 'string' ? { prompt: promptOrOptions } : (promptOrOptions ?? {})

    return this.manager.generateObject({
      ...baseOpts,
      ...this.sharedCallOptions(baseOpts),
      schema: targetSchema,
      schemaName: baseOpts.schemaName ?? this.config.outputSchemaName ?? this.config.id,
    })
  }

  private maxOutputTokens(
    opts: { maxOutputTokens?: number; maxTokens?: number }
  ): number | undefined {
    return (
      opts.maxOutputTokens ??
      opts.maxTokens ??
      this.defaultOptions.maxOutputTokens ??
      this.defaultOptions.maxTokens ??
      this.config.maxTokens
    )
  }
}
