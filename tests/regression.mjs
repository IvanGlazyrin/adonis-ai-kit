import assert from 'node:assert/strict'
import { tool } from 'ai'
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'
import { z } from 'zod'

// Run after `npm run build`, then: npm run test:regression
const P = new URL('../dist/src', import.meta.url).href
const budget = await import(`${P}/budget/index.js`)
const guardLib = await import(`${P}/guard/index.js`)
const { AiManager } = await import(`${P}/ai_manager.js`)
const { AgentRunner } = await import(`${P}/agents/agent_runner.js`)
const { CircuitBreaker } = await import(`${P}/circuit_breaker.js`)
const { defineConfig } = await import(`${P}/define_config.js`)
const { classifyError, classifyErrorClass, isRetryableError, getUserFriendlyMessage } = await import(`${P}/error_classifier.js`)
const acp = await import(`${P}/acp/provider.js`)
const acpAgents = await import(`${P}/acp/acp_agents.js`)

let passed = 0
const t = async (name, fn) => {
  try { await fn(); passed++; console.log('  ok  ', name) }
  catch (e) { console.log('  FAIL', name, '\n      ', e.message); process.exitCode = 1 }
}

const usage = (inp, out, cacheRead = 0, reasoning = 0) => ({
  inputTokens: { total: inp, noCache: inp - cacheRead, cacheRead, cacheWrite: 0 },
  outputTokens: { total: out, text: out - reasoning, reasoning },
})
const finish = (unified = 'stop') => ({ unified, raw: unified })
const textModel = (text, u = usage(1000, 500)) =>
  new MockLanguageModelV4({
    provider: 'mock', modelId: 'gpt-4o',
    doGenerate: async () => ({ content: [{ type: 'text', text }], finishReason: finish(), usage: u, warnings: [] }),
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: text },
        { type: 'text-end', id: '1' },
        { type: 'finish', finishReason: finish(), usage: u },
      ]),
    }),
  })
const apiError = (statusCode) => Object.assign(new Error(`HTTP ${statusCode}`), { name: 'AI_APICallError', statusCode })
const failingModel = (statusCode) =>
  new MockLanguageModelV4({
    provider: 'mock', modelId: 'bad',
    doGenerate: async () => { throw apiError(statusCode) },
    doStream: async () => { throw apiError(statusCode) },
  })

const customProvider = (model, extra = {}) => ({ driver: 'custom', factory: () => model, defaultModel: 'm', ...extra })
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }
const mgr = (providers, extra = {}) =>
  new AiManager(defineConfig({ default: Object.keys(providers)[0], providers, fallbackCascade: Object.keys(providers).slice(1), catalog: { autoPricing: false }, ...extra }), silentLogger)

console.log('token-budget')
await t('cost: input/output at gpt-4o rates', () => {
  const c = new budget.CostTracker()
  assert.equal(c.calculateCost('gpt-4o', 1_000_000, 1_000_000), 12.5)
})
await t('cost: cache read billed at cache rate, not input', () => {
  const c = new budget.CostTracker()
  // 1M input of which 1M cached @1.25 => 1.25
  assert.equal(c.calculateCost('gpt-4o', 1_000_000, 0, { cacheReadTokens: 1_000_000 }), 1.25)
})
await t('cost: reasoning priced via reasoningCostPer1M', () => {
  const c = new budget.CostTracker({ pricing: { x: { input: 1, output: 10, reasoningCostPer1M: 20 } } })
  assert.equal(c.calculateCost('x', 0, 1_000_000, { reasoningTokens: 500_000 }), 5 + 10)
})
await t('cost: dated / -latest model ids resolve', () => {
  const c = new budget.CostTracker()
  assert.equal(c.calculateCost('claude-3-7-sonnet-latest', 1_000_000, 0), 3)
  assert.equal(c.calculateCost('claude-3-5-sonnet-20241022', 1_000_000, 0), 3)
  assert.equal(c.calculateCost('gpt-4o-2024-08-06', 1_000_000, 0), 2.5)
  assert.equal(c.calculateCost('anthropic/claude-sonnet-4-20250514', 1_000_000, 0), 3)
})
await t('cost: NaN/negative tokens are neutralized', () => {
  const c = new budget.CostTracker()
  assert.equal(c.calculateCost('gpt-4o', NaN, -5), 0)
})
await t('tracker: __proto__ agent does not pollute', () => {
  const c = new budget.CostTracker()
  c.record({ agentName: '__proto__', model: 'gpt-4o', inputTokens: 10, outputTokens: 10, totalTokens: 20, durationMs: 1 })
  c.record({ agentName: 'constructor', model: 'constructor', inputTokens: 1, outputTokens: 1, totalTokens: 2, durationMs: 1 })
  assert.equal({}.tokens, undefined)
  assert.equal(Object.getOwnPropertyDescriptor(c.getByAgent(), '__proto__').value.tokens, 20)
  assert.equal(c.calculateCost('constructor', 1, 1), 0)
})
await t('tracker: ring buffer bounds memory, aggregates stay exact', () => {
  const sunk = []
  const c = new budget.CostTracker({ maxRecords: 3, sink: (r) => sunk.push(r) })
  for (let i = 0; i < 10; i++) c.record({ agentName: 'a', model: 'gpt-4o', inputTokens: 1, outputTokens: 1, totalTokens: 2, durationMs: 1 })
  assert.equal(c.getRecords().length, 3)
  assert.equal(c.getTotalTokens(), 20)
  assert.equal(c.getByAgent().a.calls, 10)
  assert.equal(sunk.length, 10)
})
await t('allocator: no domain rules built in, custom rule works', () => {
  const a = new budget.BudgetAllocator()
  assert.equal(a.compute({ regime: 'volatile', recentLosses: 9, portfolioPct: 50, htfAligned: false }).totalModifierPct, 0)
  a.addRule(budget.equalsRule('tier', 'premium', 20))
  assert.equal(a.compute({ tier: 'premium' }).perAgent, 60_000)
})
await t('enforcer: rejects NaN/negative limits, ignores bad usage', () => {
  assert.throws(() => new budget.BudgetEnforcer({ perAgentMaxTokens: NaN }))
  const e = new budget.BudgetEnforcer({ perAgentMaxTokens: 100 })
  assert.throws(() => e.setTokenLimits({ perSessionMaxTokens: -1 }))
  e.recordAgentUsage('a', NaN, -3)
  assert.equal(e.getSessionTokensUsed(), 0)
})
await t('enforcer: reservations stop concurrent overshoot', () => {
  const e = new budget.BudgetEnforcer({ perAgentMaxTokens: 100, perSessionMaxTokens: 1000 })
  const r1 = e.reserve('a', 60)
  const r2 = e.reserve('a', 60)
  assert.ok(r1); assert.equal(r2, null)
  e.settle(r1, 40); e.settle(r1, 40) // idempotent
  assert.equal(e.getAgentTokensUsed('a'), 40)
  assert.ok(e.reserve('a', 50))
})

console.log('tool-guard')
const okTool = (calls = []) => ({ description: 'd', inputSchema: z.object({}), execute: async (a) => { calls.push(a); return { ok: true } } })
await t('registry: default permission is deny', () => {
  const r = new guardLib.ToolRegistry().registerTool('t', okTool())
  assert.deepEqual(Object.keys(r.getToolsForAgent('x')), [])
})
await t("registry: 'ask' without ConfirmationService throws PolicyViolationError and does not execute", async () => {
  const calls = []
  const r = new guardLib.ToolRegistry().registerTool('t', okTool(calls), 'ask')
  const tools = r.getToolsForAgent('x')
  await assert.rejects(() => tools.t.execute({}), guardLib.PolicyViolationError)
  assert.equal(calls.length, 0)
})
await t("registry: 'ask' executes only after approval", async () => {
  const calls = []
  const conf = new guardLib.ConfirmationService()
  conf.onActionCreated((a) => conf.approve(a.id, 'ok', a.sessionId))
  const r = new guardLib.ToolRegistry().registerTool('t', okTool(calls), 'ask')
  const res = await r.getToolsForAgent('x', { confirmation: conf }).t.execute({ a: 1 })
  assert.deepEqual(res, { ok: true }); assert.equal(calls.length, 1)
  conf.dispose()
})
await t('registry: getToolsByList honors deny / ask', async () => {
  const r = new guardLib.ToolRegistry().registerTool('rm', okTool(), 'deny').registerTool('ls', okTool(), 'allow').registerTool('wr', okTool(), 'ask')
  const tools = r.getToolsByList(['rm', 'ls', 'wr'])
  assert.deepEqual(Object.keys(tools).sort(), ['ls', 'wr'])
  await assert.rejects(() => tools.wr.execute({}), guardLib.PolicyViolationError)
})
await t("registry: 'allow' tools pass through PolicyGuard maxCalls, incl. parallel calls", async () => {
  const guard = new guardLib.PolicyGuard({ maxCalls: 2 })
  const r = new guardLib.ToolRegistry().registerTool('t', okTool(), 'allow')
  const tools = r.getToolsForAgent('x', { guard })
  const results = await Promise.all([1, 2, 3, 4].map(() => tools.t.execute({})))
  assert.equal(results.filter((x) => x.error).length, 2)
  assert.equal(guard.acceptedCalls, 2)
})
await t('guard: released slot (denied confirmation) is not counted', async () => {
  const guard = new guardLib.PolicyGuard({ maxCalls: 1 })
  const conf = new guardLib.ConfirmationService()
  conf.onActionCreated((a) => conf.reject(a.id, 'no', a.sessionId))
  const r = new guardLib.ToolRegistry().registerTool('t', okTool(), 'ask')
  const tools = r.getToolsForAgent('x', { guard, confirmation: conf })
  await tools.t.execute({})
  assert.equal(guard.check('t', {}), null)
  conf.dispose()
})
await t('guard: rangeRule rejects empty string / null / true', () => {
  const rule = guardLib.rangeRule('n', 1, 5)
  for (const bad of ['', null, true, undefined, [], NaN]) assert.ok(rule.validate(bad, {}), String(bad))
  assert.equal(rule.validate(3, {}), null)
})
await t('guard: non-object args fail closed when rules exist', () => {
  const g = new guardLib.PolicyGuard().addRule('t', guardLib.rangeRule('n', 1, 5))
  assert.ok(g.check('t', 'oops'))
})
await t('guard: acceptedOrders artifact removed', () => {
  assert.equal(guardLib.reconcileExecutionClaims(3, { check: () => null, summary: () => ({ acceptedOrders: 3 }) }).verified, 0)
})
await t('schema registry: no *OutputSchema alias', () => {
  const s = new guardLib.SchemaRegistry().register('FooSchema', z.object({ a: z.string() }))
  assert.equal(s.get('FooOutputSchema'), undefined)
  const bad = s.validate('FooSchema', { a: 1 })
  assert.equal(bad.success, false); assert.match(bad.error, /Field "a"/)
})
await t('confirmation: unref, huge timeout clamped, expiry notifies, session validated, dispose', async () => {
  const conf = new guardLib.ConfirmationService()
  const resolved = []
  conf.onActionResolved((a, r) => resolved.push(r.status))
  const p = conf.waitForResponse({ toolName: 't', action: 'a', params: {}, sessionId: 's1' }, 2 ** 31)
  const [pending] = conf.getPendingActions()
  assert.ok(pending.expiresAt - pending.createdAt <= guardLib.MAX_TIMEOUT_MS)
  assert.equal(conf.approve(pending.id, '', 'other-session'), false)
  assert.equal(conf.approve(pending.id), false)
  assert.equal(conf.getPendingActions('other').length, 0)
  const p2 = conf.waitForResponse({ toolName: 't', action: 'a', params: {} }, 1)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal((await p2).status, 'timeout')
  assert.ok(resolved.includes('timeout'))
  conf.dispose()
  assert.equal((await p).status, 'rejected')
  assert.equal((await conf.waitForResponse({ toolName: 't', action: 'a', params: {} })).status, 'rejected')
})
await t('confirmation: clearExpired invokes resolved listeners', async () => {
  const conf = new guardLib.ConfirmationService({ defaultTimeoutMs: 60_000 })
  const seen = []
  conf.onActionResolved((_a, r) => seen.push(r.status))
  const p = conf.waitForResponse({ toolName: 't', action: 'a', params: {} }, 1)
  conf.pending.get([...conf.pending.keys()][0]).expiresAt = Date.now() - 1
  conf.clearExpired()
  assert.equal((await p).status, 'timeout'); assert.deepEqual(seen, ['timeout'])
})

console.log('adonis-ai')
await t('v7: generateText maps maxOutputTokens + stopWhen, reads inputTokens/outputTokens, prices cost', async () => {
  const model = textModel('hello')
  const m = mgr({ main: customProvider(model, { defaultModel: 'gpt-4o' }) })
  const res = await m.generateText({ prompt: 'x', maxTokens: 42, maxSteps: 3, agentName: 'a' })
  assert.equal(model.doGenerateCalls[0].maxOutputTokens, 42)
  assert.equal(res.usage.inputTokens, 1000); assert.equal(res.usage.outputTokens, 500)
  assert.equal(res.usage.promptTokens, 1000)
  assert.equal(res.costUsd, (1000 * 2.5 + 500 * 10) / 1e6)
  assert.equal(m.getCostTracker().getTotalTokens(), 1500)
})
await t('v7: cache-read + reasoning tokens flow into cost', async () => {
  const m = mgr({ main: customProvider(textModel('hi', usage(1000, 500, 800, 100)), { defaultModel: 'gpt-4o' }) })
  const res = await m.generateText({ prompt: 'x' })
  assert.equal(res.usage.cacheReadTokens, 800); assert.equal(res.usage.reasoningTokens, 100)
  assert.equal(res.costUsd, (200 * 2.5 + 800 * 1.25 + 500 * 10) / 1e6)
})
await t('v7: multi-step tool loop stops at maxSteps and sums totalUsage', async () => {
  let calls = 0
  const model = new MockLanguageModelV4({
    provider: 'mock', modelId: 'gpt-4o',
    doGenerate: async () => {
      calls++
      return calls < 3
        ? { content: [{ type: 'tool-call', toolCallId: `c${calls}`, toolName: 'echo', input: '{}' }], finishReason: finish('tool-calls'), usage: usage(100, 10), warnings: [] }
        : { content: [{ type: 'text', text: 'done' }], finishReason: finish(), usage: usage(100, 10), warnings: [] }
    },
  })
  const m = mgr({ main: customProvider(model, { defaultModel: 'gpt-4o' }) })
  const res = await m.generateText({ prompt: 'x', maxSteps: 5, tools: { echo: tool({ description: 'e', inputSchema: z.object({}), execute: async () => 'e' }) } })
  assert.equal(res.text, 'done'); assert.equal(calls, 3)
  assert.equal(res.usage.inputTokens, 300)
})
await t('v7: generateObject via Output.object', async () => {
  const model = textModel('{"n":7}', usage(10, 5))
  const m = mgr({ main: customProvider(model, { defaultModel: 'gpt-4o' }) })
  const res = await m.generateObject({ prompt: 'x', schema: z.object({ n: z.number() }) })
  assert.deepEqual(res.object, { n: 7 }); assert.equal(res.usage.inputTokens, 10)
})
await t('runner: caller cannot re-introduce denied tool or replace system prompt', async () => {
  const model = textModel('ok')
  const m = mgr({ main: customProvider(model, { defaultModel: 'gpt-4o' }) })
  const runner = new AgentRunner(m, { id: 'ag', description: '', mode: 'primary', stopSteps: 5, skills: [], systemPrompt: 'AGENT', body: '', skillPrompts: {}, permissions: { bash: 'deny' }, phases: [] })
  const mk = (n) => tool({ description: n, inputSchema: z.object({}), execute: async () => n })
  await runner.run({ prompt: 'x', system: 'USER', tools: { bash: mk('bash'), ls: mk('ls') }, toolPermissions: { bash: 'allow' } })
  const names = (model.doGenerateCalls[0].tools ?? []).map((x) => x.name)
  assert.deepEqual(names, ['ls'])
  const sys = JSON.stringify(model.doGenerateCalls[0].prompt)
  assert.match(sys, /AGENT/); assert.match(sys, /USER/)
  await runner.runStream({ prompt: 'x', tools: { bash: mk('bash') } }).then((s) => s.consume())
  assert.equal(model.doStreamCalls[0].tools, undefined)
})
await t("runner: manifest 'ask' tool never runs without approval", async () => {
  let ran = false
  const model = new MockLanguageModelV4({
    provider: 'mock', modelId: 'gpt-4o',
    doGenerate: async () => ({ content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'danger', input: '{}' }], finishReason: finish('tool-calls'), usage: usage(1, 1), warnings: [] }),
  })
  const m = mgr({ main: customProvider(model, { defaultModel: 'gpt-4o' }) })
  m.getConfirmationService().onActionCreated((a) => m.getConfirmationService().reject(a.id, 'nope', a.sessionId))
  const runner = new AgentRunner(m, { id: 'ag', description: '', mode: 'primary', stopSteps: 2, skills: [], systemPrompt: 'S', body: '', skillPrompts: {}, permissions: { danger: 'ask' }, phases: [] })
  await runner.run({ prompt: 'x', tools: { danger: tool({ description: 'd', inputSchema: z.object({}), execute: async () => { ran = true; return 'x' } }) } })
  assert.equal(ran, false)
})
await t('fallback: 429 on primary -> fallback used with ITS OWN default model (not the requested id)', async () => {
  const good = textModel('from-backup'); const seen = []
  const m = mgr({
    main: customProvider(failingModel(429), { defaultModel: 'main-model' }),
    backup: { driver: 'custom', defaultModel: 'backup-model', factory: () => (id) => { seen.push(id); return good } },
  })
  const res = await m.generateText({ prompt: 'x', model: 'primary-only-model' })
  assert.equal(res.text, 'from-backup'); assert.equal(res.provider, 'backup'); assert.deepEqual(seen, ['backup-model'])
})
await t('fallback: 400 / auth errors fail immediately, no fallback, breaker untouched', async () => {
  for (const status of [400, 401]) {
    const good = textModel('backup')
    const m = mgr({ main: customProvider(failingModel(status), { defaultModel: 'main-model' }), backup: customProvider(good) })
    await assert.rejects(() => m.generateText({ prompt: 'x' }), (e) => e.statusCode === status)
    assert.equal(good.doGenerateCalls.length, 0)
    assert.equal(m.getCircuitBreaker().getStats('main:main-model').failures, 0)
  }
})
await t('fallback: aborted request does not fall back', async () => {
  const ac = new AbortController(); ac.abort()
  const good = textModel('backup')
  const m = mgr({ main: customProvider(textModel('x')), backup: customProvider(good) })
  await assert.rejects(() => m.generateText({ prompt: 'x', abortSignal: ac.signal }))
  assert.equal(good.doGenerateCalls.length, 0)
})
await t('fallback: ACP / custom providers are not auto-added to cascade', () => {
  const cfg = defineConfig({ default: 'a', providers: { a: { driver: 'openai' }, b: { driver: 'anthropic' }, cli: { driver: 'acp' }, c: { driver: 'custom', factory: () => null } } })
  assert.deepEqual(cfg.fallbackCascade, ['b'])
  const input = { default: 'a', providers: { a: { driver: 'openai' } } }
  defineConfig(input); assert.equal(input.fallbackCascade, undefined)
})
await t('fallback: no side-effect replay after tools executed', async () => {
  let toolRuns = 0; let n = 0
  const flaky = new MockLanguageModelV4({
    provider: 'mock', modelId: 'm',
    doGenerate: async () => {
      if (++n === 1) return { content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'pay', input: '{}' }], finishReason: finish('tool-calls'), usage: usage(1, 1), warnings: [] }
      throw apiError(503)
    },
  })
  const backup = textModel('backup')
  const m = mgr({ main: customProvider(flaky), backup: customProvider(backup) })
  await assert.rejects(() => m.generateText({ prompt: 'x', maxSteps: 3, tools: { pay: tool({ description: 'p', inputSchema: z.object({}), execute: async () => { toolRuns++; return 'paid' } }) } }), (e) => e.statusCode === 503)
  assert.equal(toolRuns, 1); assert.equal(backup.doGenerateCalls.length, 0)
})
await t('stream: initial 429 falls back BEFORE returning; usage recorded; breaker counts failure', async () => {
  const good = textModel('streamed', usage(10, 5))
  const m = mgr({ main: customProvider(failingModel(429), { defaultModel: 'gpt-4o' }), backup: customProvider(good, { defaultModel: 'gpt-4o-mini' }) })
  const s = await m.streamText({ prompt: 'x' })
  assert.equal(s.provider, 'backup')
  let text = ''; for await (const c of s.textStream) text += c
  assert.equal(text, 'streamed')
  const u = await s.usage
  assert.equal(u.inputTokens, 10)
  assert.equal(m.getCircuitBreaker().getStats('main:gpt-4o').failures, 1)
  assert.ok(m.getCostTracker().getTotalCost() > 0)
})
await t('stream: error part in first chunk (provider stream error) triggers fallback', async () => {
  const errStream = new MockLanguageModelV4({ provider: 'mock', modelId: 'e', doStream: async () => ({ stream: convertArrayToReadableStream([{ type: 'stream-start', warnings: [] }, { type: 'error', error: apiError(500) }]) }) })
  const m = mgr({ main: customProvider(errStream), backup: customProvider(textModel('ok')) })
  const s = await m.streamText({ prompt: 'x' })
  assert.equal(s.provider, 'backup')
  assert.equal((await s.consume()).text, 'ok')
})
await t('stream: abort() cancels generation; usage promise settles', async () => {
  const model = new MockLanguageModelV4({
    provider: 'mock', modelId: 'm',
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream({
        start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'text-start', id: '1' }); c.enqueue({ type: 'text-delta', id: '1', delta: 'a' }) },
        pull(c) { return new Promise((res) => { abortSignal?.addEventListener('abort', () => { try { c.error(new DOMException('aborted', 'AbortError')) } catch {} res() }) }) },
      }),
    }),
  })
  const m = mgr({ main: customProvider(model) })
  const s = await m.streamText({ prompt: 'x' })
  setTimeout(() => s.abort('bye'), 20)
  try { for await (const _ of s.textStream); } catch {}
  const u = await Promise.race([s.usage, new Promise((_, rej) => setTimeout(() => rej(new Error('usage hung')), 2000))])
  assert.equal(typeof u.totalTokens, 'number')
})
await t('breaker: keyed per provider:model, half-open needs 2 successes, resets counters, probe limit', async () => {
  const states = []
  const b = new CircuitBreaker({ failureThreshold: 1, recoveryTimeoutMs: 5, halfOpenMaxAttempts: 2, onStateChange: (k, f, to) => { states.push(`${f}>${to}`); throw new Error('observer boom') } })
  b.recordFailure('p:m1')
  assert.equal(b.getState('p:m1'), 'open'); assert.ok(b.getStats('p:m1').nextAttemptAllowedAt)
  assert.equal(b.getState('p:m2'), 'closed')
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(b.getState('p:m1'), 'half_open')
  // probe limit: second concurrent probe rejected
  let release; const hold = new Promise((r) => (release = r))
  const probe = b.execute('p:m1', () => hold)
  assert.equal(b.isAvailable('p:m1'), false)
  await assert.rejects(() => b.execute('p:m1', async () => 1))
  release(1); await probe
  assert.equal(b.getState('p:m1'), 'half_open')
  await b.execute('p:m1', async () => 1)
  assert.equal(b.getState('p:m1'), 'closed')
  // success -> failure -> new half-open needs 2 successes again
  b.recordFailure('p:m1'); await new Promise((r) => setTimeout(r, 10)); b.getState('p:m1')
  await b.execute('p:m1', async () => 1)
  assert.equal(b.getState('p:m1'), 'half_open')
})
await t('classifier', () => {
  const k = (e) => classifyError(e).kind
  assert.equal(k(apiError(429)), 'retryable'); assert.equal(k(apiError(503)), 'retryable')
  assert.equal(k(apiError(400)), 'fatal'); assert.equal(k(apiError(401)), 'fatal')
  assert.equal(k(Object.assign(new Error('x'), { name: 'AbortError' })), 'fatal')
  assert.equal(k(Object.assign(new Error('x'), { name: 'AI_TypeValidationError' })), 'fatal')
  assert.equal(k(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), 'retryable')
})
await t('error taxonomy: status codes map to fine-grained classes', () => {
  const c = (e) => classifyErrorClass(e)
  assert.equal(c(apiError(429)), 'rate_limit')
  assert.equal(c(apiError(529)), 'overloaded')
  assert.equal(c(apiError(408)), 'timeout')
  assert.equal(c(apiError(401)), 'auth_error')
  assert.equal(c(apiError(403)), 'auth_error')
  assert.equal(c(apiError(404)), 'model_not_found')
  assert.equal(c(apiError(500)), 'server_error')
  assert.equal(c(apiError(503)), 'server_error')
  assert.equal(c({ statusCode: 400 }), 'invalid_request')
  assert.equal(c(Object.assign(new Error('context length exceeded'), { statusCode: 400 })), 'prompt_too_long')
  assert.equal(c(Object.assign(new Error('max_tokens exceeded'), { statusCode: 400 })), 'prompt_too_long')
})
await t('error taxonomy: network/timeout/no-output detection', () => {
  const c = (e) => classifyErrorClass(e)
  assert.equal(c(new Error('fetch failed')), 'network_error')
  assert.equal(c(new Error('ECONNREFUSED')), 'network_error')
  assert.equal(c(new Error('ENOTFOUND')), 'network_error')
  assert.equal(c(new Error('ETIMEDOUT')), 'timeout')
  assert.equal(c(new Error('timeout waiting')), 'timeout')
  assert.equal(c(new Error('something weird')), 'unknown')
  assert.equal(c(null), 'unknown')
  assert.equal(c('string error'), 'unknown')
  assert.equal(c(Object.assign(new Error('no output'), { name: 'AI_NoOutputGeneratedError' })), 'no_output_generated')
})
await t('error taxonomy: retryable set and user-facing messages', () => {
  for (const cls of ['rate_limit', 'overloaded', 'timeout', 'server_error', 'network_error', 'prompt_too_long', 'no_output_generated']) {
    assert.equal(isRetryableError(cls), true, `${cls} should be retryable`)
  }
  for (const cls of ['auth_error', 'model_not_found', 'invalid_request', 'unknown']) {
    assert.equal(isRetryableError(cls), false, `${cls} should not be retryable`)
  }
  for (const cls of ['rate_limit', 'overloaded', 'timeout', 'auth_error', 'model_not_found', 'prompt_too_long', 'invalid_request', 'server_error', 'network_error', 'unknown']) {
    assert.ok(getUserFriendlyMessage(cls).length > 0)
  }
})
await t('acp: arbitrary model string is never executed as a command', async () => {
  const d = new acp.AcpDriver('cli', { driver: 'acp' })
  await assert.rejects(() => d.getModel('rm -rf /'), /Unknown ACP agent/)
  await assert.rejects(() => d.getModel('gpt-4o'), /Unknown ACP agent/)
})
await t('acp: agent env blanks server secrets unless allowlisted/explicit', () => {
  const env = acp.buildAgentEnv({ PATH: '/bin', DATABASE_URL: 'secret', OPENAI_API_KEY: 'sk', LC_ALL: 'C' }, { ANTHROPIC_API_KEY: 'k' })
  assert.equal(env.PATH, '/bin'); assert.equal(env.DATABASE_URL, ''); assert.equal(env.OPENAI_API_KEY, ''); assert.equal(env.LC_ALL, 'C'); assert.equal(env.ANTHROPIC_API_KEY, 'k')
})
await t('acp: MCP servers conform to ACP schema (env/headers arrays, no cwd/type on stdio)', () => {
  assert.deepEqual(acpAgents.normalizeMcpServer({ type: 'stdio', name: 'a', command: 'node', args: ['x'], env: { A: '1' }, cwd: '/x', trust: true }), { name: 'a', command: 'node', args: ['x'], env: [{ name: 'A', value: '1' }] })
  assert.deepEqual(acpAgents.normalizeMcpServer({ type: 'sse', name: 'r', httpUrl: 'http://x', headers: { H: 'v' } }), { type: 'sse', name: 'r', url: 'http://x', headers: [{ name: 'H', value: 'v' }] })
  assert.equal(acpAgents.normalizeMcpServer({ name: 'bad' }), null)
})
await t('acp: permission handler is wired to ConfirmationService; deny when absent; never allow_always', async () => {
  const conf = new guardLib.ConfirmationService()
  const opts = [{ optionId: 'aa', kind: 'allow_always' }, { optionId: 'ao', kind: 'allow_once' }, { optionId: 'ro', kind: 'reject_once' }]
  const withConf = new acp.AcpDriver('cli', { driver: 'acp', permissionTimeoutMs: 50 }, { confirmation: conf })
  conf.onActionCreated((a) => conf.approve(a.id, '', a.sessionId))
  const approved = await withConf.answerPermission({ sessionId: 's', options: opts, toolCall: { title: 'rm' } }, 'x')
  assert.equal(approved.outcome.optionId, 'ao')
  conf.removeAllListeners?.()
  const noConf = new acp.AcpDriver('cli', { driver: 'acp' })
  assert.equal((await noConf.answerPermission({ options: opts }, 'x')).outcome.optionId, 'ro')
  const timeout = new acp.AcpDriver('cli', { driver: 'acp', permissionTimeoutMs: 10 }, { confirmation: new guardLib.ConfirmationService() })
  assert.equal((await timeout.answerPermission({ options: opts }, 'x')).outcome.optionId, 'ro')
  conf.dispose()
})
await t('acp: permission handler installed on connect, refuses to run if it cannot be', async () => {
  const d = new acp.AcpDriver('cli', { driver: 'acp' })
  let installed
  const model = { client: null, async connectClient() { this.client = { setPermissionRequestHandler: (h) => (installed = h) } } }
  d.installPermissionHandler(model, 'x'); await model.connectClient()
  assert.equal(typeof installed, 'function')
  const bad = { client: null, async connectClient() { this.client = {} } }
  d.installPermissionHandler(bad, 'x')
  await assert.rejects(() => bad.connectClient(), /permission handler/)
})
await t('manager: shutdown calls driver.shutdown', async () => {
  let down = 0
  const m = mgr({ main: { driver: 'custom', factory: () => textModel('x') } })
  await m.use('main'); m.drivers.get('main').then((d) => (d.shutdown = () => { down++ }))
  await new Promise((r) => setTimeout(r, 5)); await m.shutdown()
  assert.equal(down, 1)
})
await t('conversations: a turn is stored, the next call sends it, a foreign owner gets not-found', async () => {
  const conv = await import(`${P}/conversations/index.js`)
  const store = new conv.MemoryConversationStore()
  const m = mgr({ main: customProvider(textModel('first answer')) }, { conversations: { store } })
  const c = await m.conversations.start('user:1')
  const turn = await m.generateText({ prompt: 'question', conversation: { id: c.id, owner: 'user:1' } })
  assert.equal(turn.conversation.version, 1)
  const stored = await store.load(c.id, 'user:1')
  assert.deepEqual(stored.messages.map((x) => x.role), ['user', 'assistant'])
  await assert.rejects(() => m.conversations.get(c.id, 'user:2'), { code: 'E_AI_CONVERSATION_NOT_FOUND' })
})
await t('approvals: a run pauses at an ask tool and resumes after the decision', async () => {
  const counter = { n: 0 }
  let step = 0
  const model = new MockLanguageModelV4({
    provider: 'mock', modelId: 'gpt-4o',
    doGenerate: async () => {
      step++
      if (step === 1) {
        return { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'danger', input: JSON.stringify({ n: 1 }) }], finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: usage(10, 5), warnings: [] }
      }
      return { content: [{ type: 'text', text: 'done' }], finishReason: finish(), usage: usage(10, 5), warnings: [] }
    },
  })
  const tools = { danger: tool({ description: 'd', inputSchema: z.object({ n: z.number() }), execute: async ({ n }) => { counter.n++; return { ok: n } } }) }
  const { MemoryConversationStore } = await import(`${P}/conversations/index.js`)
  const m = mgr({ main: customProvider(model) }, { conversations: { store: new MemoryConversationStore() }, approvals: { secret: 'r'.repeat(32), allowVolatileStore: true } })
  const c = await m.conversations.start('user:1')
  const paused = await m.generateText({ prompt: 'go', tools, toolPermissions: { danger: 'ask' }, approvals: 'resumable', conversation: { id: c.id, owner: 'user:1' } })
  assert.equal(paused.status, 'awaiting-approval')
  assert.equal(counter.n, 0)
  const done = await m.conversations.resolveApprovals(c.id, 'user:1', [{ approvalId: paused.pendingApprovals[0].approvalId, approved: true }], { tools, toolPermissions: { danger: 'ask' } })
  assert.equal(counter.n, 1)
  assert.equal(done.text, 'done')
})
console.log(`\n${passed} passed`)
