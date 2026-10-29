import { test } from '@japa/runner'
import { PolicyViolationError, ToolRegistry } from '../../../src/guard/index.js'

/** A guard that records each call. `verdict` is what check() returns (null allows). */
const makeGuard = (verdict: string | null = null) => {
  const calls: string[] = []
  const guard = {
    check: (name: string) => {
      calls.push(`check:${name}`)
      return verdict
    },
    record: (name: string, result: unknown) => {
      calls.push(`record:${name}:${JSON.stringify(result)}`)
    },
    release: (name: string) => {
      calls.push(`release:${name}`)
    },
  }
  return { calls, guard }
}

/** A confirmation service that answers with `response` and remembers what it was asked. */
const makeConfirmation = (response: { status: string; reason?: string }) => {
  const asked: any[] = []
  const confirmation = {
    waitForResponse: async (action: unknown, timeoutMs: unknown, signal: unknown) => {
      asked.push({ action, timeoutMs, signal })
      return response
    },
  }
  return { asked, confirmation }
}

const registry = () => new ToolRegistry()

test.group('ToolRegistry wrapTool', () => {
  test('a tool without execute is returned as it is', ({ assert }) => {
    const tool = { description: 'client side' }
    assert.strictEqual(registry().wrapTool('t', tool), tool)
  })

  test('an allowed call runs the tool and returns its result', async ({ assert }) => {
    const wrapped = registry().wrapTool('t', { description: 't', execute: async (args: any) => args.n * 2 })
    assert.equal(await wrapped.execute!({ n: 4 }, undefined as any), 8)
  })

  test('a denied tool throws and never runs', async ({ assert }) => {
    let ran = false
    const wrapped = registry().wrapTool(
      't',
      { description: 't', execute: async () => ((ran = true), 1) },
      { permission: 'deny' }
    )

    await assert.rejects(() => wrapped.execute!({}, undefined as any), /permission is "deny"/)
    assert.isFalse(ran)
    assert.instanceOf(await wrapped.execute!({}, undefined as any).catch((e: unknown) => e), PolicyViolationError)
  })

  test('a call the guard rejects returns a policy error and runs nothing', async ({ assert }) => {
    const { calls, guard } = makeGuard('too many calls')
    let ran = false
    const wrapped = registry().wrapTool(
      't',
      { description: 't', execute: async () => ((ran = true), 1) },
      { guard }
    )

    const result = await wrapped.execute!({ a: 1 }, undefined as any)

    assert.deepEqual(result, {
      error: 'Rejected by policy guard: too many calls. Adjust parameters to match approved bounds.',
    })
    assert.isFalse(ran)
    assert.deepEqual(calls, ['check:t'])
  })

  test('an allowed call is recorded in the guard with its result', async ({ assert }) => {
    const { calls, guard } = makeGuard()
    const wrapped = registry().wrapTool('t', { description: 't', execute: async () => ({ ok: true }) }, { guard })

    assert.deepEqual(await wrapped.execute!({}, undefined as any), { ok: true })
    assert.deepEqual(calls, ['check:t', 'record:t:{"ok":true}'])
  })

  test('a tool that throws is recorded as a failed call and the error is rethrown', async ({ assert }) => {
    const { calls, guard } = makeGuard()
    const wrapped = registry().wrapTool(
      't',
      {
        description: 't',
        execute: async () => {
          throw new Error('disk full')
        },
      },
      { guard }
    )

    await assert.rejects(() => wrapped.execute!({}, undefined as any), 'disk full')
    assert.deepEqual(calls, ['check:t', 'record:t:{"error":"disk full"}'])
  })

  test('ask without a confirmation service fails closed and gives the call slot back', async ({ assert }) => {
    const { calls, guard } = makeGuard()
    let ran = false
    const wrapped = registry().wrapTool(
      't',
      { description: 't', execute: async () => ((ran = true), 1) },
      { permission: 'ask', guard }
    )

    await assert.rejects(() => wrapped.execute!({}, undefined as any), /no ConfirmationService/)
    assert.isFalse(ran)
    assert.deepEqual(calls, ['check:t', 'release:t'])
  })

  test('an approved ask runs the tool and passes the call details to the confirmation', async ({ assert }) => {
    const { asked, confirmation } = makeConfirmation({ status: 'approved' })
    const signal = new AbortController().signal
    const wrapped = registry().wrapTool(
      't',
      { description: 'Send mail', execute: async () => 'sent' },
      { permission: 'ask', confirmation: confirmation as any, sessionId: 's9', timeoutMs: 5000 }
    )

    assert.equal(await wrapped.execute!({ to: 'a' }, { abortSignal: signal } as any), 'sent')

    assert.equal(asked[0].timeoutMs, 5000)
    assert.strictEqual(asked[0].signal, signal)
    assert.equal(asked[0].action.toolName, 't')
    assert.equal(asked[0].action.sessionId, 's9')
    assert.deepEqual(asked[0].action.params, { to: 'a' })
  })

  test('a declined ask returns a not-executed error with the reason, and gives the slot back', async ({ assert }) => {
    const { calls, guard } = makeGuard()
    const { confirmation } = makeConfirmation({ status: 'rejected', reason: 'not now' })
    let ran = false
    const wrapped = registry().wrapTool(
      't',
      { description: 't', execute: async () => ((ran = true), 1) },
      { permission: 'ask', confirmation: confirmation as any, guard }
    )

    const result = await wrapped.execute!({}, undefined as any)

    assert.deepEqual(result, { error: 'Tool "t" was not executed: rejected. not now' })
    assert.isFalse(ran)
    assert.deepEqual(calls, ['check:t', 'release:t'])
  })

  test('a declined ask with no reason still trims its error message', async ({ assert }) => {
    const { confirmation } = makeConfirmation({ status: 'timeout' })
    const wrapped = registry().wrapTool(
      't',
      { description: 't', execute: async () => 1 },
      { permission: 'ask', confirmation: confirmation as any }
    )

    assert.deepEqual(await wrapped.execute!({}, undefined as any), {
      error: 'Tool "t" was not executed: timeout.',
    })
  })
})
