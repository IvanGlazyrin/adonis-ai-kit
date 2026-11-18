import type { StepResult, ToolSet } from 'ai'
import type { AiToolCallInfo } from './types.js'

/** The tool calls of a finished step, each with its result when the step has one. */
export function toolCallsOf(step: StepResult<ToolSet>): AiToolCallInfo[] {
  return step.toolCalls.map((call) => {
    const result = step.toolResults.find((r) => r.toolCallId === call.toolCallId)
    return {
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      input: call.input,
      ...(result ? { output: result.output } : {}),
      invalid: (call as { invalid?: boolean }).invalid === true,
    }
  })
}
