import { test } from '@japa/runner'
import { ConfirmationService } from '../../../src/guard/confirmation.js'

const action = (sessionId?: string) =>
  ({ sessionId, toolName: 'send_mail', action: 'Send mail', params: { to: 'a' } }) as any

test.group('ConfirmationService', () => {
  test('an approval resolves the waiting call and the action is visible while pending', async ({ assert }) => {
    const svc = new ConfirmationService()
    const pending = svc.waitForResponse(action(), 1_000)

    const [listed] = svc.getPendingActions()
    assert.equal(listed.toolName, 'send_mail')
    assert.equal(listed.status, 'pending')
    assert.deepEqual(svc.getPendingAction(listed.id)?.params, { to: 'a' })

    assert.isTrue(svc.approve(listed.id, 'looks fine'))
    assert.deepEqual(await pending, { status: 'approved', reason: 'looks fine' })
    assert.isNull(svc.getPendingAction(listed.id))
  })

  test('a rejection resolves the waiting call as rejected', async ({ assert }) => {
    const svc = new ConfirmationService()
    const pending = svc.waitForResponse(action(), 1_000)
    const [listed] = svc.getPendingActions()

    assert.isTrue(svc.reject(listed.id, 'no'))
    assert.deepEqual(await pending, { status: 'rejected', reason: 'no' })
  })

  test('an action bound to a session is only decided by that session', async ({ assert }) => {
    const svc = new ConfirmationService()
    const pending = svc.waitForResponse(action('s1'), 1_000)
    const [listed] = svc.getPendingActions('s1')

    assert.isFalse(svc.approve(listed.id, undefined, 's2'))
    assert.lengthOf(svc.getPendingActions(), 1)
    assert.isTrue(svc.approve(listed.id, undefined, 's1'))
    assert.equal((await pending).status, 'approved')
  })

  test('deciding an unknown or already-decided action returns false', async ({ assert }) => {
    const svc = new ConfirmationService()
    assert.isFalse(svc.approve('no-such-id'))

    const pending = svc.waitForResponse(action(), 1_000)
    const [listed] = svc.getPendingActions()
    svc.approve(listed.id)
    await pending
    assert.isFalse(svc.reject(listed.id))
  })

  test('the pending list can be filtered by session', async ({ assert }) => {
    const svc = new ConfirmationService()
    void svc.waitForResponse(action('a'), 1_000)
    void svc.waitForResponse(action('b'), 1_000)

    assert.lengthOf(svc.getPendingActions('a'), 1)
    assert.lengthOf(svc.getPendingActions(), 2)
    svc.dispose()
  })

  test('no decision in time times out without approving', async ({ assert }) => {
    const svc = new ConfirmationService()
    const response = await svc.waitForResponse(action(), 10)

    assert.deepEqual(response, { status: 'timeout', reason: 'Confirmation timeout' })
  })

  test('an abort signal rejects the waiting call', async ({ assert }) => {
    const svc = new ConfirmationService()
    const controller = new AbortController()
    const pending = svc.waitForResponse(action(), 1_000, controller.signal)

    controller.abort()

    assert.deepEqual(await pending, { status: 'rejected', reason: 'Aborted' })
    assert.lengthOf(svc.getPendingActions(), 0)
  })

  test('an already-aborted signal is rejected at once', async ({ assert }) => {
    const controller = new AbortController()
    controller.abort()

    assert.deepEqual(await new ConfirmationService().waitForResponse(action(), 1_000, controller.signal), {
      status: 'rejected',
      reason: 'Aborted',
    })
  })

  test('an action past its deadline settles as timed out, and clearExpired finds nothing left', async ({ assert }) => {
    const svc = new ConfirmationService()
    const pending = svc.waitForResponse(action(), 20)

    await new Promise((resolve) => setTimeout(resolve, 40))
    svc.clearExpired()

    assert.deepEqual(await pending, { status: 'timeout', reason: 'Confirmation timeout' })
    assert.lengthOf(svc.getPendingActions(), 0)
  })

  test('dispose rejects everything pending and refuses new waits', async ({ assert }) => {
    const svc = new ConfirmationService()
    const pending = svc.waitForResponse(action(), 1_000)

    svc.dispose()

    assert.deepEqual(await pending, { status: 'rejected', reason: 'Confirmation service disposed' })
    assert.deepEqual(await svc.waitForResponse(action(), 1_000), {
      status: 'rejected',
      reason: 'Confirmation service disposed',
    })
  })

  test('listeners hear about created and resolved actions, and a throwing listener does not break others', async ({ assert }) => {
    const svc = new ConfirmationService()
    const created: string[] = []
    const resolved: string[] = []
    svc.onActionCreated(() => {
      throw new Error('listener broke')
    })
    const stop = svc.onActionCreated((a) => void created.push(a.toolName))
    svc.onActionResolved((a, r) => void resolved.push(`${a.status}:${r.status}`))

    const pending = svc.waitForResponse(action(), 1_000)
    const [listed] = svc.getPendingActions()
    svc.approve(listed.id)
    await pending

    assert.deepEqual(created, ['send_mail'])
    assert.deepEqual(resolved, ['approved:approved'])

    stop()
    const second = svc.waitForResponse(action(), 1_000)
    svc.approve(svc.getPendingActions()[0].id)
    await second
    assert.deepEqual(created, ['send_mail'])
  })
})
