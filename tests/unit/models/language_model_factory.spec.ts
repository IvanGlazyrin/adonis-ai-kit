import { test } from '@japa/runner'
import { AcpDriver } from '../../../src/acp/provider.js'
import { ConfirmationService } from '../../../src/guard/confirmation.js'
import { LanguageModelFactory } from '../../../src/models/language_model_factory.js'
import { ProviderFactoryRegistry } from '../../../src/models/provider_factories.js'

test.group('LanguageModelFactory', () => {
  test('throws for unsupported provider npm package', async ({ assert }) => {
    await assert.rejects(
      () =>
        new LanguageModelFactory().create({
          providerID: 'fake',
          modelID: 'x',
          npm: 'unknown-pkg',
        }),
      /unknown-pkg/
    )
  })

  test('creates a language model through a registered provider factory', async ({ assert }) => {
    const created = { id: 'test-model' } as any
    const factories = new ProviderFactoryRegistry().register('@ai-sdk/openai-compatible', (s) => ({
      languageModel: (id: string) => ({ ...created, id, provider: s.name }),
    }))
    const model = await new LanguageModelFactory({ factories }).create({
      providerID: 'local-openai',
      modelID: 'test-model',
      npm: '@ai-sdk/openai-compatible',
      apiUrl: 'http://127.0.0.1:9766/v1',
      apiKey: 'test-key',
      headers: { 'X-Test': 'yes' },
    })
    assert.include(model as any, {
      id: 'test-model',
      provider: 'local-openai',
    })
  })

  test('ACP model without runtime config is a config error', async ({ assert }) => {
    await assert.rejects(
      () =>
        new LanguageModelFactory().create({
          providerID: 'acp-x',
          modelID: 'x',
          npm: '@mcpc-tech/acp-ai-provider',
        }),
      /runtime config/
    )
  })

  test('factory receives credentials and a timeout fetch', async ({ assert }) => {
    let seen: any
    const factories = new ProviderFactoryRegistry().register('mock', (s) => {
      seen = s
      return { languageModel: () => ({}) as any }
    })
    await new LanguageModelFactory({ factories }).create({
      providerID: 'p',
      modelID: 'm',
      npm: 'mock',
      apiKey: 'k',
      apiUrl: 'http://u',
    })
    assert.include(seen, { name: 'p', apiKey: 'k', baseURL: 'http://u' })
    assert.isFunction(seen.fetch)
  })

  test('logs redact secret headers', async ({ assert }) => {
    const lines: string[] = []
    const push = (m: string) => void lines.push(m)
    const logger = { debug: push, info: push, warn: push, error: push }
    const factories = new ProviderFactoryRegistry().register('mock', () => ({
      languageModel: () => ({}) as any,
    }))
    await new LanguageModelFactory({ factories, logger }).create({
      providerID: 'p',
      modelID: 'm',
      npm: 'mock',
      headers: { Authorization: 's', 'X-Title': 't' },
    })
    const all = lines.join('\n')
    assert.notMatch(all, /Authorization":"s/)
    assert.include(all, '"X-Title":"t"')
    assert.include(all, '***')
  })

  test('shutdown without ACP models is a no-op', async () => {
    await new LanguageModelFactory().shutdown()
  })
})

const acpModel = (cwd: string) => ({
  providerID: 'acp-x',
  modelID: 'x',
  npm: '@mcpc-tech/acp-ai-provider',
  acpConfig: { command: 'agent', args: [], cwd, env: {}, mcpServers: [] },
})

/** Stubs `AcpDriver.getModel` (no agent process) and records every driver that served a call. */
async function withStubbedAcp(run: (served: AcpDriver[]) => Promise<void>) {
  const original = AcpDriver.prototype.getModel
  const served: AcpDriver[] = []
  AcpDriver.prototype.getModel = async function (this: AcpDriver) {
    served.push(this)
    return {} as any
  }
  try {
    await run(served)
  } finally {
    AcpDriver.prototype.getModel = original
  }
}

test.group('LanguageModelFactory ACP options', () => {
  test('acp.env is passed to every agent driver', async ({ assert }) => {
    await withStubbedAcp(async (served) => {
      const factory = new LanguageModelFactory({
        acp: { inheritEnv: true, env: { HTTPS_PROXY: 'http://proxy.example:8080' } },
      })
      await factory.create(acpModel(process.cwd()) as any)
      assert.deepEqual((served[0] as any).config.env, { HTTPS_PROXY: 'http://proxy.example:8080' })
    })
  })

  test('shares one driver per command and cwd by default and stops it on shutdown', async ({ assert }) => {
    await withStubbedAcp(async (served) => {
      const factory = new LanguageModelFactory()
      await factory.create(acpModel(process.cwd()) as any)
      await factory.create(acpModel(process.cwd()) as any)
      assert.strictEqual(served[0], served[1])
      assert.equal((served[0] as any).config.inheritEnv, false)
    })
  })

  test('shareDriver: false creates a driver per call', async ({ assert }) => {
    await withStubbedAcp(async (served) => {
      const factory = new LanguageModelFactory({
        acp: { shareDriver: false, inheritEnv: true },
      })
      await factory.create(acpModel(process.cwd()) as any)
      await factory.create(acpModel(process.cwd()) as any)
      assert.notStrictEqual(served[0], served[1])
      assert.isTrue((served[0] as any).config.inheritEnv)
    })
  })

  test('shareDriver: false stops tracking each driver when its call ends', async ({ assert }) => {
    const original = AcpDriver.prototype.getModel
    const originalShutdown = AcpDriver.prototype.shutdown
    const stopped: AcpDriver[] = []
    AcpDriver.prototype.getModel = async function () {
      return {
        doGenerate: async () => ({ text: 'ok' }),
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue('a')
              controller.close()
            },
          }),
        }),
      } as any
    }
    AcpDriver.prototype.shutdown = async function (this: AcpDriver) {
      stopped.push(this)
    }
    try {
      const factory = new LanguageModelFactory({ acp: { shareDriver: false } })
      const tracked = () => (factory as any).unsharedDrivers.size
      for (let i = 0; i < 3; i++) {
        const model = (await factory.create(acpModel(process.cwd()) as any)) as any
        assert.equal(tracked(), 0, 'a created but not yet called model is not retained')
        await model.doGenerate({})
        assert.equal(tracked(), 0)
      }
      const streamed = (await factory.create(acpModel(process.cwd()) as any)) as any
      const { stream } = await streamed.doStream({})
      assert.equal(tracked(), 1, 'tracked while the stream is open')
      const reader = stream.getReader()
      while (!(await reader.read()).done);
      assert.equal(tracked(), 0)

      const cancelled = (await factory.create(acpModel(process.cwd()) as any)) as any
      const second = await cancelled.doStream({})
      await second.stream.cancel()
      assert.equal(tracked(), 0)
      assert.lengthOf(stopped, 0, 'the ACP model cleans up its own process; the factory only stops in-flight drivers')
    } finally {
      AcpDriver.prototype.getModel = original
      AcpDriver.prototype.shutdown = originalShutdown
    }
  })

  test('shareDriver: false releases the driver when the call fails', async ({ assert }) => {
    const original = AcpDriver.prototype.getModel
    AcpDriver.prototype.getModel = async function () {
      return {
        doGenerate: async () => {
          throw new Error('boom')
        },
      } as any
    }
    try {
      const factory = new LanguageModelFactory({ acp: { shareDriver: false } })
      const model = (await factory.create(acpModel(process.cwd()) as any)) as any
      await assert.rejects(() => model.doGenerate({}), /boom/)
      assert.equal((factory as any).unsharedDrivers.size, 0)
    } finally {
      AcpDriver.prototype.getModel = original
    }
  })

  test('shutdown stops an unshared driver whose call is in flight', async ({ assert }) => {
    const original = AcpDriver.prototype.getModel
    const originalShutdown = AcpDriver.prototype.shutdown
    const stopped: AcpDriver[] = []
    let finish!: () => void
    AcpDriver.prototype.getModel = async function () {
      return {
        doGenerate: () => new Promise((resolve) => (finish = () => resolve({ text: 'ok' }))),
      } as any
    }
    AcpDriver.prototype.shutdown = async function (this: AcpDriver) {
      stopped.push(this)
    }
    try {
      const factory = new LanguageModelFactory({ acp: { shareDriver: false } })
      const model = (await factory.create(acpModel(process.cwd()) as any)) as any
      const call = model.doGenerate({})
      assert.equal((factory as any).unsharedDrivers.size, 1)
      await factory.shutdown()
      assert.lengthOf(stopped, 1)
      finish()
      await call
      assert.lengthOf(stopped, 1, 'not stopped twice')
    } finally {
      AcpDriver.prototype.getModel = original
      AcpDriver.prototype.shutdown = originalShutdown
    }
  })

  test('shutdown during a later step of a multi-step call stops the driver once', async ({ assert }) => {
    const original = AcpDriver.prototype.getModel
    const originalShutdown = AcpDriver.prototype.shutdown
    const stopped: AcpDriver[] = []
    let closeStream!: () => void
    let calls = 0
    AcpDriver.prototype.getModel = async function () {
      return {
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue('a')
              if (++calls === 1) controller.close()
              else closeStream = () => controller.close()
            },
          }),
        }),
      } as any
    }
    AcpDriver.prototype.shutdown = async function (this: AcpDriver) {
      stopped.push(this)
    }
    try {
      const factory = new LanguageModelFactory({ acp: { shareDriver: false } })
      const tracked = () => (factory as any).unsharedDrivers.size
      const model = (await factory.create(acpModel(process.cwd()) as any)) as any

      const step1 = await model.doStream({})
      const reader1 = step1.stream.getReader()
      while (!(await reader1.read()).done);
      assert.equal(tracked(), 0, 'not tracked after a completed call')
      assert.lengthOf(stopped, 0)

      const step2 = await model.doStream({})
      assert.equal(tracked(), 1, 'tracked again while step 2 is in flight')
      await factory.shutdown()
      assert.lengthOf(stopped, 1)

      closeStream()
      const reader2 = step2.stream.getReader()
      while (!(await reader2.read()).done);
      assert.lengthOf(stopped, 1, 'not stopped twice')
      assert.equal(tracked(), 0)
    } finally {
      AcpDriver.prototype.getModel = original
      AcpDriver.prototype.shutdown = originalShutdown
    }
  })

  test('passes the confirmation service to the driver', async ({ assert }) => {
    await withStubbedAcp(async (served) => {
      const confirmation = new ConfirmationService()
      await new LanguageModelFactory({ acp: { confirmation } }).create(acpModel(process.cwd()) as any)
      assert.strictEqual((served[0] as any).confirmation, confirmation)
      confirmation.dispose()
    })
  })
})
