import { test } from '@japa/runner'
import { resolvePlatformCommand } from '../../../src/acp/provider.js'

test.group('resolvePlatformCommand cross-platform execution', () => {
  test('leaves command and args unchanged on unix (linux/darwin)', ({ assert }) => {
    const linux = resolvePlatformCommand('opencode', ['acp'], 'linux')
    assert.equal(linux.command, 'opencode')
    assert.deepEqual(linux.args, ['acp'])

    const darwin = resolvePlatformCommand('claude-code-acp', [], 'darwin')
    assert.equal(darwin.command, 'claude-code-acp')
    assert.deepEqual(darwin.args, [])
  })

  test('wraps non-exe commands with cmd.exe on Windows', ({ assert }) => {
    const comspec = process.env.COMSPEC || 'cmd.exe'
    const win = resolvePlatformCommand('opencode', ['acp'], 'win32')
    assert.equal(win.command, comspec)
    assert.deepEqual(win.args, ['/c', 'opencode', 'acp'])

    const batch = resolvePlatformCommand('agent.cmd', ['--flag'], 'win32')
    assert.equal(batch.command, comspec)
    assert.deepEqual(batch.args, ['/c', 'agent.cmd', '--flag'])
  })

  test('preserves native .exe and avoids double wrapping on Windows', ({ assert }) => {
    const exe = resolvePlatformCommand('C:\\bin\\agent.exe', ['--run'], 'win32')
    assert.equal(exe.command, 'C:\\bin\\agent.exe')
    assert.deepEqual(exe.args, ['--run'])

    const alreadyCmd = resolvePlatformCommand('cmd.exe', ['/c', 'opencode', 'acp'], 'win32')
    assert.equal(alreadyCmd.command, 'cmd.exe')
    assert.deepEqual(alreadyCmd.args, ['/c', 'opencode', 'acp'])

    const fullPath = resolvePlatformCommand('C:\\Windows\\System32\\cmd.exe', ['/c', 'gemini'], 'win32')
    assert.equal(fullPath.command, 'C:\\Windows\\System32\\cmd.exe')
    assert.deepEqual(fullPath.args, ['/c', 'gemini'])
  })
})
