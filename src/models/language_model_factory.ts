import type { LanguageModel } from 'ai'
import { AcpDriver } from '../acp/provider.js'
import type { AcpAgentRuntimeConfig, AcpPermissionPolicy } from '../acp/types.js'
import { ProviderConfigError } from '../errors.js'
import type { ConfirmationService } from '../guard/confirmation.js'
import type { Logger } from '../logger.js'
import { ProviderFactoryRegistry } from './provider_factories.js'
import type { ResolvedModel } from './types.js'

export interface LanguageModelFactoryOptions {
  factories?: ProviderFactoryRegistry
  /** Per-request fetch timeout. Default: 180_000 */
  timeoutMs?: number
  logger?: Logger
  acp?: {
    permissionPolicy?: AcpPermissionPolicy
    confirmation?: ConfirmationService
    /** Pass the full server environment to agent processes. Default: false (allowlisted variables only). */
    inheritEnv?: boolean
    /** Reuse one driver (and agent process) per command and cwd. Default: true. */
    shareDriver?: boolean
  }
}

const ACP_NPM = '@mcpc-tech/acp-ai-provider'
const DEFAULT_TIMEOUT_MS = 180_000

function redactHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      const lower = key.toLowerCase()
      const sensitive =
        lower.includes('authorization') || lower.includes('api-key') || lower.includes('x-api')
      return [key, sensitive ? '***' : value]
    })
  )
}

/** The request's abort signal: the timeout, plus the caller's own signal when it gives one. */
function requestSignal(timeoutMs: number, callerSignal: AbortSignal | null | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout
}

/** The log-safe URL (cut to 120 characters) and the method of a request; POST when none is given. */
function describeRequest(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): { url: string; method: string } {
  return { url: requestUrl(input).slice(0, 120), method: init?.method || 'POST' }
}

/** The message of a thrown value, for logs. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
}

export class LanguageModelFactory {
  private readonly factories: ProviderFactoryRegistry
  private readonly timeoutMs: number
  private readonly logger?: Logger
  private readonly acp: LanguageModelFactoryOptions['acp']
  private readonly drivers = new Map<string, AcpDriver>()
  /** Unshared drivers with a call in flight; tracked so `shutdown()` can stop them. Emptied as calls end. */
  private readonly unsharedDrivers = new Set<AcpDriver>()

  constructor(options: LanguageModelFactoryOptions = {}) {
    this.factories = options.factories ?? new ProviderFactoryRegistry()
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.logger = options.logger
    this.acp = options.acp
  }

  async create(model: ResolvedModel): Promise<LanguageModel> {
    if (model.npm === ACP_NPM) return this.createAcp(model)

    if (!model.npm) {
      throw new ProviderConfigError(model.providerID, `Model "${model.modelID}" has no provider package`)
    }
    const factory = await this.factories.get(model.npm)

    this.logger?.info(
      `[LLM Provider] Creating SDK for ${model.providerID}/${model.modelID} (npm=${model.npm})`
    )
    this.logger?.info(`[LLM Provider] Base URL: ${model.apiUrl}`)
    this.logger?.info(`[LLM Provider] Headers: ${JSON.stringify(redactHeaders(model.headers))}`)

    return factory({
      name: model.providerID,
      apiKey: model.apiKey,
      baseURL: model.apiUrl,
      headers: model.headers,
      fetch: this.createTimeoutFetch(),
    }).languageModel(model.modelID)
  }

  /** Stops every ACP agent process started by this factory. */
  async shutdown(): Promise<void> {
    const drivers = [...this.drivers.values(), ...this.unsharedDrivers]
    this.drivers.clear()
    this.unsharedDrivers.clear()
    await Promise.all(drivers.map((driver) => driver.shutdown()))
  }

  private async createAcp(model: ResolvedModel): Promise<LanguageModel> {
    const runtime = model.acpConfig
    if (!runtime) {
      throw new ProviderConfigError(
        model.providerID,
        `ACP model "${model.modelID}" requires runtime config (resolve it with buildAcpRuntimeConfig)`
      )
    }

    const agentId = model.acpAgentId ?? model.modelID
    this.logger?.info(`[LLM Provider] Creating ACP agent for ${model.providerID}/${model.modelID}`)
    this.logger?.info(`[LLM Provider] ACP command: ${runtime.command} (cwd: ${runtime.cwd})`)

    const shared = this.acp?.shareDriver !== false
    const driver = this.driverFor(model, runtime, agentId, shared)
    const languageModel = await driver.getModel(agentId)
    return shared ? languageModel : this.releaseWhenCallEnds(driver, languageModel)
  }

  /** The shared driver for this command and cwd, created on first use; a per-call driver when sharing is off. */
  private driverFor(
    model: ResolvedModel,
    runtime: AcpAgentRuntimeConfig,
    agentId: string,
    shared: boolean
  ): AcpDriver {
    const key = `${runtime.command}::${runtime.cwd}`
    const existing = shared ? this.drivers.get(key) : undefined
    if (existing) return existing

    const driver = new AcpDriver(
      model.providerID,
      {
        driver: 'acp',
        agentId,
        permissionPolicy: this.acp?.permissionPolicy ?? 'ask',
        inheritEnv: this.acp?.inheritEnv ?? false,
      },
      { logger: this.logger, confirmation: this.acp?.confirmation, runtime }
    )
    if (shared) this.drivers.set(key, driver)
    return driver
  }

  /**
   * Wraps a per-call model so its driver is tracked only while a call is in flight (so shutdown()
   * can stop it) and released when the last call ends (result, error, stream end or cancel). A model
   * that is never called is not tracked, so it is collected together with its driver.
   */
  private releaseWhenCallEnds(driver: AcpDriver, model: LanguageModel): LanguageModel {
    if (typeof model !== 'object' || model === null) return model
    const track = this.trackCalls(driver)

    return new Proxy(model as object, {
      get: (target, prop) => {
        const value = Reflect.get(target, prop, target)
        if (typeof value !== 'function') return value
        if (prop === 'doGenerate') return this.trackedGenerate(value, target, track)
        if (prop === 'doStream') return this.trackedStream(value, target, track)
        return value.bind(target)
      },
    }) as LanguageModel
  }

  /**
   * In-flight accounting for one driver's per-call model. The driver is tracked from the first
   * call until the last one ends.
   */
  private trackCalls(driver: AcpDriver): { begin: () => void; end: () => void } {
    let inFlight = 0
    return {
      begin: () => {
        inFlight++
        this.unsharedDrivers.add(driver)
      },
      // The ACP model cleans up its own agent process at the end of each turn. The driver is not shut
      // down here: that would drop its provider, and a later step of the same call would then start a
      // process that factory.shutdown() could no longer reach.
      end: () => {
        if (--inFlight > 0) return
        this.unsharedDrivers.delete(driver)
      },
    }
  }

  private trackedGenerate(
    generate: (...args: unknown[]) => unknown,
    target: object,
    track: { begin: () => void; end: () => void }
  ) {
    return async (...args: unknown[]) => {
      track.begin()
      try {
        return await generate.apply(target, args)
      } finally {
        track.end()
      }
    }
  }

  private trackedStream(
    stream: (...args: unknown[]) => Promise<{ stream: ReadableStream }>,
    target: object,
    track: { begin: () => void; end: () => void }
  ) {
    return async (...args: unknown[]) => {
      track.begin()
      let result: { stream: ReadableStream }
      try {
        result = await stream.apply(target, args)
      } catch (err) {
        track.end()
        throw err
      }
      return { ...result, stream: this.endWith(result.stream, track.end) }
    }
  }

  /** Re-exposes a stream, calling `done` exactly once when it ends, errors or is cancelled. */
  private endWith<T>(source: ReadableStream<T>, done: () => void): ReadableStream<T> {
    const reader = source.getReader()
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      done()
    }
    return new ReadableStream<T>({
      async pull(controller) {
        try {
          const chunk = await reader.read()
          if (chunk.done) {
            finish()
            controller.close()
          } else {
            controller.enqueue(chunk.value)
          }
        } catch (err) {
          finish()
          controller.error(err)
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason)
        } finally {
          finish()
        }
      },
    })
  }

  private createTimeoutFetch(): typeof fetch {
    const { timeoutMs, logger } = this
    return async (input, init) => {
      const { url, method } = describeRequest(input, init)
      const startMs = Date.now()

      logger?.debug?.(`[LLM HTTP] ${method} ${url} | timeout=${timeoutMs}ms`)
      try {
        const response = await fetch(input, { ...init, signal: requestSignal(timeoutMs, init?.signal) })
        logger?.debug?.(`[LLM HTTP] ${response.status} ${method} ${url} | ${Date.now() - startMs}ms`)
        return response
      } catch (err) {
        logger?.error(`[LLM HTTP] FAILED ${method} ${url} | ${Date.now() - startMs}ms | ${messageOf(err)}`)
        throw err
      }
    }
  }
}
