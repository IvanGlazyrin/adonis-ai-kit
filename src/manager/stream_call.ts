import { Output, streamText, type LanguageModel, type ModelMessage } from 'ai'
import { approvalsFromMessages, asJson, pendingViews } from '../approvals/resumable.js'
import type { PendingApproval } from '../approvals/types.js'
import type { CallBudgetHold } from '../budget/call_budget.js'
import type { CallEvents } from '../call_events.js'
import type { CircuitBreaker } from '../circuit_breaker.js'
import type { Conversations } from '../conversations/conversations.js'
import { classifyError } from '../error_classifier.js'
import type { Logger } from '../logger.js'
import { validatePromptCache } from '../prompt_cache.js'
import type { GenerateTextOptions, StreamTextOptions, StreamTextResult, TokenUsage } from '../types.js'
import { normalizeUsage, sumUsage } from '../usage.js'
import {
  type StreamCallParams,
  approvalFailure,
  assertNoApprovalParts,
  assertPromptIsString,
  inputMessages,
  withHistory,
  withJsonRecovery,
} from './call_helpers.js'
import type { AttemptContext, ChainRequest } from './fallback.js'
import type { ApprovalContext, AttemptState } from './tool_preparation.js'

export interface StreamCallDeps {
  logger?: Logger
  circuitBreaker: CircuitBreaker
  conversations: () => Conversations
  agentNameOf: (options: { agentName?: string }) => string
  approvalContextOf: (options: GenerateTextOptions) => ApprovalContext | undefined
  approvalExpiry: () => string
  executeWithFallback: <T>(
    request: ChainRequest,
    operation: (ctx: AttemptContext) => Promise<T>
  ) => Promise<{ result: T; provider: string; model: string }>
  warmPricing: (providerName: string, modelName: string) => Promise<void>
  recordCost: (
    agentName: string,
    provider: string,
    model: string,
    usage: TokenUsage,
    durationMs: number,
    pricingReady: Promise<void>,
    metadata: Record<string, unknown>
  ) => Promise<number | undefined>
  warnIfOverBudget: (agentName: string, totalTokens: number, costUsd?: number) => void
  buildTextParams: (
    options: GenerateTextOptions,
    model: LanguageModel,
    state: AttemptState,
    signal?: AbortSignal,
    approval?: ApprovalContext
  ) => StreamCallParams
}

/** `streamText` without the call's start and early-failure events. The stream reports how it ended. */
export async function runStreamCall(
  deps: StreamCallDeps,
  options: StreamTextOptions,
  events: CallEvents,
  budgetHold?: CallBudgetHold
): Promise<StreamTextResult> {
  validatePromptCache(options)
  assertPromptIsString(options.prompt)
  assertNoApprovalParts(options.messages)
  const startTime = Date.now()
  const agentName = deps.agentNameOf(options)
  const approval = deps.approvalContextOf(options)
  const input = inputMessages(options)
  const turn = options.conversation ? await deps.conversations().openTurn(options.conversation, input) : undefined
  const callOptions = turn ? withHistory(options, turn.history, input) : options
  let streamResponseMessages: ModelMessage[] = []
  let streamOutcome: { status: 'completed' | 'awaiting-approval'; pendingApprovals: PendingApproval[] } = {
    status: 'completed',
    pendingApprovals: [],
  }

  const controller = new AbortController()
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, controller.signal])
    : controller.signal

  let settleUsage: (usage: TokenUsage) => void = () => {}
  const usagePromise = new Promise<TokenUsage>((resolve) => {
    settleUsage = resolve
  })

  const { result: raw, provider, model } = await deps.executeWithFallback(
    { ...callOptions, abortSignal: signal, events, budgetHold },
    async ({ getModel, modelName, providerName, breakerKey, state, acp }) => {
      const pricingReady = deps.warmPricing(providerName, modelName)
      const languageModel = withJsonRecovery(await getModel(), callOptions, acp)

      let attemptFailed = false
      let accounted = false
      let streamStarted = false

      // `completedMessages` is set only when the stream ended normally: an aborted or failed stream stores nothing.
      const finish = (
        usage: TokenUsage,
        text: string,
        finishReason?: string,
        extraMetadata: Record<string, unknown> = {},
        completedMessages?: ModelMessage[],
        commitState?: ReturnType<typeof asJson>,
        /** Runs last, once the cost is known: reports how the call ended. */
        settled?: (costUsd: number | undefined) => void
      ): void => {
        if (attemptFailed || accounted) return
        accounted = true
        void (async () => {
          let costUsd: number | undefined
          if (usage.totalTokens > 0) {
            costUsd = await deps.recordCost(
              agentName,
              providerName,
              modelName,
              usage,
              Date.now() - startTime,
              pricingReady,
              { finishReason, ...options.metadata, ...extraMetadata }
            )
            deps.warnIfOverBudget(agentName, usage.totalTokens, costUsd)
            budgetHold?.add(usage.totalTokens, costUsd ?? 0)
          }
          budgetHold?.close()
          if (turn && completedMessages) {
            try {
              await turn.commit(completedMessages, { state: commitState })
            } catch (err) {
              deps.logger?.error?.(`[AiManager] Conversation "${turn.id}" was not stored: ${String(err)}`)
            }
          }
          settleUsage(usage)
          try {
            options.onFinish?.({ text, usage, costUsd })
          } catch (err) {
            deps.logger?.warn?.(`[AiManager] onFinish callback failed: ${String(err)}`)
          }
          settled?.(costUsd)
        })()
      }

      const params = deps.buildTextParams(callOptions, languageModel, state, signal, approval)
      const stream = streamText({
        ...params,
        ...(callOptions.schema ? { output: Output.object({ schema: callOptions.schema }) } : {}),
        onChunk: ({ chunk }) => {
          if (chunk.type === 'text-delta') options.onChunk?.(chunk.text)
        },
        onError: ({ error }) => {
          if (!streamStarted) return // surfaced through the first-part check below
          deps.logger?.warn?.(`[AiManager] Stream error on "${breakerKey}": ${String(error)}`)
          const classification = classifyError(error, signal)
          if (classification.countsAsFailure) {
            deps.circuitBreaker.recordFailure(breakerKey, error)
          }
          // The steps that finished before the error still consumed tokens.
          finish(
            sumUsage(state.stepUsages),
            '',
            undefined,
            { failed: true, errorClass: classification.errorClass },
            undefined,
            undefined,
            () => events.failed(error)
          )
        },
        onEnd: (event) => {
          streamResponseMessages = event.responseMessages
          const pending = approval ? approvalsFromMessages(event.responseMessages, deps.approvalExpiry()) : []
          streamOutcome = {
            status: pending.length > 0 ? 'awaiting-approval' : 'completed',
            pendingApprovals: pending.length > 0 ? pendingViews(event.responseMessages, pending) : [],
          }
          const totalUsage = normalizeUsage(event.totalUsage)
          finish(
            totalUsage,
            event.text,
            event.finishReason,
            {},
            event.responseMessages,
            pending.length > 0 ? asJson({ approvals: pending }) : undefined,
            (costUsd) =>
              events.completed({
                provider: providerName,
                model: modelName,
                usage: totalUsage,
                costUsd,
                finishReason: event.finishReason ?? 'stop',
                status: streamOutcome.status,
              })
          )
        },
        onAbort: (event) =>
          finish(sumUsage(event.steps.map((s) => s.usage)), '', undefined, {}, undefined, undefined, () =>
            events.failed(Object.assign(new Error('Generation aborted'), { name: 'AbortError' }))
          ),
      } as StreamCallParams)

      // Wait for the first meaningful part so early provider errors reject this attempt.
      const iterator = stream.fullStream[Symbol.asyncIterator]()
      try {
        for (;;) {
          const { value, done } = await iterator.next()
          if (done) break
          if (value.type === 'error') throw value.error
          if (value.type === 'abort') {
            throw Object.assign(new Error('Generation aborted'), { name: 'AbortError' })
          }
          if (value.type === 'start' || value.type === 'start-step') continue
          break
        }
      } catch (err) {
        attemptFailed = true
        throw approvalFailure(err, deps.logger)
      } finally {
        // Release only our peek branch; other consumers read their own tee of the stream.
        await iterator.return?.()
      }
      streamStarted = true
      return stream
    }
  )

  // Without a schema the SDK's `output` rejects; expose `undefined` instead.
  const output: Promise<unknown> = options.schema ? Promise.resolve(raw.output) : Promise.resolve(undefined)
  output.catch(() => {}) // a never-read rejection must not surface as unhandled

  return {
    textStream: raw.textStream,
    fullStream: raw.fullStream,
    provider,
    model,
    usage: usagePromise,
    output,
    toTextStreamResponse: (headers) => raw.toTextStreamResponse({ headers }),
    toUIMessageStreamResponse: (opts) => raw.toUIMessageStreamResponse(opts),
    toDataStreamResponse: (headers) => raw.toUIMessageStreamResponse({ headers }),
    consume: async () => {
      const text = await raw.text
      const usage = await usagePromise
      return {
        text,
        usage,
        finishReason: (await raw.finishReason) ?? 'stop',
        responseMessages: streamResponseMessages,
        status: streamOutcome.status,
        pendingApprovals: streamOutcome.pendingApprovals,
        expiredApprovalIds: [],
        provider,
        model,
        durationMs: Date.now() - startTime,
      }
    },
    abort: (reason?: unknown) => controller.abort(reason),
    rawStream: raw,
  }
}
