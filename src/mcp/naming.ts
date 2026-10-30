import { AiException } from '../errors.js'

/**
 * Longest tool name the kit produces. Providers limit tool names to 64 characters of `[A-Za-z0-9_-]`
 * (Anthropic documents this; the kit's provider packages do not check it locally). Longer names are refused, not cut.
 */
export const MCP_TOOL_NAME_MAX = 64

const SERVER_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

/** Throws `E_AI_CONFIG_ERROR` unless the key is 1 to 32 characters of `[A-Za-z0-9_-]`, starting with a letter or digit. */
export function assertServerKey(server: string): void {
  if (!SERVER_KEY.test(server)) {
    throw new AiException(
      `MCP server key "${server}" must match ${SERVER_KEY.source} (1-32 characters, letters, digits, "_" or "-").`,
      'E_AI_CONFIG_ERROR'
    )
  }
}

/**
 * The name a tool is registered under: `mcp__<server>__<tool>`, with every character outside `[A-Za-z0-9_-]`
 * in the tool name replaced by `_`. Returns `null` when the name is empty or longer than 64 characters.
 */
export function mcpToolName(server: string, tool: string): string | null {
  assertServerKey(server)
  const safe = tool.replace(/[^A-Za-z0-9_-]/g, '_')
  if (safe.length === 0) return null
  const name = `mcp__${server}__${safe}`
  return name.length <= MCP_TOOL_NAME_MAX ? name : null
}
