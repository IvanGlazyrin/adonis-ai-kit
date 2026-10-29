import path from 'node:path'
import type { LanguageModel } from 'ai'
import type { ConfirmationService } from '../guard/confirmation.js'
import type { AiDriver } from '../types.js'
import { AiException, ProviderConfigError } from '../errors.js'
import type { Logger } from '../logger.js'
import type {
  AcpAgentConfig,
  AcpAgentRuntimeConfig,
  AcpMcpServerConfig,
  AcpPermissionPolicy,
  AcpProviderConfig,
} from './types.js'
import {
  buildAcpRuntimeConfig,
  buildProjectMcpServer,
  getAcpAgentConfig,
  normalizeMcpServer,
} from './acp_agents.js'

/** Variables a CLI needs to run at all. Everything else is withheld unless `inheritEnv` is set. */
const SAFE_ENV_KEYS = new Set(
  [
    'PATH',
    'PATHEXT',
    'HOME',
    'USER',
    'USERNAME',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LANGUAGE',
    'TERM',
    'COLORTERM',
    'TZ',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMDATA',
    'HOMEDRIVE',
    'HOMEPATH',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'OS',
  ].map((k) => k.toUpperCase())
)
const SAFE_ENV_PREFIXES = ['LC_', 'XDG_']

/** Subset of an ACP `RequestPermissionRequest` that the handler needs. */
interface AcpPermissionRequestLike {
  sessionId?: string
  options?: Array<{ optionId: string; kind: string; name?: string }>
  toolCall?: { title?: string | null; kind?: string | null; rawInput?: unknown; locations?: unknown }
}

type AcpPermissionResponseLike =
  | { outcome: { outcome: 'cancelled' } }
  | { outcome: { outcome: 'selected'; optionId: string } }

interface AcpLanguageModelLike {
  connectClient(): Promise<void>
  client?: { setPermissionRequestHandler?: (handler: unknown) => void } | null
}

interface AcpProviderLike {
  languageModel(): AcpLanguageModelLike
  cleanup(): void
}

/**
 * Builds the environment for the agent process.
 *
 * `@mcpc-tech/acp-ai-provider` spawns the agent with `{ ...process.env, ...env }`, so the server's
 * secrets cannot be left out by omission. Instead every variable that is not allowlisted is
 * explicitly blanked, and only the allowlist plus `extra` (agent credentials, configured env)
 * keep real values.
 */
export function buildAgentEnv(
  source: Record<string, string | undefined>,
  extra: Record<string, string>,
  inheritEnv = false
): Record<string, string> {
  if (inheritEnv) return { ...extra }

  const env: Record<string, string> = {}
  // The provider merges over `process.env`, so keys that only exist there must be blanked too.
  const keys = new Set([...Object.keys(source), ...Object.keys(process.env)])
  for (const key of keys) {
    const upper = key.toUpperCase()
    const safe = SAFE_ENV_KEYS.has(upper) || SAFE_ENV_PREFIXES.some((p) => upper.startsWith(p))
    env[key] = safe ? (source[key] ?? '') : ''
  }
  return { ...env, ...extra }
}

export interface AcpDriverDeps {
  logger?: Logger
  /** Answers agent permission requests when `permissionPolicy` is `ask`. */
  confirmation?: ConfirmationService
  /**
   * Environment whose allowlisted variables the agent keeps. Default: `process.env`. Variables that
   * exist only in `process.env` are blanked as well, because the agent is spawned with
   * `{ ...process.env, ...env }`.
   */
  env?: Record<string, string | undefined>
  /**
   * Prebuilt runtime config (e.g. from `buildAcpRuntimeConfig`). Used verbatim, except that `cwd`
   * must be absolute and the agent environment is rebuilt from `env` plus the runtime's own env.
   */
  runtime?: AcpAgentRuntimeConfig
}

export class AcpDriver implements AiDriver {
  readonly name: string
  readonly defaultModel: string
  private config: AcpProviderConfig
  private logger?: Logger
  private confirmation?: ConfirmationService
  private env: Record<string, string | undefined>
  private runtime?: AcpAgentRuntimeConfig
  private cachedModels: Map<string, Promise<LanguageModel>> = new Map()
  private providers: Set<AcpProviderLike> = new Set()
  private permissionPolicy: AcpPermissionPolicy

  constructor(name: string, config: AcpProviderConfig, deps: AcpDriverDeps = {}) {
    this.name = name
    this.config = config
    this.logger = deps.logger
    this.confirmation = deps.confirmation
    this.env = deps.env ?? process.env
    this.runtime = deps.runtime
    this.defaultModel = config.agentId ?? config.defaultModel ?? 'claude-code'
    this.permissionPolicy = config.permissionPolicy ?? 'ask'

    if (this.permissionPolicy === 'allow') {
      this.logger?.warn?.(
        `[AcpDriver] Provider "${name}" auto-approves every agent action (permissionPolicy: 'allow').`
      )
    }
  }

  /**
   * Lazily loads and instantiates an AI SDK language model backed by the ACP agent.
   * `modelName` selects among the built-in agents; it is never executed as a command.
   */
  async getModel(modelName?: string): Promise<LanguageModel> {
    const agentId = modelName ?? this.defaultModel
    const runtimeConfig = this.resolveRuntimeConfig(agentId)
    const cacheKey = `${runtimeConfig.command}::${runtimeConfig.cwd}`

    let model = this.cachedModels.get(cacheKey)
    if (!model) {
      model = this.createModel(runtimeConfig)
      this.cachedModels.set(cacheKey, model)
      // Do not cache failures
      model.catch(() => this.cachedModels.delete(cacheKey))
    }
    return model
  }

  /**
   * Tests whether the ACP agent can be resolved and its model instantiated.
   */
  async ping(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const startTime = Date.now()
    try {
      const runtimeConfig = this.resolveRuntimeConfig(this.defaultModel)
      this.logger?.debug?.(`[AcpDriver] Pinging ACP agent command: ${runtimeConfig.command}`)
      await this.getModel(this.defaultModel)
      return { ok: true, latencyMs: Date.now() - startTime }
    } catch (err: unknown) {
      return {
        ok: false,
        latencyMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /**
   * Terminates every agent process started by this driver.
   */
  async shutdown(): Promise<void> {
    const providers = [...this.providers]
    this.providers.clear()
    this.cachedModels.clear()
    for (const provider of providers) {
      try {
        provider.cleanup()
      } catch (err) {
        this.logger?.warn?.(`[AcpDriver] Failed to clean up ACP provider: ${String(err)}`)
      }
    }
  }

  private resolveRuntimeConfig(agentId: string): AcpAgentRuntimeConfig {
    if (this.runtime) return this.prebuiltRuntime(this.runtime)

    const predefined = getAcpAgentConfig(agentId)
    // A command is only ever taken from config or from the built-in agent table.
    if (!this.config.command && !predefined) {
      throw new ProviderConfigError(
        this.name,
        `Unknown ACP agent "${agentId}". Use one of the built-in agents or set "command" explicitly in the provider config.`
      )
    }

    const builtFromEnv = predefined
      ? buildAcpRuntimeConfig(agentId, (key) => this.env[key], this.env, this.logger)
      : null

    const cwd = this.config.cwd ?? builtFromEnv?.cwd ?? process.cwd()
    requireAbsoluteCwd(this.name, cwd)

    return {
      ...this.commandAndArgs(predefined, builtFromEnv),
      cwd,
      env: this.agentEnv(builtFromEnv),
      mcpServers: this.mcpServersFor(builtFromEnv?.mcpServers ?? []),
      authMethodId: this.config.authMethodId ?? builtFromEnv?.authMethodId ?? predefined?.authMethodId,
    }
  }

  /** The command and its arguments: an explicit command never inherits the built-in agent's arguments. */
  private commandAndArgs(
    predefined: AcpAgentConfig | undefined,
    builtFromEnv: AcpAgentRuntimeConfig | null
  ): { command: string; args: string[] } {
    const explicitCommand = this.config.command
    return {
      command: explicitCommand ?? builtFromEnv?.command ?? predefined!.command,
      args: this.config.args ?? (explicitCommand ? [] : (builtFromEnv?.args ?? predefined!.args)),
    }
  }

  /** The agent's environment: the built-in agent's env overridden by the provider's, filtered by the inheritance policy. */
  private agentEnv(builtFromEnv: AcpAgentRuntimeConfig | null): Record<string, string> {
    return buildAgentEnv(
      this.env,
      { ...(builtFromEnv?.env ?? {}), ...(this.config.env ?? {}) },
      this.config.inheritEnv
    )
  }

  /** A prebuilt runtime is used as given; only its env is merged with the process env. */
  private prebuiltRuntime(runtime: AcpAgentRuntimeConfig): AcpAgentRuntimeConfig {
    requireAbsoluteCwd(this.name, runtime.cwd)
    return { ...runtime, env: buildAgentEnv(this.env, runtime.env, this.config.inheritEnv) }
  }

  /** Built-in servers first, then configured ones; invalid entries are dropped with a warning. */
  private mcpServersFor(builtIn: AcpMcpServerConfig[]): AcpMcpServerConfig[] {
    const servers = [...builtIn]
    for (const server of this.config.mcpServers ?? []) {
      const normalized = normalizeMcpServer(server)
      if (normalized) servers.push(normalized)
      else this.logger?.warn?.(`[AcpDriver] Ignoring invalid MCP server in provider "${this.name}"`)
    }
    if (this.config.enableProjectMcp) {
      const project = this.projectMcpServer()
      if (project) servers.push(project)
    }
    return servers
  }

  private projectMcpServer(): AcpMcpServerConfig | null {
    if (!this.config.projectMcp) {
      this.logger?.warn?.(
        `[AcpDriver] enableProjectMcp is set on "${this.name}" but "projectMcp.path" is missing; skipping.`
      )
      return null
    }
    return buildProjectMcpServer(this.config.projectMcp, this.logger) ?? null
  }

  private async createModel(runtimeConfig: AcpAgentRuntimeConfig): Promise<LanguageModel> {
    this.logger?.info?.(
      `[ACP] Starting ACP agent session: ${runtimeConfig.command} in ${runtimeConfig.cwd}`
    )

    let acpModule: { createACPProvider: (settings: unknown) => AcpProviderLike }
    try {
      acpModule = await import('@mcpc-tech/acp-ai-provider' as string)
    } catch (err) {
      throw new AiException(
        `Package "@mcpc-tech/acp-ai-provider" is required to use ACP drivers: ${err instanceof Error ? err.message : String(err)}`,
        'E_AI_MISSING_DEPENDENCY',
        err
      )
    }

    const provider = acpModule.createACPProvider({
      command: runtimeConfig.command,
      args: runtimeConfig.args,
      env: runtimeConfig.env,
      authMethodId: runtimeConfig.authMethodId,
      session: {
        cwd: runtimeConfig.cwd,
        mcpServers: runtimeConfig.mcpServers,
      },
    })
    this.providers.add(provider)

    const model = provider.languageModel()
    this.installPermissionHandler(model, runtimeConfig.command)
    return model as unknown as LanguageModel
  }

  /**
   * The ACP provider auto-selects the first permission option when no handler is set, and offers
   * no public API to set one. The handler is installed on the model's client right after every
   * connection is established. If it cannot be installed the model refuses to connect (fail-closed).
   */
  private installPermissionHandler(model: AcpLanguageModelLike, agentLabel: string): void {
    const connect = model.connectClient.bind(model)
    const handler = (params: AcpPermissionRequestLike) => this.answerPermission(params, agentLabel)

    model.connectClient = async () => {
      await connect()
      const client = model.client
      if (!client || typeof client.setPermissionRequestHandler !== 'function') {
        throw new AiException(
          'Unable to install the ACP permission handler (unsupported @mcpc-tech/acp-ai-provider version); refusing to run the agent without permission control.',
          'E_AI_ACP_UNSAFE'
        )
      }
      client.setPermissionRequestHandler(handler)
    }
  }

  private async answerPermission(
    params: AcpPermissionRequestLike,
    agentLabel: string
  ): Promise<AcpPermissionResponseLike> {
    const options = params.options ?? []
    const title = toolTitle(params)

    if (this.permissionPolicy === 'allow') {
      return allowOption(options)
    }
    if (this.permissionPolicy === 'deny') {
      this.logger?.warn?.(`[ACP] Denied "${title}" requested by ${agentLabel} (policy: deny)`)
      return rejectOption(options)
    }

    if (!this.confirmation) {
      this.logger?.warn?.(
        `[ACP] Denied "${title}" requested by ${agentLabel}: no ConfirmationService to ask a human`
      )
      return rejectOption(options)
    }

    const response = await this.confirmation.waitForResponse(
      confirmationAction(params, agentLabel, title),
      this.config.permissionTimeoutMs
    )
    return response.status === 'approved' ? allowOption(options) : rejectOption(options)
  }
}

/** The tool's title as shown to a human and in logs. */
function toolTitle(params: AcpPermissionRequestLike): string {
  return params.toolCall?.title ?? params.toolCall?.kind ?? 'agent action'
}

/** The confirmation request for an agent permission: the tool's kind, input and locations, for a human to judge. */
function confirmationAction(
  params: AcpPermissionRequestLike,
  agentLabel: string,
  title: string
): { sessionId: string | undefined; toolName: string; action: string; params: Record<string, unknown> } {
  return {
    sessionId: params.sessionId,
    toolName: `acp:${agentLabel}`,
    action: String(title),
    params: {
      kind: params.toolCall?.kind ?? null,
      rawInput: params.toolCall?.rawInput ?? null,
      locations: params.toolCall?.locations ?? null,
    },
  }
}

type AcpPermissionOption = NonNullable<AcpPermissionRequestLike['options']>[number]

/** The first offered option of one of `kinds`, as a selection; `null` when the agent offers none. */
function selectOption(
  options: AcpPermissionOption[],
  kinds: string[]
): AcpPermissionResponseLike | null {
  const option = options.find((o) => kinds.includes(o.kind))
  return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : null
}

function rejectOption(options: AcpPermissionOption[]): AcpPermissionResponseLike {
  return selectOption(options, ['reject_once', 'reject_always']) ?? { outcome: { outcome: 'cancelled' } }
}

/** Never answers with `allow_always`: a single approval must not become a standing grant. */
function allowOption(options: AcpPermissionOption[]): AcpPermissionResponseLike {
  return selectOption(options, ['allow_once']) ?? rejectOption(options)
}

/**
 * Factory for creating an AcpDriver instance.
 */
export function createAcpDriver(
  name: string,
  config: AcpProviderConfig,
  deps: AcpDriverDeps = {}
): AcpDriver {
  return new AcpDriver(name, config, deps)
}

function requireAbsoluteCwd(providerName: string, cwd: string): void {
  if (!path.isAbsolute(cwd)) {
    throw new ProviderConfigError(providerName, `ACP "cwd" must be an absolute path, got "${cwd}"`)
  }
}
