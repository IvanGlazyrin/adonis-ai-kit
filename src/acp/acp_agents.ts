import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Logger } from '../logger.js'
import type {
  AcpAgentConfig,
  AcpAgentRuntimeConfig,
  AcpMcpServerConfig,
  AcpNameValue,
  AcpProjectMcpConfig,
  AcpRuntimeOptions,
} from './types.js'

/**
 * Built-in ACP agent configurations. These are the ONLY commands that may be started from a
 * model name; anything else must be configured explicitly via `AcpProviderConfig.command`.
 *
 * Commands follow the agents' own ACP docs: Claude via the `claude-agent-acp` adapter, Gemini CLI
 * with `--acp`, Qwen Code's `qwen --acp`, Codex via `codex-acp`, `opencode acp`.
 * `sourcecraft` and `freebuff` could not be verified against upstream docs; override them with
 * `ACP_<AGENT>_PATH` / `ACP_<AGENT>_ARGS` if your install differs.
 */
const DEFAULT_ACP_AGENTS: Record<string, AcpAgentConfig> = Object.freeze({
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    description: "Anthropic's agentic coding CLI tool",
    command: 'claude-agent-acp',
    args: [],
    envVarPrefix: 'ACP_CLAUDE_CODE',
    supportsMcpServers: true,
    credentialEnv: [{ target: 'ANTHROPIC_API_KEY', sources: ['ANTHROPIC_API_KEY'] }],
  },
  'gemini': {
    id: 'gemini',
    name: 'Gemini CLI',
    description: "Google's Gemini CLI agent",
    command: 'gemini',
    args: ['--acp'],
    envVarPrefix: 'ACP_GEMINI',
    supportsMcpServers: true,
    authMethodId: 'gemini-api-key',
    credentialEnv: [{ target: 'GEMINI_API_KEY', sources: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] }],
  },
  'codex': {
    id: 'codex',
    name: 'Codex CLI',
    description: "OpenAI's Codex CLI agent",
    command: 'codex-acp',
    args: [],
    envVarPrefix: 'ACP_CODEX',
    supportsMcpServers: true,
    credentialEnv: [{ target: 'OPENAI_API_KEY', sources: ['OPENAI_API_KEY'] }],
  },
  'qwen-code': {
    id: 'qwen-code',
    name: 'Qwen Code',
    description: "Alibaba's Qwen Code CLI agent",
    command: 'qwen',
    args: ['--acp'],
    envVarPrefix: 'ACP_QWEN_CODE',
    supportsMcpServers: true,
    credentialEnv: [{ target: 'DASHSCOPE_API_KEY', sources: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'] }],
  },
  /** @deprecated Removed from defaults in 2.0; register it with registerAcpAgent() */
  'sourcecraft': {
    id: 'sourcecraft',
    name: 'SourceCraft Code Assistant',
    description: "SourceCraft's Code Assistant agent via CLI",
    command: 'src',
    args: ['code', '--', 'acp'],
    envVarPrefix: 'ACP_SOURCECRAFT',
    supportsMcpServers: true,
  },
  'opencode': {
    id: 'opencode',
    name: 'OpenCode',
    description: 'OpenCode AI coding assistant',
    command: 'opencode',
    args: ['acp'],
    envVarPrefix: 'ACP_OPENCODE',
    supportsMcpServers: true,
    credentialEnv: [{ target: 'OPENCODE_API_KEY', sources: ['OPENCODE_API_KEY'] }],
  },
  /** @deprecated Removed from defaults in 2.0; register it with registerAcpAgent() */
  'freebuff': {
    id: 'freebuff',
    name: 'Freebuff',
    description: 'Freebuff AI coding agent',
    command: 'codebuff-agent-acp',
    args: [],
    envVarPrefix: 'ACP_FREEBUFF',
    supportsMcpServers: true,
    credentialEnv: [
      { target: 'CODEBUFF_API_KEY', sources: ['CODEBUFF_API_KEY', 'FREEBUFF_API_KEY'] },
      { target: 'FREEBUFF_API_KEY', sources: ['CODEBUFF_API_KEY', 'FREEBUFF_API_KEY'] },
    ],
  },
})

/**
 * Registry of the ACP agents this application may start.
 *
 * It starts with the built-in agents, and an application can replace it with the
 * binaries that are actually installed on the operator's machine
 * (`setAcpAgents`) or extend it (`registerAcpAgent`).
 */
export const ACP_AGENTS: Record<string, AcpAgentConfig> = { ...DEFAULT_ACP_AGENTS }

/**
 * Registers (or replaces) one ACP agent.
 */
export function registerAcpAgent(agentId: string, config: AcpAgentConfig): void {
  ACP_AGENTS[agentId] = config
}

/**
 * Replaces the whole agent registry, e.g. with the binaries of a given deployment.
 */
export function setAcpAgents(agents: Record<string, AcpAgentConfig>): void {
  for (const key of Object.keys(ACP_AGENTS)) delete ACP_AGENTS[key]
  Object.assign(ACP_AGENTS, agents)
}

/**
 * Restores the built-in agent registry.
 */
export function resetAcpAgents(): void {
  setAcpAgents(DEFAULT_ACP_AGENTS)
}

/**
 * Get ACP agent configuration by ID.
 */
export function getAcpAgentConfig(agentId: string): AcpAgentConfig | undefined {
  return ACP_AGENTS[agentId]
}

/**
 * List all available ACP agent IDs.
 */
export function listAcpAgentIds(): string[] {
  return Object.keys(ACP_AGENTS)
}

/**
 * Check if an agent ID is a valid ACP agent.
 */
export function isAcpAgent(agentId: string): boolean {
  return agentId in ACP_AGENTS
}

/**
 * Parse agent arguments from env string.
 * Supports JSON arrays (e.g., '["--flag","--opt","val"]')
 * and falls back to comma-separated values.
 */
export function parseAcpArgs(
  argsOverride: string | undefined,
  fallback: string[],
  logger?: Logger
): string[] {
  if (!argsOverride) return fallback
  const trimmed = argsOverride.trim()
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        return parsed
      }
    } catch {
      logger?.warn?.(`[ACP] Invalid JSON array in args override: ${trimmed}`)
    }
  }
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function toNameValueList(input: unknown): AcpNameValue[] {
  if (Array.isArray(input)) {
    return input.filter(
      (item): item is AcpNameValue =>
        item !== null &&
        typeof item === 'object' &&
        typeof (item as AcpNameValue).name === 'string' &&
        typeof (item as AcpNameValue).value === 'string'
    )
  }
  if (input !== null && typeof input === 'object') {
    return Object.entries(input as Record<string, unknown>)
      .filter(([, value]) => typeof value === 'string')
      .map(([name, value]) => ({ name, value: value as string }))
  }
  return []
}

/**
 * Validates an MCP server definition and converts it to the exact shape required by the ACP
 * schema: stdio servers have no `type` and an `env` array; remote servers have `type`
 * 'http' | 'sse' and a `headers` array. Legacy `Record` env/headers and `httpUrl` are accepted.
 * Returns `null` for unusable entries.
 */
export function normalizeMcpServer(input: unknown): AcpMcpServerConfig | null {
  if (input === null || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  if (typeof raw.name !== 'string' || raw.name.length === 0) return null

  const url =
    typeof raw.url === 'string' ? raw.url : typeof raw.httpUrl === 'string' ? raw.httpUrl : undefined
  if (raw.type === 'http' || raw.type === 'sse' || (raw.type === undefined && url && !raw.command)) {
    if (!url) return null
    return {
      type: raw.type === 'sse' ? 'sse' : 'http',
      name: raw.name,
      url,
      headers: toNameValueList(raw.headers),
    }
  }

  if (typeof raw.command !== 'string' || raw.command.length === 0) return null
  return {
    name: raw.name,
    command: raw.command,
    args: Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : [],
    env: toNameValueList(raw.env),
  }
}

/** Builds the stdio MCP server entry for a project-local MCP server file. */
export function buildProjectMcpServer(
  config: AcpProjectMcpConfig,
  logger?: Logger
): AcpMcpServerConfig | null {
  const serverPath = path.resolve(config.path)
  if (!existsSync(serverPath)) {
    logger?.warn?.(`[ACP] Project MCP server not found: ${serverPath}. Skipping project MCP.`)
    return null
  }
  return {
    name: config.name ?? 'project-tools',
    command: config.command ?? 'node',
    args: [serverPath],
    env: [],
  }
}

/**
 * Build runtime configuration for an ACP agent.
 *
 * The positional form `(agentId, getEnv, envSource, logger)` is kept for compatibility;
 * a function as the second argument selects it.
 */
export function buildAcpRuntimeConfig(
  agentId: string,
  options?: AcpRuntimeOptions
): AcpAgentRuntimeConfig | null
export function buildAcpRuntimeConfig(
  agentId: string,
  getEnv?: (key: string) => string | undefined,
  envSource?: Record<string, string | undefined>,
  logger?: Logger
): AcpAgentRuntimeConfig | null
export function buildAcpRuntimeConfig(
  agentId: string,
  optionsOrGetEnv?: AcpRuntimeOptions | ((key: string) => string | undefined),
  positionalEnvSource?: Record<string, string | undefined>,
  positionalLogger?: Logger
): AcpAgentRuntimeConfig | null {
  const options = runtimeOptions(optionsOrGetEnv, positionalEnvSource, positionalLogger, arguments.length)
  const getEnv = options.getEnv ?? ((key: string) => process.env[key])
  const envSource = options.envSource ?? process.env

  const config = getAcpAgentConfig(agentId)
  if (!config) return null

  const prefix = config.envVarPrefix

  return {
    // Each override (command, args, cwd) comes from the environment when set.
    command: getEnv(`${prefix}_PATH`) || config.command,
    args: parseAcpArgs(getEnv(`${prefix}_ARGS`), config.args, options.logger),
    cwd: path.resolve(getEnv(`${prefix}_CWD`) || process.cwd()),
    env: {
      ...credentialsFrom(config, agentId, getEnv),
      ...customEnvFrom(envSource, prefix),
    },
    mcpServers: [
      ...mcpServersFromEnv(agentId, getEnv(`${prefix}_MCP_SERVERS`), options.logger),
      ...projectMcpFromEnv(getEnv, prefix, options.projectMcpPath, options.logger),
    ],
    authMethodId: config.authMethodId,
  }
}

/** Positional form: getEnv is a function, or explicitly undefined with trailing arguments. */
function runtimeOptions(
  optionsOrGetEnv: AcpRuntimeOptions | ((key: string) => string | undefined) | undefined,
  positionalEnvSource: Record<string, string | undefined> | undefined,
  positionalLogger: Logger | undefined,
  argCount: number
): AcpRuntimeOptions {
  const isPositional =
    typeof optionsOrGetEnv === 'function' || (optionsOrGetEnv === undefined && argCount > 2)
  if (isPositional) {
    return {
      getEnv: optionsOrGetEnv as ((key: string) => string | undefined) | undefined,
      envSource: positionalEnvSource,
      logger: positionalLogger,
    }
  }
  return (optionsOrGetEnv as AcpRuntimeOptions | undefined) ?? {}
}

/** The agent's declared credentials: the first source with a value wins. An agent registered without credentialEnv inherits the built-in agent's with the same id. */
function credentialsFrom(
  config: AcpAgentConfig,
  agentId: string,
  getEnv: (key: string) => string | undefined
): Record<string, string> {
  const env: Record<string, string> = {}
  const credentialEnv = config.credentialEnv ?? DEFAULT_ACP_AGENTS[agentId]?.credentialEnv ?? []
  for (const { target, sources } of credentialEnv) {
    const value = sources.map((source) => getEnv(source)).find(Boolean)
    if (value) env[target] = value
  }
  return env
}

/** Custom env vars from the ACP_<AGENT>_ENV_* pattern. */
function customEnvFrom(
  envSource: Record<string, string | undefined>,
  prefix: string
): Record<string, string> {
  const env: Record<string, string> = {}
  const envPrefix = `${prefix}_ENV_`
  for (const [key, value] of Object.entries(envSource)) {
    if (key.startsWith(envPrefix) && value !== undefined) {
      env[key.slice(envPrefix.length)] = value
    }
  }
  return env
}

/** MCP servers from ACP_<AGENT>_MCP_SERVERS (a JSON array), validated; invalid entries are dropped with a warning. */
function mcpServersFromEnv(
  agentId: string,
  mcpConfigJson: string | undefined,
  logger: Logger | undefined
): AcpMcpServerConfig[] {
  if (!mcpConfigJson) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(mcpConfigJson)
  } catch {
    logger?.warn?.(`[ACP] Invalid MCP servers JSON for ${agentId}`)
    return []
  }
  if (!Array.isArray(parsed)) return []

  const servers: AcpMcpServerConfig[] = []
  for (const entry of parsed) {
    const server = normalizeMcpServer(entry)
    if (server) servers.push(server)
    else logger?.warn?.(`[ACP] Ignoring invalid MCP server entry for ${agentId}`)
  }
  return servers
}

/** The project MCP server, when ACP_<AGENT>_ENABLE_PROJECT_MCP is "true" and a path is known. */
function projectMcpFromEnv(
  getEnv: (key: string) => string | undefined,
  prefix: string,
  fallbackPath: string | undefined,
  logger: Logger | undefined
): AcpMcpServerConfig[] {
  if (getEnv(`${prefix}_ENABLE_PROJECT_MCP`) !== 'true') return []
  const projectPath = getEnv(`${prefix}_PROJECT_MCP_PATH`) || fallbackPath
  if (!projectPath) {
    logger?.warn?.(
      `[ACP] ${prefix}_ENABLE_PROJECT_MCP is set but ${prefix}_PROJECT_MCP_PATH is not; skipping project MCP.`
    )
    return []
  }
  const server = buildProjectMcpServer({ path: projectPath }, logger)
  return server ? [server] : []
}

/**
 * Create provider entry for models.dev registry.
 */
export function createAcpProviderEntry(agentId: string): {
  id: string
  name: string
  env: string[]
  npm: string
  protocol: string
  models: Record<string, { id: string; name: string }>
} | null {
  const config = getAcpAgentConfig(agentId)
  if (!config) return null

  const prefix = config.envVarPrefix

  return {
    id: `acp-${agentId}`,
    name: config.name,
    env: [
      `${prefix}_PATH`,
      `${prefix}_CWD`,
      `${prefix}_ARGS`,
      `${prefix}_MCP_SERVERS`,
      `${prefix}_ENABLE_PROJECT_MCP`,
      `${prefix}_PROJECT_MCP_PATH`,
    ],
    npm: '@mcpc-tech/acp-ai-provider',
    protocol: 'acp',
    models: {
      [agentId]: {
        id: agentId,
        name: `${config.name} Agent`,
      },
    },
  }
}

/**
 * Get all ACP provider entries for models catalog.
 */
export function getAllAcpProviderEntries(): ReturnType<typeof createAcpProviderEntry>[] {
  return listAcpAgentIds()
    .map((id) => createAcpProviderEntry(id))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
}

/**
 * Environment variable keys used across ACP agents.
 */
export function getAcpEnvVarKeys(): {
  apiKeys: string[]
  agents: Record<
    string,
    {
      path: string
      cwd: string
      args: string
      mcpServers: string
      enableProjectMcp: string
    }
  >
} {
  const agents: Record<
    string,
    { path: string; cwd: string; args: string; mcpServers: string; enableProjectMcp: string }
  > = {}

  for (const [id, config] of Object.entries(ACP_AGENTS)) {
    const p = config.envVarPrefix
    agents[id] = {
      path: `${p}_PATH`,
      cwd: `${p}_CWD`,
      args: `${p}_ARGS`,
      mcpServers: `${p}_MCP_SERVERS`,
      enableProjectMcp: `${p}_ENABLE_PROJECT_MCP`,
    }
  }

  return {
    apiKeys: [
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'OPENAI_API_KEY',
      'DASHSCOPE_API_KEY',
      'OPENCODE_API_KEY',
      'FREEBUFF_API_KEY',
    ],
    agents,
  }
}
