import { test } from '@japa/runner'
import { CircuitBreaker } from '../../../src/circuit_breaker.js'
import { CREDENTIAL_ERROR_CLASSES } from '../../../src/error_classifier.js'
import {
  AcpCallFailedError,
  AiException,
  ProviderConfigError,
  ProviderUnavailableError,
} from '../../../src/errors.js'
import { ACP_NPM } from '../../../src/models/protocols.js'
import {
  buildChainCandidates,
  runModelChain,
  type ChainAttempt,
  type FallbackEvent,
} from '../../../src/models/model_chain.js'
import type { ModelResolver } from '../../../src/models/catalog_resolver.js'
import type { ResolvedModel } from '../../../src/models/types.js'

const A: ResolvedModel = { providerID: 'a', modelID: 'm' }
const B: ResolvedModel = { providerID: 'b', modelID: 'm' }

const SONNET = 'anthropic/claude-3-5-sonnet'
const GPT = 'openai/gpt-4o'
const GEMINI = 'google/gemini-1.5-pro'
const ENV_MODELS = [SONNET, GPT, GEMINI]

class FakeHttpError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message)
    this.name = 'FakeHttpError'
  }
}

function recordingResolver(): { resolver: ModelResolver; refs: string[] } {
  const refs: string[] = []
  const resolver: ModelResolver = {
    async resolve(ref) {
      refs.push(ref ?? '')
      const [providerID, modelID] = (ref ?? SONNET).split('/')
      return { providerID, modelID }
    },
  }
  return { resolver, refs }
}

/** Runs the chain with per-model-key handlers; unlisted models succeed with their key. */
function harness(handlers: Record<string, (a: ChainAttempt) => Promise<unknown>> = {}) {
  const calls: ChainAttempt[] = []
  const attempt = async (a: ChainAttempt) => {
    calls.push(a)
    const handler = handlers[`${a.model.providerID}/${a.model.modelID}`]
    return handler ? handler(a) : { success: true, modelRef: `${a.model.providerID}/${a.model.modelID}` }
  }
  return { calls, attempt }
}

const failWith = (message: string, status: number) => async () => {
  throw new FakeHttpError(message, status)
}

const twoCredentialChain = (): ResolvedModel[] => [
  { providerID: 'openai', modelID: 'gpt-4o', apiKey: 'sk-a', credentialKey: 'key:1' },
  { providerID: 'openai', modelID: 'gpt-4o', apiKey: 'sk-b', credentialKey: 'key:2' },
]

test.group('buildChainCandidates', () => {
  test('a non-empty chain is authoritative and suppresses primary and defaults', ({ assert }) => {
    const candidates = buildChainCandidates({ chain: [A], primary: B, defaults: ENV_MODELS })
    assert.deepEqual(candidates, [{ kind: 'resolved', model: A, key: 'a/m' }])
  })

  test('an empty chain is treated as absent', ({ assert }) => {
    const candidates = buildChainCandidates({ chain: [], defaults: [SONNET, GPT] })
    assert.deepEqual(
      candidates.map((c) => [c.kind, c.key]),
      [
        ['ref', SONNET],
        ['ref', GPT],
      ]
    )
  })

  test('chain de-duplicates on entry identity, not breaker key', ({ assert }) => {
    const chain: ResolvedModel[] = [
      { providerID: 'openai', modelID: 'gpt-a', apiKey: 'sk-a0', credentialKey: 'key:0' },
      { providerID: 'openai', modelID: 'gpt-a', apiKey: 'dup', credentialKey: 'key:0' },
      { providerID: 'openai', modelID: 'gpt-b', apiKey: 'sk-b0', credentialKey: 'key:0' },
      { providerID: 'openai', modelID: 'gpt-b', apiKey: 'sk-b1', credentialKey: 'key:1' },
    ]
    const candidates = buildChainCandidates({ chain })
    assert.deepEqual(
      candidates.map((c) => (c.kind === 'resolved' ? `${c.model.modelID}:${c.model.apiKey}` : '')),
      ['gpt-a:sk-a0', 'gpt-b:sk-b0', 'gpt-b:sk-b1']
    )
    assert.deepEqual(
      candidates.map((c) => c.key),
      ['key:0', 'key:0', 'key:1']
    )
  })

  test('primary ref comes first and defaults are de-duplicated by key', ({ assert }) => {
    const candidates = buildChainCandidates({ primary: GPT, defaults: ENV_MODELS })
    assert.deepEqual(
      candidates.map((c) => c.key),
      [GPT, SONNET, GEMINI]
    )
  })

  test('resolved primary is keyed by its breaker key and dedupes a matching default', ({
    assert,
  }) => {
    const primary: ResolvedModel = { providerID: 'openai', modelID: 'gpt-4o', credentialKey: 'key:9' }
    const withCredential = buildChainCandidates({ primary, defaults: [GPT] })
    assert.deepEqual(
      withCredential.map((c) => c.key),
      ['key:9', GPT]
    )
    const plain = buildChainCandidates({ primary: { providerID: 'openai', modelID: 'gpt-4o' }, defaults: [GPT] })
    assert.deepEqual(
      plain.map((c) => c.key),
      [GPT]
    )
  })

  test('skips empty default refs', ({ assert }) => {
    assert.deepEqual(buildChainCandidates({ defaults: ['', SONNET] }).map((c) => c.key), [SONNET])
  })
})

test.group('runModelChain', () => {
  test('primary model succeeds without invoking fallback', async ({ assert }) => {
    const { resolver } = recordingResolver()
    const breaker = new CircuitBreaker()
    const events: FallbackEvent[] = []
    const { calls, attempt } = harness()

    const out = await runModelChain(buildChainCandidates({ defaults: ENV_MODELS }), attempt, {
      breaker,
      resolver,
      onFallback: (e) => events.push(e),
    })

    assert.lengthOf(calls, 1)
    assert.equal(calls[0].key, SONNET)
    assert.isFalse(calls[0].isFallback)
    assert.deepEqual(events, [])
    assert.deepEqual(out.result, { success: true, modelRef: SONNET })
    assert.equal(out.key, SONNET)
    assert.equal(out.model.modelID, 'claude-3-5-sonnet')
    assert.equal(breaker.getStats(SONNET).failures, 0)
  })

  test('falls back to secondary model on 429 rate_limit', async ({ assert }) => {
    const { resolver } = recordingResolver()
    const breaker = new CircuitBreaker()
    const events: FallbackEvent[] = []
    const { calls, attempt } = harness({ [SONNET]: failWith('Rate limit exceeded', 429) })

    const out = await runModelChain(buildChainCandidates({ defaults: ENV_MODELS }), attempt, {
      breaker,
      resolver,
      onFallback: (e) => events.push(e),
    })

    assert.deepEqual(
      calls.map((c) => c.key),
      [SONNET, GPT]
    )
    assert.deepEqual(
      calls.map((c) => c.isFallback),
      [false, true]
    )
    assert.lengthOf(events, 1)
    assert.equal(events[0].fromModel, SONNET)
    assert.equal(events[0].toModel, GPT)
    assert.equal(events[0].errorClass, 'rate_limit')
    assert.deepEqual(out.result, { success: true, modelRef: GPT })
    assert.equal(breaker.getStats(SONNET).failures, 1)
    assert.equal(breaker.getStats(GPT).failures, 0)
  })

  test('falls back through multiple models if intermediate model fails with 500', async ({
    assert,
  }) => {
    const { resolver } = recordingResolver()
    const events: FallbackEvent[] = []
    const { calls, attempt } = harness({
      [SONNET]: failWith('Too Many Requests', 429),
      [GPT]: failWith('Internal Server Error', 500),
    })

    const out = await runModelChain(buildChainCandidates({ defaults: ENV_MODELS }), attempt, {
      breaker: new CircuitBreaker(),
      resolver,
      onFallback: (e) => events.push(e),
    })

    assert.deepEqual(
      calls.map((c) => c.key),
      [SONNET, GPT, GEMINI]
    )
    assert.deepEqual(
      events.map((e) => e.toModel),
      [GPT, GEMINI]
    )
    assert.deepEqual(out.result, { success: true, modelRef: GEMINI })
  })

  test('skips models whose circuit breaker is open', async ({ assert }) => {
    const { resolver } = recordingResolver()
    const breaker = new CircuitBreaker({ failureThreshold: 3, recoveryTimeoutMs: 60_000 })
    for (let i = 0; i < 3; i++) breaker.recordFailure(SONNET)
    assert.equal(breaker.getState(SONNET), 'open')
    const { calls, attempt } = harness()

    const out = await runModelChain(buildChainCandidates({ defaults: ENV_MODELS }), attempt, {
      breaker,
      resolver,
    })

    assert.deepEqual(
      calls.map((c) => c.key),
      [GPT]
    )
    assert.deepEqual(out.result, { success: true, modelRef: GPT })
  })

  test('does NOT fall back on non-retryable auth_error (401) and leaves the breaker closed', async ({
    assert,
  }) => {
    const { resolver } = recordingResolver()
    const breaker = new CircuitBreaker({ failureThreshold: 1 })
    const events: FallbackEvent[] = []
    const { calls, attempt } = harness({ [SONNET]: failWith('Unauthorized', 401) })

    await assert.rejects(
      () =>
        runModelChain(buildChainCandidates({ defaults: ENV_MODELS }), attempt, {
          breaker,
          resolver,
          onFallback: (e) => events.push(e),
        }),
      /Unauthorized/
    )

    assert.lengthOf(calls, 1)
    assert.lengthOf(events, 0)
    assert.equal(breaker.getState(SONNET), 'closed')
  })

  test('401 on the first entry moves to the next when alsoFallBackOn has auth_error', async ({ assert }) => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 })
    const events: FallbackEvent[] = []
    const { calls, attempt } = harness({ 'a/m': failWith('Unauthorized', 401) })

    const out = await runModelChain(buildChainCandidates({ chain: [A, B] }), attempt, {
      breaker,
      alsoFallBackOn: CREDENTIAL_ERROR_CLASSES,
      onFallback: (e) => events.push(e),
    })

    assert.deepEqual(
      calls.map((c) => c.key),
      ['a/m', 'b/m']
    )
    assert.equal(out.key, 'b/m')
    assert.lengthOf(events, 1)
    assert.equal(events[0].errorClass, 'auth_error')
    assert.equal(events[0].fromModel, 'a/m')
    assert.equal(events[0].toModel, 'b/m')
    assert.equal(breaker.getState('a/m'), 'closed')
    assert.equal(breaker.getStats('a/m').failures, 0)
  })

  test('402 and 403 move on as well with CREDENTIAL_ERROR_CLASSES', async ({ assert }) => {
    for (const status of [402, 403]) {
      const { calls, attempt } = harness({ 'a/m': failWith('denied', status) })
      const out = await runModelChain(buildChainCandidates({ chain: [A, B] }), attempt, {
        alsoFallBackOn: CREDENTIAL_ERROR_CLASSES,
      })
      assert.equal(out.key, 'b/m', String(status))
      assert.lengthOf(calls, 2)
    }
  })

  test('alsoFallBackOn does not widen fallback to other fatal classes', async ({ assert }) => {
    const { calls, attempt } = harness({ 'a/m': failWith('bad request', 400) })
    await assert.rejects(
      () =>
        runModelChain(buildChainCandidates({ chain: [A, B] }), attempt, {
          alsoFallBackOn: CREDENTIAL_ERROR_CLASSES,
        }),
      /bad request/
    )
    assert.lengthOf(calls, 1)
  })

  test('401 after a tool ran is thrown even with alsoFallBackOn', async ({ assert }) => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 })
    const events: FallbackEvent[] = []
    let calls = 0
    await assert.rejects(
      () =>
        runModelChain(
          buildChainCandidates({ chain: [A, B] }),
          async (a) => {
            calls += 1
            a.markToolsExecuted()
            throw new FakeHttpError('Unauthorized after tools', 401)
          },
          { breaker, alsoFallBackOn: CREDENTIAL_ERROR_CLASSES, onFallback: (e) => events.push(e) }
        ),
      /Unauthorized after tools/
    )
    assert.equal(calls, 1)
    assert.lengthOf(events, 0)
  })

  test('401 on the last entry is thrown as is', async ({ assert }) => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 })
    const { calls, attempt } = harness({
      'a/m': failWith('Unauthorized a', 401),
      'b/m': failWith('Unauthorized b', 401),
    })
    await assert.rejects(
      () =>
        runModelChain(buildChainCandidates({ chain: [A, B] }), attempt, {
          breaker,
          alsoFallBackOn: CREDENTIAL_ERROR_CLASSES,
        }),
      /Unauthorized b/
    )
    assert.lengthOf(calls, 2)
    assert.equal(breaker.getState('a/m'), 'closed')
    assert.equal(breaker.getState('b/m'), 'closed')
  })

  test('a retryable failure of an ACP agent still throws AcpCallFailedError with alsoFallBackOn', async ({
    assert,
  }) => {
    const acp: ResolvedModel = { providerID: 'acp', modelID: 'agent', npm: ACP_NPM }
    let calls = 0
    await assert.rejects(
      () =>
        runModelChain(
          buildChainCandidates({ chain: [acp, B] }),
          async () => {
            calls += 1
            throw new FakeHttpError('overloaded', 503)
          },
          { alsoFallBackOn: CREDENTIAL_ERROR_CLASSES }
        ),
      AcpCallFailedError as never
    )
    assert.equal(calls, 1)
  })

  test('a 401 from an ACP entry is thrown even with alsoFallBackOn', async ({ assert }) => {
    const acp: ResolvedModel = { providerID: 'acp', modelID: 'agent', npm: ACP_NPM }
    const breaker = new CircuitBreaker({ failureThreshold: 1 })
    const events: FallbackEvent[] = []
    const original = new FakeHttpError('Unauthorized acp', 401)
    let calls = 0
    let thrown: unknown
    try {
      await runModelChain(
        buildChainCandidates({ chain: [acp, B] }),
        async () => {
          calls += 1
          throw original
        },
        { breaker, alsoFallBackOn: CREDENTIAL_ERROR_CLASSES, onFallback: (e) => events.push(e) }
      )
    } catch (error) {
      thrown = error
    }
    assert.strictEqual(thrown, original)
    assert.notInstanceOf(thrown, AcpCallFailedError)
    assert.equal(calls, 1)
    assert.lengthOf(events, 0)
  })

  test('throws the last error when the entire chain is exhausted', async ({ assert }) => {
    const { resolver } = recordingResolver()
    const { calls, attempt } = harness({
      [SONNET]: failWith('Rate limit 1', 429),
      [GPT]: failWith('Rate limit 2', 429),
    })

    await assert.rejects(
      () =>
        runModelChain(buildChainCandidates({ defaults: [SONNET, GPT] }), attempt, {
          breaker: new CircuitBreaker(),
          resolver,
        }),
      /Rate limit 2/
    )
    assert.lengthOf(calls, 2)
  })

  test('streaming-style attempts fall back on a retryable error (529 overloaded)', async ({
    assert,
  }) => {
    const { resolver } = recordingResolver()
    const events: FallbackEvent[] = []
    const { calls, attempt } = harness({ [SONNET]: failWith('Server overloaded', 529) })

    const out = await runModelChain(buildChainCandidates({ defaults: ENV_MODELS }), attempt, {
      breaker: new CircuitBreaker(),
      resolver,
      onFallback: (e) => events.push(e),
    })

    assert.deepEqual(
      calls.map((c) => c.key),
      [SONNET, GPT]
    )
    assert.equal(events[0].errorClass, 'overloaded')
    assert.deepEqual(out.result, { success: true, modelRef: GPT })
  })

  test('a chain with two keys of one model yields two candidates and two breaker keys', async ({
    assert,
  }) => {
    const { resolver, refs } = recordingResolver()
    const breaker = new CircuitBreaker({ failureThreshold: 1 })
    let attempts = 0
    const { calls, attempt } = harness({
      [GPT]: async () => {
        attempts += 1
        if (attempts === 1) throw new FakeHttpError('Rate limit exceeded', 429)
        return 'second credential succeeded'
      },
    })

    const out = await runModelChain(
      buildChainCandidates({ chain: twoCredentialChain(), defaults: ENV_MODELS }),
      attempt,
      { breaker, resolver }
    )

    assert.deepEqual(
      calls.map((c) => c.model.apiKey),
      ['sk-a', 'sk-b']
    )
    assert.deepEqual(refs, [])
    assert.equal(out.result, 'second credential succeeded')
    assert.equal(out.key, 'key:2')
    assert.equal(breaker.getState('key:1'), 'open')
    assert.equal(breaker.getState('key:2'), 'closed')
  })

  test('a non-empty chain suppresses the environment chain', async ({ assert }) => {
    const { resolver, refs } = recordingResolver()
    const breaker = new CircuitBreaker()
    const chain: ResolvedModel[] = [
      { providerID: 'openai', modelID: 'gpt-4o', apiKey: 'sk-a', credentialKey: 'key:1' },
    ]
    const { calls, attempt } = harness({ [GPT]: failWith('Rate limit exceeded', 429) })

    await assert.rejects(
      () =>
        runModelChain(buildChainCandidates({ chain, defaults: ENV_MODELS }), attempt, {
          breaker,
          resolver,
        }),
      /Rate limit exceeded/
    )

    assert.lengthOf(calls, 1)
    assert.equal(calls[0].model.apiKey, 'sk-a')
    assert.deepEqual(refs, [])
    assert.equal(breaker.getStats('key:1').failures, 1)
  })

  test('an absent chain still appends the environment chain', async ({ assert }) => {
    const { resolver, refs } = recordingResolver()
    const { calls, attempt } = harness({ [SONNET]: failWith('Rate limit exceeded', 429) })

    const out = await runModelChain(buildChainCandidates({ defaults: ENV_MODELS }), attempt, {
      breaker: new CircuitBreaker(),
      resolver,
    })

    assert.deepEqual(
      calls.map((c) => c.key),
      [SONNET, GPT]
    )
    assert.deepEqual(refs, [SONNET, GPT])
    assert.deepEqual(out.result, { success: true, modelRef: GPT })
  })

  test('an empty chain is not authoritative and keeps the environment chain', async ({
    assert,
  }) => {
    const { resolver, refs } = recordingResolver()
    const { calls, attempt } = harness({ [SONNET]: failWith('Rate limit exceeded', 429) })

    await runModelChain(buildChainCandidates({ chain: [], defaults: ENV_MODELS }), attempt, {
      breaker: new CircuitBreaker(),
      resolver,
    })

    assert.deepEqual(
      calls.map((c) => c.key),
      [SONNET, GPT]
    )
    assert.deepEqual(refs, [SONNET, GPT])
  })

  test('attempts on resolved candidates receive the resolved model with its credential', async ({
    assert,
  }) => {
    const { resolver, refs } = recordingResolver()
    const { calls, attempt } = harness()

    await runModelChain(buildChainCandidates({ chain: twoCredentialChain() }), attempt, {
      breaker: new CircuitBreaker(),
      resolver,
    })

    assert.lengthOf(calls, 1)
    assert.equal(calls[0].model.credentialKey, 'key:1')
    assert.deepEqual(refs, [])
  })

  test('a chain repeating one credential across two favourites keeps every candidate', async ({
    assert,
  }) => {
    const { resolver, refs } = recordingResolver()
    const breaker = new CircuitBreaker({ failureThreshold: 10 })
    let attempts = 0
    const failing = async () => {
      attempts += 1
      if (attempts <= 3) throw new FakeHttpError('Rate limit exceeded', 429)
      return 'fourth candidate succeeded'
    }
    const { calls, attempt } = harness({ 'openai/gpt-a': failing, 'openai/gpt-b': failing })
    const chain: ResolvedModel[] = [
      { providerID: 'openai', modelID: 'gpt-a', apiKey: 'sk-a0', credentialKey: 'key:0' },
      { providerID: 'openai', modelID: 'gpt-a', apiKey: 'sk-a1', credentialKey: 'key:1' },
      { providerID: 'openai', modelID: 'gpt-b', apiKey: 'sk-b0', credentialKey: 'key:0' },
      { providerID: 'openai', modelID: 'gpt-b', apiKey: 'sk-b1', credentialKey: 'key:1' },
    ]

    const out = await runModelChain(buildChainCandidates({ chain }), attempt, { breaker, resolver })

    assert.deepEqual(
      calls.map((c) => `${c.model.modelID}:${c.model.apiKey}:${c.model.credentialKey}`),
      ['gpt-a:sk-a0:key:0', 'gpt-a:sk-a1:key:1', 'gpt-b:sk-b0:key:0', 'gpt-b:sk-b1:key:1']
    )
    // key:0 served two failing entries; the shared breaker is one failure domain per credential.
    assert.equal(breaker.getStats('key:0').failures, 2)
    assert.deepEqual(refs, [])
    assert.equal(out.result, 'fourth candidate succeeded')
  })

  test('duplicate credential entries inside one chain are attempted once', async ({ assert }) => {
    const { resolver } = recordingResolver()
    let attempts = 0
    const { calls, attempt } = harness({
      [GPT]: async () => {
        attempts += 1
        if (attempts === 1) throw new FakeHttpError('Rate limit exceeded', 429)
        return 'second credential succeeded'
      },
    })
    const chain: ResolvedModel[] = [
      { providerID: 'openai', modelID: 'gpt-4o', apiKey: 'sk-a', credentialKey: 'key:1' },
      { providerID: 'openai', modelID: 'gpt-4o', apiKey: 'sk-a-duplicate', credentialKey: 'key:1' },
      { providerID: 'openai', modelID: 'gpt-4o', apiKey: 'sk-b', credentialKey: 'key:2' },
    ]

    await runModelChain(buildChainCandidates({ chain }), attempt, {
      breaker: new CircuitBreaker(),
      resolver,
    })

    assert.deepEqual(
      calls.map((c) => c.model.apiKey),
      ['sk-a', 'sk-b']
    )
  })

  test('same credential with a different model is not a duplicate', async ({ assert }) => {
    const { resolver } = recordingResolver()
    const { calls, attempt } = harness({ 'openai/gpt-a': failWith('Rate limit exceeded', 429) })
    const chain: ResolvedModel[] = [
      { providerID: 'openai', modelID: 'gpt-a', apiKey: 'sk-a', credentialKey: 'key:1' },
      { providerID: 'openai', modelID: 'gpt-b', apiKey: 'sk-a', credentialKey: 'key:1' },
      { providerID: 'openai', modelID: 'gpt-c', apiKey: 'sk-b', credentialKey: 'key:2' },
    ]

    await runModelChain(buildChainCandidates({ chain }), attempt, {
      breaker: new CircuitBreaker({ failureThreshold: 10 }),
      resolver,
    })

    assert.deepEqual(
      calls.map((c) => c.model.modelID),
      ['gpt-a', 'gpt-b']
    )
  })

  test('concurrent calls get one half-open probe', async ({ assert }) => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeoutMs: 0,
      halfOpenMaxConcurrent: 1,
    })
    breaker.recordFailure('a/m')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const used: string[] = []
    const run = () =>
      runModelChain(
        buildChainCandidates({ chain: [A, B] }),
        async ({ key }) => {
          used.push(key)
          if (key === 'a/m') await gate
          return key
        },
        { breaker }
      )
    const p1 = run()
    const p2 = run()
    release()
    assert.sameMembers(
      (await Promise.all([p1, p2])).map((r) => r.key),
      ['a/m', 'b/m']
    )
  })

  test('caller abort stops the chain and does not count', async ({ assert }) => {
    const ac = new AbortController()
    const breaker = new CircuitBreaker({ failureThreshold: 1 })
    let calls = 0
    await assert.rejects(() =>
      runModelChain(
        buildChainCandidates({ chain: [A, B] }),
        async () => {
          calls += 1
          ac.abort()
          throw new FakeHttpError('x', 503)
        },
        { breaker, abortSignal: ac.signal }
      )
    )
    assert.equal(calls, 1)
    assert.equal(breaker.getState('a/m'), 'closed')
  })

  test('no fallback after tools ran', async ({ assert }) => {
    const breaker = new CircuitBreaker({ failureThreshold: 5 })
    const events: FallbackEvent[] = []
    let calls = 0
    await assert.rejects(
      () =>
        runModelChain(
          buildChainCandidates({ chain: [A, B] }),
          async (a) => {
            calls += 1
            a.markToolsExecuted()
            throw new FakeHttpError('overloaded after tools', 503)
          },
          { breaker, onFallback: (e) => events.push(e) }
        ),
      /overloaded after tools/
    )
    assert.equal(calls, 1)
    assert.lengthOf(events, 0)
    // The upstream failure still counts against the breaker.
    assert.equal(breaker.getStats('a/m').failures, 1)
  })

  test('prompt_too_long falls back without opening the breaker', async ({ assert }) => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 })
    const events: FallbackEvent[] = []
    const out = await runModelChain(
      buildChainCandidates({ chain: [A, B] }),
      async ({ key }) => {
        if (key === 'a/m') throw new FakeHttpError('maximum context length exceeded', 400)
        return key
      },
      { breaker, onFallback: (e) => events.push(e) }
    )
    assert.equal(out.result, 'b/m')
    assert.equal(events[0].errorClass, 'prompt_too_long')
    assert.equal(breaker.getState('a/m'), 'closed')
  })

  test('a throwing onFallback is swallowed with a warning', async ({ assert }) => {
    const warnings: string[] = []
    const logger = {
      info() {},
      error() {},
      warn: (m: string) => warnings.push(m),
    }
    const out = await runModelChain(
      buildChainCandidates({ chain: [A, B] }),
      async ({ key }) => {
        if (key === 'a/m') throw new FakeHttpError('boom', 500)
        return key
      },
      {
        breaker: new CircuitBreaker(),
        logger,
        onFallback: () => {
          throw new Error('handler bug')
        },
      }
    )
    assert.equal(out.result, 'b/m')
    assert.isTrue(warnings.some((w) => /onFallback/.test(w)))
  })

  test('a non-counting failure on a half-open probe frees the slot', async ({ assert }) => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeoutMs: 0,
      halfOpenMaxConcurrent: 1,
    })
    breaker.recordFailure('a/m')
    // Non-counting failure (400 invalid request) on the probe must free the slot.
    await assert.rejects(() =>
      runModelChain(
        buildChainCandidates({ chain: [A] }),
        async () => {
          throw new FakeHttpError('bad request', 400)
        },
        { breaker }
      )
    )
    assert.isTrue(breaker.isAvailable('a/m'))
  })

  test('a resolver that throws for a ref candidate releases the permit', async ({ assert }) => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      recoveryTimeoutMs: 0,
      halfOpenMaxConcurrent: 1,
    })
    breaker.recordFailure(SONNET)
    const resolver: ModelResolver = {
      async resolve() {
        throw new Error('catalog down')
      },
    }
    await assert.rejects(
      () =>
        runModelChain(buildChainCandidates({ defaults: [SONNET] }), async () => 'x', {
          breaker,
          resolver,
        }),
      /catalog down/
    )
    assert.isTrue(breaker.isAvailable(SONNET))
  })

  test('rethrows the last error when every later candidate has an open breaker', async ({
    assert,
  }) => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, recoveryTimeoutMs: 60_000 })
    breaker.recordFailure('b/m')
    const { calls, attempt } = harness({ 'a/m': failWith('first failed', 503) })
    await assert.rejects(
      () => runModelChain(buildChainCandidates({ chain: [A, B] }), attempt, { breaker }),
      /first failed/
    )
    assert.lengthOf(calls, 1)
  })

  test('zero attempts throws ProviderUnavailableError', async ({ assert }) => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, recoveryTimeoutMs: 60_000 })
    breaker.recordFailure('a/m')
    breaker.recordFailure('b/m')
    await assert.rejects(
      () => runModelChain(buildChainCandidates({ chain: [A, B] }), async () => 'x', { breaker }),
      /no candidate model is available/
    )
    try {
      await runModelChain([], async () => 'x')
      assert.fail('expected rejection')
    } catch (error) {
      assert.instanceOf(error, ProviderUnavailableError)
    }
  })

  test('works without a breaker', async ({ assert }) => {
    const { calls, attempt } = harness({ 'a/m': failWith('down', 503) })
    const out = await runModelChain(buildChainCandidates({ chain: [A, B] }), attempt)
    assert.equal(out.key, 'b/m')
    assert.lengthOf(calls, 2)
  })
})

test.group('runModelChain skip errors and async onFallback', () => {
  test('falls through on a missing provider package without counting against the breaker', async ({ assert }) => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 })
    const events: FallbackEvent[] = []
    const { calls, attempt } = harness({
      'a/m': async () => {
        throw new AiException('missing', 'E_AI_MISSING_DEPENDENCY')
      },
    })
    const out = await runModelChain(buildChainCandidates({ chain: [A, B] }), attempt, {
      breaker,
      onFallback: (e) => events.push(e),
    })
    assert.equal(out.key, 'b/m')
    assert.lengthOf(calls, 2)
    assert.lengthOf(events, 1)
    assert.equal(breaker.getState('a/m'), 'closed')
    assert.equal(breaker.getStats('a/m').failures, 0)
  })

  test('falls through on a config error and on ProviderUnavailableError', async ({ assert }) => {
    const { attempt } = harness({
      'a/m': async () => {
        throw new ProviderConfigError('a', 'bad')
      },
      'b/m': async () => {
        throw new ProviderUnavailableError('b', 'open')
      },
    })
    const c: ResolvedModel = { providerID: 'c', modelID: 'm' }
    const out = await runModelChain(buildChainCandidates({ chain: [A, B, c] }), attempt)
    assert.equal(out.key, 'c/m')
  })

  test('a skip error on the last candidate is thrown', async ({ assert }) => {
    const { attempt } = harness({
      'b/m': async () => {
        throw new ProviderConfigError('b', 'bad')
      },
    })
    await assert.rejects(() => runModelChain(buildChainCandidates({ chain: [B] }), attempt), /bad/)
  })

  test('a ref candidate without a resolver throws ProviderConfigError before any attempt', async ({ assert }) => {
    const { calls, attempt } = harness()
    try {
      await runModelChain(buildChainCandidates({ defaults: [GPT] }), attempt)
      assert.fail('expected rejection')
    } catch (error) {
      assert.instanceOf(error, ProviderConfigError)
    }
    assert.lengthOf(calls, 0)
  })

  test('an async onFallback that rejects is caught and does not affect the result', async ({ assert }) => {
    const unhandled: unknown[] = []
    const listener = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', listener)
    const warnings: string[] = []
    try {
      const { attempt } = harness({ 'a/m': failWith('down', 503) })
      const out = await runModelChain(buildChainCandidates({ chain: [A, B] }), attempt, {
        onFallback: async () => {
          throw new Error('handler boom')
        },
        logger: { info() {}, debug() {}, error() {}, warn: (m: string) => void warnings.push(m) },
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(out.key, 'b/m')
      assert.deepEqual(unhandled, [])
      assert.isTrue(warnings.some((w) => w.includes('handler boom')))
    } finally {
      process.removeListener('unhandledRejection', listener)
    }
  })
})
