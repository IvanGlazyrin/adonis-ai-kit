import type { ToolDefinition } from '../guard/types.js'

/**
 * Marks a tool that came from an MCP server. The tool is then fail-closed: without an explicit permission
 * (in the registry's agent matrix, in `toolPermissions` or in the agent manifest) it is not offered to the model,
 * even when it is passed to `AiManager` or `AgentRunner` directly. `Symbol.for` keeps the mark across module copies.
 */
export const MCP_TOOL = Symbol.for('adonis-ai-kit.mcp-tool')

/** Where an MCP tool came from: the server key in `AiConfig.mcp.servers` and the tool name the server knows it by. */
export interface McpToolMark {
  server: string
  tool: string
}

interface McpServerOptions {
  /** Only these tools of the server are registered (names as the server reports them). Absent: all tools. */
  tools?: string[]
  /** Replaces a tool's description entirely. Trusted: the app wrote it. */
  describe?: Record<string, string>
  /**
   * Fingerprints from `ai.mcp.fingerprint(server)`, by tool name. A tool whose definition changed is not registered; one
   * registered before the change then refuses every call.
   */
  pins?: Record<string, string>
}

/** A server started as a child process (stdio). The child gets only a whitelist of the parent's environment plus `env`. */
export interface McpStdioServerConfig extends McpServerOptions {
  type?: undefined
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

/** A remote server (Streamable HTTP or SSE). Redirects are refused. */
export interface McpRemoteServerConfig extends McpServerOptions {
  type: 'http' | 'sse'
  url: string
  headers?: Record<string, string>
}

export type McpServerConfig = McpStdioServerConfig | McpRemoteServerConfig

export interface McpConfig {
  /** Servers by key. The key is part of every tool name (`mcp__<key>__<tool>`). Set in code or config only. */
  servers: Record<string, McpServerConfig>
  /** When true, a tool without a pin is not registered. Default: false. */
  requirePins?: boolean
}

/** A tool definition as a server lists it (MCP `tools/list`). */
export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema?: unknown
  [key: string]: unknown
}

/** One page of `listTools`. */
export interface McpListToolsResult {
  tools: McpToolDefinition[]
  nextCursor?: string
}

/**
 * What the kit needs from an MCP client. `@ai-sdk/mcp`'s `MCPClient` satisfies it; tests replace it with a fake.
 */
export interface McpClientLike {
  listTools(options?: { params?: { cursor?: string } }): Promise<McpListToolsResult>
  toolsFromDefinitions(definitions: { tools: McpToolDefinition[] }): Record<string, ToolDefinition>
  close(): Promise<unknown>
}

/** Whether a tool was registered from an MCP server (it carries the `MCP_TOOL` mark). */
export function isMcpTool(tool: unknown): boolean {
  return typeof tool === 'object' && tool !== null && Object.hasOwn(tool, MCP_TOOL)
}
