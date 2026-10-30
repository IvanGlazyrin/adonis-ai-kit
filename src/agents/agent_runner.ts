import type { z } from 'zod'
import type { PrepareStepFunction, ToolSet } from 'ai'
import type {
  GenerateObjectOptions,
  GenerateObjectResult,
  GenerateTextOptions,
  GenerateTextResult,
  StreamTextOptions,
  StreamTextResult,
} from '../types.js'
import type { AiManager } from '../ai_manager.js'
import { AiException } from '../errors.js'
import { composeOnDemandPrompt, type AgentPromptConfig } from './loader.js'
import type { ToolPermission } from './manifest.js'
import { createLoadSkillTool, LOAD_SKILL_TOOL } from './skill_tool.js'
import { isMcpTool } from '../mcp/types.js'

/**
 * The caller's `prepareStep` with any `instructions` or `system` it returns removed: the agent's own prompt
 * stays the same on every step, so a caller cannot replace it mid-run.
 */
function keepAgentPrompt(prepareStep: PrepareStepFunction<ToolSet> | undefined): PrepareStepFunction<ToolSet> | undefined {
  if (!prepareStep) return undefined
  return async (context) => {
    const result = await prepareStep(context)
    if (!result || (result.instructions === undefined && result.system === undefined)) return result
    const { instructions: _instructions, system: _system, ...rest } = result
    return rest
  }
}

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
  /**
   * Overrides the manifest `skillLoading` for this runner. `on-demand` offers the `loadSkill` tool and lists skill
   * names only; `eager` puts every skill body in the system prompt.
   */
  skillLoading?: 'eager' | 'on-demand'
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
    if (this.onDemand()) this.assertLoadSkillAllowed()
  }

  /** In on-demand mode the `loadSkill` tool must run, so a manifest that denies or asks for it is a config error. */
  private assertLoadSkillAllowed(): void {
    const own = Object.hasOwn(this.config.permissions, LOAD_SKILL_TOOL)
      ? this.config.permissions[LOAD_SKILL_TOOL]
      : undefined
    if (own === 'deny' || own === 'ask') {
      throw new AiException(
        `Agent "${this.config.id}" loads skills on demand, so its "${LOAD_SKILL_TOOL}" permission must be "allow", not "${own}".`,
        'E_AI_CONFIG_ERROR'
      )
    }
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

  /**
   * A runner for the same agent with `overrides` applied over this runner's options. `agentAsTool` uses it to build
   * a sub-agent runner; a key set to `undefined` in `overrides` clears the option.
   */
  withOptions(overrides: AgentRunnerOptions): AgentRunner {
    return new AgentRunner(this.manager, this.config, { ...this.defaultOptions, ...overrides })
  }

  /** The manifest's permission; without one, an MCP tool is `deny` (fail-closed), and other tools get the default. */
  private permissionFor(toolName: string, tool: unknown): ToolPermission {
    const own = Object.hasOwn(this.config.permissions, toolName)
      ? this.config.permissions[toolName]
      : undefined
    if (own !== undefined) return own
    return isMcpTool(tool) ? 'deny' : (this.defaultOptions.defaultToolPermission ?? 'allow')
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
    if (this.onDemand() && rawTools && Object.hasOwn(rawTools, LOAD_SKILL_TOOL)) {
      throw new AiException(
        `Tool name "${LOAD_SKILL_TOOL}" is reserved for skills on demand in agent "${this.config.id}".`,
        'E_AI_INVALID_ARGUMENT'
      )
    }
    const toolPermissions: Record<string, ToolPermission> = {}
    if (!rawTools || Object.keys(rawTools).length === 0) {
      return { tools: undefined, toolPermissions }
    }

    const filtered: ToolSet = {}
    for (const [name, tool] of Object.entries(rawTools)) {
      const permission = this.permissionFor(name, tool)
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

  private onDemand(): boolean {
    return (this.defaultOptions.skillLoading ?? this.config.skillLoading) === 'on-demand'
  }

  /**
   * The agent's own system prompt. `eager` forces every skill body in, for calls with no tool loop (structured output).
   * The config's own prompt is returned when its mode already matches.
   */
  private agentPrompt(eager = false): string {
    const wantOnDemand = !eager && this.onDemand()
    if (wantOnDemand === (this.config.skillLoading === 'on-demand')) return this.config.systemPrompt
    return wantOnDemand
      ? composeOnDemandPrompt(this.config.body, this.config.skillEntries)
      : this.config.eagerSystemPrompt
  }

  /** Adds the `loadSkill` tool in on-demand mode, with an explicit `allow` so the default permission cannot deny it. */
  private withSkillTool(prepared: {
    tools: ToolSet | undefined
    toolPermissions: Record<string, ToolPermission>
  }): { tools: ToolSet | undefined; toolPermissions: Record<string, ToolPermission> } {
    if (!this.onDemand() || this.config.skillEntries.length === 0) return prepared
    return {
      tools: { ...prepared.tools, [LOAD_SKILL_TOOL]: createLoadSkillTool({ skills: this.config.skillEntries }) },
      toolPermissions: { ...prepared.toolPermissions, [LOAD_SKILL_TOOL]: 'allow' },
    }
  }

  private mergedSystem(agentPrompt: string, extra?: string): string {
    return [agentPrompt, this.defaultOptions.system, extra].filter(Boolean).join('\n\n')
  }

  /**
   * Fields every agent call resolves the same way: caller value, then runner default, then manifest.
   */
  private sharedCallOptions(baseOpts: SharedCallFields, eager = false): SharedCallOptions {
    return {
      agentName: this.config.id,
      system: this.mergedSystem(this.agentPrompt(eager), baseOpts.system),
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

    const { tools, toolPermissions } = this.withSkillTool(this.prepareTools(baseOpts.tools))

    return this.manager.generateText({
      ...baseOpts,
      ...this.sharedCallOptions(baseOpts),
      maxSteps: baseOpts.maxSteps ?? this.config.stopSteps,
      tools,
      toolPermissions,
      toolGuard: baseOpts.toolGuard ?? this.defaultOptions.toolGuard,
      prepareStep: keepAgentPrompt(baseOpts.prepareStep),
    })
  }

  /**
   * Streams responses with agent instructions, skills, and budget attribution.
   */
  async runStream(promptOrOptions: string | StreamTextOptions): Promise<StreamTextResult> {
    const baseOpts: StreamTextOptions =
      typeof promptOrOptions === 'string' ? { prompt: promptOrOptions } : { ...promptOrOptions }

    const { tools, toolPermissions } = this.withSkillTool(this.prepareTools(baseOpts.tools))

    return this.manager.streamText({
      ...baseOpts,
      ...this.sharedCallOptions(baseOpts),
      maxSteps: baseOpts.maxSteps ?? this.config.stopSteps,
      tools,
      toolPermissions,
      toolGuard: baseOpts.toolGuard ?? this.defaultOptions.toolGuard,
      prepareStep: keepAgentPrompt(baseOpts.prepareStep),
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
      ...this.sharedCallOptions(baseOpts, true),
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
