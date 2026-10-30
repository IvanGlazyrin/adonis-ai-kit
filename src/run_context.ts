import { AsyncLocalStorage } from 'node:async_hooks'
import type { SubAgentApprovalError } from './errors.js'

/**
 * The sub-agent run the current async chain belongs to. `agentAsTool` sets it around the sub-agent's run, and code that
 * would wait for a human (`ConfirmationService`) reads it. It lives here, not in `agents/`, so the guard does not
 * import the agents.
 */
export interface SubAgentRun {
  readonly agent: string
  /** 1 for a sub-agent of a top-level agent, 2 for a sub-agent of a sub-agent, and so on. */
  readonly depth: number
  /** Aborts the sub-agent's run. */
  readonly abort: AbortController
  /** Set once a tool inside the sub-agent asked for approval; the sub-agent's call then fails with it. */
  approvalError?: SubAgentApprovalError
}

const storage = new AsyncLocalStorage<SubAgentRun>()

/** The sub-agent run this async chain belongs to, or `undefined` outside any sub-agent. */
export function currentSubAgent(): SubAgentRun | undefined {
  return storage.getStore()
}

/** Runs `fn` with `run` as the current sub-agent run; every async step it starts sees the same run. */
export function runAsSubAgent<T>(run: SubAgentRun, fn: () => Promise<T>): Promise<T> {
  return storage.run(run, fn)
}
