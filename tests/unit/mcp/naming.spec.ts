import { test } from '@japa/runner'
import { mcpToolName, MCP_TOOL_NAME_MAX } from '../../../src/mcp/naming.js'
import { AiException } from '../../../src/errors.js'

test.group('mcp: naming', () => {
  test('mcpToolName: prefixes the server', ({ assert }) => {
    assert.equal(mcpToolName('fs', 'read'), 'mcp__fs__read')
  })

  test('mcpToolName: replaces unsafe characters', ({ assert }) => {
    assert.equal(mcpToolName('fs', 'read.file/v2 beta'), 'mcp__fs__read_file_v2_beta')
    assert.equal(mcpToolName('fs', 'keep-dash_under'), 'mcp__fs__keep-dash_under')
  })

  test('mcpToolName: refuses names over 64 chars instead of truncating', ({ assert }) => {
    assert.equal(MCP_TOOL_NAME_MAX, 64)
    const server = 'a'.repeat(32)
    // "mcp__" + 32 + "__" = 39 characters before the tool name
    assert.equal(mcpToolName(server, 'x'.repeat(25))?.length, 64)
    assert.isNull(mcpToolName(server, 'x'.repeat(26)))
  })

  test('mcpToolName: a tool name that is empty after sanitising is refused', ({ assert }) => {
    assert.isNull(mcpToolName('fs', ''))
  })

  test('invalid server key is a config error', ({ assert }) => {
    for (const bad of ['', '-fs', '_fs', 'a b', 'a.b', 'a'.repeat(33)]) {
      let code: string | undefined
      try {
        mcpToolName(bad, 'read')
      } catch (e) {
        code = e instanceof AiException ? e.code : 'other'
      }
      assert.equal(code, 'E_AI_CONFIG_ERROR', `server key "${bad}"`)
    }
  })
})
