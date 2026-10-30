import { tool } from 'ai'
import { z } from 'zod'
import { AcpCallFailedError, AiException, SubAgentApprovalError, SubAgentError } from '../errors.js'
import { currentSubAgent, runAsSubAgent, type SubAgentRun } from '../run_context.js'
import type { GenerateTextOptions } from '../types.js'
import type { AgentRunner } from './agent_runner.js'

/** Tells the calling model what the sub-agent cannot see (same idea as laravel/ai AgentTool). */
const SUB_AGENT_NOTE = 'The sub-agent does not see this conversation history: it receives only the task.'

/**
 * Tokens and USD that sub-agents spent in one run. Pass it to `agentAsTool(runner, { spend })` and to
 * `stopOnBudget(limits, costTracker, { extra: spend })`, so the parent's budget counts the sub-agent calls.
 */
export class SubAgentSpend {
  private usedTokens = 0
  private usedCostUsd = 0

  add(usage: { tokens: number; costUsd?: number }): void {
    this.usedTokens += usage.tokens
    this.usedCostUsd += usage.costUsd ?? 0
  }

  tokens(): number {
    return this.usedTokens
  }

  costUsd(): number {
    return this.usedCostUsd
  }
}

export interface AgentAsToolOptions {
  /** Guard for the sub-agent's tools. It is not inherited from the parent. */
  toolGuard?: GenerateTextOptions['toolGuard']
  /** Receives the tokens and cost of each successful sub-agent run. */
  spend?: SubAgentSpend
  /** How many levels of sub-agents may nest; 1 (the default) means a sub-agent cannot call another sub-agent. */
  maxDepth?: number
}

/**
 * Calls an agent as a tool of another agent. The sub-agent receives only the task string: the parent's messages
 * (the `messages` the SDK passes to `execute`) are not used. Its tools are the ones in its own runner options, and
 * only those its manifest allows: every other tool is denied.
 *
 * A tool inside the sub-agent that needs human approval cannot wait for one: the sub-agent run stops with
 * `SubAgentApprovalError`, and the parent sees that as a tool error.
 */
export function agentAsTool(runner: AgentRunner, options: AgentAsToolOptions = {}) {
  const config = runner.getConfig()
  const maxDepth = options.maxDepth ?? 1
  if (config.mode === 'primary') {
    throw new AiException(
      `Agent "${config.id}" is a primary agent and cannot be used as a sub-agent; set "mode: subagent" in its manifest.`,
      'E_AI_CONFIG_ERROR'
    )
  }
  // A sub-agent cannot ask a human, so an `ask` tool in its manifest is a configuration error, reported now.
  for (const [toolName, permission] of Object.entries(config.permissions)) {
    if (permission === 'ask') throw new SubAgentApprovalError(config.id, toolName)
  }
  const subAgent = runner.withOptions({
    defaultToolPermission: 'deny',
    sessionId: undefined,
    toolGuard: options.toolGuard,
  })

  return tool({
    description: [config.description, SUB_AGENT_NOTE].filter(Boolean).join('\n\n'),
    inputSchema: z.object({ task: z.string().min(1) }),
    execute: async ({ task }, { abortSignal }) => {
      const depth = (currentSubAgent()?.depth ?? 0) + 1
      if (depth > maxDepth) {
        throw new AiException(
          `Sub-agent "${config.id}" would be nested ${depth} levels deep; the limit is ${maxDepth} (E_AI_SUBAGENT_DEPTH).`,
          'E_AI_SUBAGENT_DEPTH'
        )
      }
      const run: SubAgentRun = { agent: config.id, depth, abort: new AbortController() }
      const forwardAbort = () => run.abort.abort(abortSignal?.reason)
      if (abortSignal?.aborted) forwardAbort()
      abortSignal?.addEventListener('abort', forwardAbort, { once: true })

      let text: string
      try {
        const result = await runAsSubAgent(run, () => subAgent.run({ prompt: task, abortSignal: run.abort.signal }))
        text = result.text
        options.spend?.add({ tokens: result.usage.totalTokens, costUsd: result.costUsd })
      } catch (err) {
        if (run.approvalError) throw run.approvalError
        if (abortSignal?.aborted) throw err
        // Typed errors that the caller acts on pass through; anything else becomes a tool error for the parent.
        if (err instanceof AcpCallFailedError || err instanceof SubAgentApprovalError) throw err
        throw new SubAgentError(config.id, err)
      } finally {
        abortSignal?.removeEventListener('abort', forwardAbort)
      }
      // The sub-agent may finish its last step before it notices the abort, so the approval check runs here too.
      if (run.approvalError) throw run.approvalError
      return text
    },
  })
}
