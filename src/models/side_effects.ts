import type { StepResult, ToolSet } from 'ai'

/** AI SDK hooks that tell a fallback decision whether a side effect may already have happened. */
export interface AttemptSideEffectHooks {
  /** Pass as `onToolExecutionStart`: runs before each local `execute`, including approved tools. */
  onToolExecutionStart: () => void
  /**
   * Pass as `onStepEnd`: marks the attempt when the step has a valid tool call. That covers
   * provider-executed tools and ACP agent calls, which run outside the SDK's local `execute`.
   */
  onStepEnd: (step: StepResult<ToolSet>) => void
}

/**
 * Hooks for one attempt. `mark` runs as soon as a tool may have run, so the caller can refuse a fallback
 * after it. `observe` (optional) sees every finished step, for example to sum its usage.
 * Calls whose `invalid` flag is set never ran, so they are not marked.
 */
export function attemptSideEffectHooks(
  mark: () => void,
  observe?: (step: StepResult<ToolSet>) => void
): AttemptSideEffectHooks {
  return {
    onToolExecutionStart: () => mark(),
    onStepEnd: (step) => {
      if (step.toolCalls.some((call) => !call.invalid)) mark()
      observe?.(step)
    },
  }
}
