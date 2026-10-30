/** Longest description the model gets for an MCP tool, prefix included, in code points. */
export const MCP_DESCRIPTION_MAX = 1024

/**
 * The description an MCP tool is offered with. Server descriptions are untrusted: tabs and line breaks become
 * spaces, other control characters are removed, the text is prefixed with `[MCP:<server>]` so the model sees where
 * it comes from, and the result is capped at 1024 characters.
 */
export function safeDescription(server: string, description: string | undefined): string {
  const body = (description ?? '')
    .replace(/[\t\n\r]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim()
  const text = `[MCP:${server}] ${body}`.trimEnd()
  const chars = Array.from(text)
  return chars.length > MCP_DESCRIPTION_MAX ? `${chars.slice(0, MCP_DESCRIPTION_MAX - 1).join('')}…` : text
}
