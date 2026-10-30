import { test } from '@japa/runner'
import { normalizeServers } from '../../../src/mcp/mcp_tools.js'
import { normalizeMcpServer } from '../../../src/acp/acp_agents.js'

test.group('mcp: config', () => {
  test('config: stdio, http and sse servers normalize like ACP servers', ({ assert }) => {
    const servers = {
      fs: { command: 'node', args: ['server.js'], env: { MODE: 'ro' } },
      remote: { type: 'http' as const, url: 'https://tools.example/mcp', headers: { Authorization: 'Bearer t' } },
      events: { type: 'sse' as const, url: 'https://tools.example/sse' },
    }

    const out = normalizeServers(servers, { warn() {} })

    assert.deepEqual(Object.keys(out), ['fs', 'remote', 'events'])
    assert.deepEqual(out.fs, normalizeMcpServer({ name: 'fs', ...servers.fs }))
    assert.deepEqual(out.fs, {
      name: 'fs',
      command: 'node',
      args: ['server.js'],
      env: [{ name: 'MODE', value: 'ro' }],
    })
    assert.deepEqual(out.remote, normalizeMcpServer({ name: 'remote', ...servers.remote }))
    assert.equal(out.remote && 'type' in out.remote ? out.remote.type : undefined, 'http')
    assert.equal(out.events && 'type' in out.events ? out.events.type : undefined, 'sse')
  })

  test('config: unusable entry is skipped with a warning', ({ assert }) => {
    const warnings: string[] = []
    const out = normalizeServers(
      {
        ok: { command: 'node' },
        noCommand: { command: '' } as never,
        noUrl: { type: 'http', url: '' } as never,
      },
      { warn: (message: string) => warnings.push(message) }
    )

    assert.deepEqual(Object.keys(out), ['ok'])
    assert.equal(warnings.length, 2)
    assert.isTrue(warnings.every((w) => w.includes('noCommand') || w.includes('noUrl')))
  })
})
