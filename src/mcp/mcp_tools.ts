import { detectToolDrift, fingerprintTools } from 'ai'
import { normalizeMcpServer } from '../acp/acp_agents.js'
import type { AcpMcpServerConfig } from '../acp/types.js'
import { AiException } from '../errors.js'
import type { Logger } from '../logger.js'
import type { ToolRegistry } from '../guard/registry.js'
import type { ToolDefinition } from '../guard/types.js'
import { safeDescription } from './describe.js'
import { assertServerKey, mcpToolName } from './naming.js'
import { MCP_TOOL, type McpClientLike, type McpConfig, type McpServerConfig, type McpToolDefinition } from './types.js'

/** The `@ai-sdk/mcp` pieces the kit uses. Typed here so the kit's declarations do not depend on the optional package. */
export interface McpSdk {
  createMCPClient(config: { transport: unknown; protocolVersionDiscovery?: boolean }): Promise<McpClientLike>
  StdioTransport: new (config: { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }) => unknown
}

export interface McpToolsOptions {
  logger?: Logger
  /**
   * Loads `@ai-sdk/mcp`. Default: a dynamic import of the package and its stdio subpath. A failure becomes
   * `E_AI_MISSING_DEPENDENCY`. Tests replace it to simulate a missing package.
   */
  loadModule?: () => Promise<McpSdk>
  /** Connects one server. Default: `createMCPClient` with the transport of the server's config. Tests replace it. */
  connect?: (server: string, config: McpServerConfig) => Promise<McpClientLike>
}

/** Normalized server definitions by key. Unusable entries are left out (with a warning). */
export function normalizeServers(
  servers: Record<string, McpServerConfig>,
  logger: Pick<Logger, 'warn'> | undefined
): Record<string, AcpMcpServerConfig> {
  const out: Record<string, AcpMcpServerConfig> = {}
  for (const [key, config] of Object.entries(servers)) {
    assertServerKey(key)
    const normalized = normalizeMcpServer({ ...config, name: key })
    if (normalized) {
      out[key] = normalized
    } else {
      logger?.warn?.(`[MCP] Server "${key}" has no usable command or URL; skipped.`)
    }
  }
  return out
}

/** Loads `@ai-sdk/mcp` and its stdio transport. */
async function loadSdk(): Promise<McpSdk> {
  const [client, stdio] = await Promise.all([import('@ai-sdk/mcp'), import('@ai-sdk/mcp/mcp-stdio')])
  return {
    createMCPClient: client.createMCPClient as unknown as McpSdk['createMCPClient'],
    StdioTransport: stdio.Experimental_StdioMCPTransport as unknown as McpSdk['StdioTransport'],
  }
}

/**
 * MCP servers as tools for `ToolRegistry`. Each server is connected lazily on the first `registerTools()` and its
 * tools are registered without a permission, so the registry's `defaultPermission` (`deny`) applies to them.
 * A server that fails is skipped with a warning; the other servers keep working.
 */
export class McpTools {
  private readonly servers: Record<string, McpServerConfig>
  private readonly requirePins: boolean
  private readonly logger?: Logger
  private readonly loadModule: () => Promise<McpSdk>
  private readonly connectServer?: McpToolsOptions['connect']
  private readonly clients = new Map<string, McpClientLike>()
  /** Tool name → `server/tool` of the registration this instance made, so a repeated `registerTools()` is a no-op. */
  private readonly registered = new Map<string, string>()

  constructor(config: McpConfig | undefined, options: McpToolsOptions = {}) {
    this.logger = options.logger
    this.requirePins = config?.requirePins ?? false
    const declared = config?.servers ?? {}
    const usable = normalizeServers(declared, this.logger)
    this.servers = Object.fromEntries(Object.entries(declared).filter(([key]) => Object.hasOwn(usable, key)))
    this.loadModule = options.loadModule ?? loadSdk
    this.connectServer = options.connect
  }

  /**
   * Connects the servers that are not connected yet and registers their tools (without a permission) in `registry`.
   * Rejects only when `@ai-sdk/mcp` is missing (`E_AI_MISSING_DEPENDENCY`); other failures are per server.
   */
  async registerTools(registry: ToolRegistry): Promise<void> {
    for (const server of Object.keys(this.servers)) {
      let tools: Record<string, ToolDefinition>
      let names: string[]
      try {
        ;({ tools, names } = await this.listServer(server))
      } catch (err) {
        if (err instanceof AiException && err.code === 'E_AI_MISSING_DEPENDENCY') throw err
        this.logger?.warn?.(`[MCP] Server "${server}" is unavailable; its tools are not registered: ${messageOf(err)}`)
        continue
      }
      await this.registerServerTools(registry, server, tools, names)
    }
  }

  /** Fingerprints (`fingerprintTools`) of every tool the server lists, by the tool name the server knows. Use it to fill `pins`. */
  async fingerprint(server: string): Promise<Record<string, string>> {
    if (!Object.hasOwn(this.servers, server)) {
      throw new AiException(`MCP server "${server}" is not configured.`, 'E_AI_CONFIG_ERROR')
    }
    const { tools } = await this.listServer(server)
    return fingerprintTools(tools as unknown as Parameters<typeof fingerprintTools>[0])
  }

  /** Closes every connected server. Tools stay in the registry; their calls then fail. */
  async close(): Promise<void> {
    const open = [...this.clients.entries()]
    this.clients.clear()
    const settled = await Promise.allSettled(open.map(([, client]) => client.close()))
    settled.forEach((result, i) => {
      if (result.status === 'rejected') {
        this.logger?.warn?.(`[MCP] Closing server "${open[i][0]}" failed: ${messageOf(result.reason)}`)
      }
    })
  }

  private async registerServerTools(
    registry: ToolRegistry,
    server: string,
    tools: Record<string, ToolDefinition>,
    names: string[]
  ): Promise<void> {
    const config = this.servers[server]
    const selected = names.filter((name) => tools[name] !== undefined && (!config.tools || config.tools.includes(name)))
    const drifted = await this.driftedTools(config, tools, selected)
    for (const name of selected) {
      const tool = tools[name]
      const origin = `${server}/${name}`
      if (drifted.has(name)) {
        this.logger?.warn?.(`[MCP] Tool "${origin}" changed since it was pinned; not registered. Review it, then update its pin.`)
        continue
      }
      if (this.requirePins && !(config.pins && Object.hasOwn(config.pins, name))) {
        this.logger?.warn?.(`[MCP] Tool "${origin}" has no pin and requirePins is set; not registered.`)
        continue
      }
      const toolName = mcpToolName(server, name)
      if (toolName === null) {
        this.logger?.warn?.(`[MCP] Tool "${server}/${name}" has no name within 64 characters; not registered.`)
        continue
      }
      if (this.registered.get(toolName) === origin) continue
      if (registry.hasTool(toolName)) {
        this.logger?.warn?.(`[MCP] Tool name "${toolName}" is already registered; "${origin}" is not registered.`)
        continue
      }
      registry.registerTool(toolName, {
        ...tool,
        description: this.descriptionOf(server, name, tool),
        [MCP_TOOL]: { server, tool: name },
      })
      this.registered.set(toolName, origin)
    }
  }

  /** Names of the tools whose definition differs from their pin. Empty when the server has no pins. */
  private async driftedTools(
    config: McpServerConfig,
    tools: Record<string, ToolDefinition>,
    names: string[]
  ): Promise<Set<string>> {
    if (!config.pins) return new Set()
    const selected = Object.fromEntries(names.map((name) => [name, tools[name]]))
    const current = await fingerprintTools(selected as unknown as Parameters<typeof fingerprintTools>[0])
    return new Set(detectToolDrift(current, config.pins).changed)
  }

  /** The app's `describe` text when it has one (trusted, used as is), else the cleaned server description. */
  private descriptionOf(server: string, name: string, tool: ToolDefinition): string {
    const described = this.servers[server].describe
    if (described && Object.hasOwn(described, name)) return described[name]
    return safeDescription(server, typeof tool.description === 'string' ? tool.description : undefined)
  }

  /** The server's tools by name, and the names in the order the server lists them. Connects on first use. */
  private async listServer(server: string): Promise<{ tools: Record<string, ToolDefinition>; names: string[] }> {
    const client = await this.clientOf(server)
    const definitions = await listAllTools(client)
    const tools = client.toolsFromDefinitions({ tools: definitions })
    return { tools, names: definitions.map((def) => def.name) }
  }

  private async clientOf(server: string): Promise<McpClientLike> {
    const connected = this.clients.get(server)
    if (connected) return connected
    const client = await this.connect(server, this.servers[server])
    this.clients.set(server, client)
    return client
  }

  private connect(server: string, config: McpServerConfig): Promise<McpClientLike> {
    if (this.connectServer) return this.connectServer(server, config)
    return this.connectWithSdk(config)
  }

  private async connectWithSdk(config: McpServerConfig): Promise<McpClientLike> {
    const sdk = await this.sdk()
    const transport =
      config.type === undefined
        ? new sdk.StdioTransport({ command: config.command, args: config.args, env: config.env, cwd: config.cwd })
        : { type: config.type, url: config.url, headers: config.headers }
    return sdk.createMCPClient({ transport })
  }

  private async sdk(): Promise<McpSdk> {
    try {
      return await this.loadModule()
    } catch (err) {
      throw new AiException(
        `MCP tools require package "@ai-sdk/mcp" (npm install @ai-sdk/mcp). Error: ${messageOf(err)}`,
        'E_AI_MISSING_DEPENDENCY',
        err
      )
    }
  }
}

/** Pages of `listTools` read at most; a server that keeps answering with new cursors is cut off here. */
const MAX_TOOL_PAGES = 100

/** Every page of `listTools`, stopping at a repeated cursor or at `MAX_TOOL_PAGES`. */
async function listAllTools(client: McpClientLike): Promise<McpToolDefinition[]> {
  const all: McpToolDefinition[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const result = await client.listTools(cursor === undefined ? undefined : { params: { cursor } })
    all.push(...result.tools)
    cursor = result.nextCursor
    if (cursor === undefined || seen.has(cursor)) return all
    seen.add(cursor)
  }
  return all
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
