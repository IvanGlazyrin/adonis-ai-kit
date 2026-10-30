import { dynamicTool, jsonSchema } from 'ai'
import type { McpClientLike, McpListToolsResult, McpToolDefinition } from '../../../src/mcp/types.js'

export interface FakeTool {
  description?: string
  inputSchema?: Record<string, unknown>
  /** Answer of `callTool`. Default: a text result. */
  reply?: (args: unknown) => unknown
}

export interface FakeServerOptions {
  tools: Record<string, FakeTool>
  /** Tools per page of `listTools`. Default: all tools on one page. */
  pageSize?: number
  /** Every `callTool` in order, with the name the server knows the tool by. */
  calls?: Array<{ name: string; args: unknown }>
}

/**
 * An in-process MCP client double. It lists the given tools and answers `callTool`, through the same
 * `toolsFromDefinitions` path the real client uses (the tools' `execute` calls `callTool`).
 */
export class FakeMcpClient implements McpClientLike {
  closed = false
  readonly calls: Array<{ name: string; args: unknown }>

  constructor(private readonly options: FakeServerOptions) {
    this.calls = options.calls ?? []
  }

  async listTools(options?: { params?: { cursor?: string } }): Promise<McpListToolsResult> {
    const all: McpToolDefinition[] = Object.entries(this.options.tools).map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
    }))
    const size = this.options.pageSize ?? all.length
    const start = Number(options?.params?.cursor ?? 0)
    const end = start + size
    return {
      tools: all.slice(start, end),
      nextCursor: end < all.length ? String(end) : undefined,
    }
  }

  toolsFromDefinitions(definitions: { tools: McpToolDefinition[] }) {
    const out: Record<string, ReturnType<typeof dynamicTool>> = {}
    for (const def of definitions.tools) {
      out[def.name] = dynamicTool({
        description: def.description,
        inputSchema: jsonSchema(def.inputSchema as Parameters<typeof jsonSchema>[0]),
        execute: async (args: unknown) => this.callTool(def.name, args),
      })
    }
    return out
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    this.calls.push({ name, args })
    const tool = this.options.tools[name]
    if (!tool) throw new Error(`unknown tool ${name}`)
    return tool.reply ? tool.reply(args) : { content: [{ type: 'text', text: `${name} ok` }] }
  }

  async close(): Promise<void> {
    this.closed = true
  }
}
