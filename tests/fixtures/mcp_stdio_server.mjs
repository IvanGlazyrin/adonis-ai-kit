// A minimal MCP server on stdio (JSON-RPC, one message per line). It has one tool, `probe`, which reports which
// environment variables it can see. Used by tests/unit/mcp/sdk_client.spec.ts; it is not part of the package.
import readline from 'node:readline'

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

const tools = [{ name: 'probe', description: 'Reports the environment variables this process can see', inputSchema: { type: 'object', properties: {} } }]

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.id === undefined) return
  switch (message.method) {
    case 'initialize':
      return send({
        id: message.id,
        result: {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'stdio-fixture', version: '1.0.0' },
        },
      })
    case 'tools/list':
      return send({ id: message.id, result: { tools } })
    case 'tools/call': {
      const seen = {
        secret: process.env.AI_TEST_SECRET ?? 'absent',
        path: process.env.PATH ? 'inherited' : 'absent',
      }
      return send({ id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(seen) }] } })
    }
    default:
      return send({ id: message.id, error: { code: -32601, message: 'method not found' } })
  }
})
