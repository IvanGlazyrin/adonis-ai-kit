import { test } from '@japa/runner'
import { normalizeMcpServer } from '../../../src/acp/acp_agents.js'

test.group('normalizeMcpServer', () => {
  test('a stdio server keeps its command, args and name-value env', ({ assert }) => {
    const server = normalizeMcpServer({
      name: 'fs',
      command: 'node',
      args: ['server.js', 42, 'x'],
      env: { TOKEN: 'abc' },
    })

    assert.deepEqual(server, {
      name: 'fs',
      command: 'node',
      args: ['server.js', 'x'],
      env: [{ name: 'TOKEN', value: 'abc' }],
    })
  })

  test('a stdio server without args or env gets empty lists', ({ assert }) => {
    assert.deepEqual(normalizeMcpServer({ name: 'bare', command: 'run' }), {
      name: 'bare',
      command: 'run',
      args: [],
      env: [],
    })
  })

  test('a url with no type is treated as an http server', ({ assert }) => {
    assert.deepEqual(normalizeMcpServer({ name: 'remote', url: 'https://m.example/mcp' }), {
      type: 'http',
      name: 'remote',
      url: 'https://m.example/mcp',
      headers: [],
    })
  })

  test('sse and the legacy httpUrl field are supported', ({ assert }) => {
    const sse = normalizeMcpServer({ name: 's', type: 'sse', url: 'https://a', headers: { 'X-K': 'v' } })
    assert.equal(sse?.type, 'sse')
    assert.deepEqual(sse && 'headers' in sse ? sse.headers : null, [{ name: 'X-K', value: 'v' }])

    const legacy = normalizeMcpServer({ name: 'l', httpUrl: 'https://legacy' })
    assert.equal(legacy && 'url' in legacy ? legacy.url : null, 'https://legacy')
  })

  test('a remote server with a type but no url is rejected', ({ assert }) => {
    assert.isNull(normalizeMcpServer({ name: 'r', type: 'http' }))
  })

  test('an entry with no usable name or no command is rejected', ({ assert }) => {
    assert.isNull(normalizeMcpServer(null))
    assert.isNull(normalizeMcpServer('string'))
    assert.isNull(normalizeMcpServer({ command: 'x' }))
    assert.isNull(normalizeMcpServer({ name: '', command: 'x' }))
    assert.isNull(normalizeMcpServer({ name: 'n' }))
    assert.isNull(normalizeMcpServer({ name: 'n', command: '' }))
  })
})
