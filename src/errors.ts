/**
 * Base exception class for all Adonis AI package errors.
 */
export class AiException extends Error {
  constructor(
    message: string,
    public code: string = 'E_AI_ERROR',
    public cause?: unknown
  ) {
    super(message)
    this.name = 'AiException'
  }
}

/**
 * Thrown when an AI provider is unreachable or circuit breaker is open.
 */
export class ProviderUnavailableError extends AiException {
  constructor(public provider: string, reason?: string) {
    super(
      `AI provider "${provider}" is currently unavailable: ${reason ?? 'Circuit breaker is OPEN'}`,
      'E_AI_PROVIDER_UNAVAILABLE'
    )
    this.name = 'ProviderUnavailableError'
  }
}

/**
 * Thrown when provider configuration is invalid or missing required credentials.
 */
export class ProviderConfigError extends AiException {
  constructor(public provider: string, message: string) {
    super(`Invalid configuration for AI provider "${provider}": ${message}`, 'E_AI_CONFIG_ERROR')
    this.name = 'ProviderConfigError'
  }
}

/**
 * Thrown when primary provider and all fallback cascade providers fail.
 */
export class CascadingFallbackError extends AiException {
  constructor(public attempts: Array<{ provider: string; model: string; error: Error }>) {
    const errorDetails = attempts.map((a) => `[${a.provider}:${a.model}] ${a.error.message}`).join('; ')
    super(`All AI fallback providers failed: ${errorDetails}`, 'E_AI_FALLBACK_FAILED')
    this.name = 'CascadingFallbackError'
  }
}

/**
 * Thrown when token or cost budget thresholds are exceeded.
 */
export class BudgetExceededError extends AiException {
  constructor(message: string, public currentUsage?: unknown) {
    super(message, 'E_AI_BUDGET_EXCEEDED')
    this.name = 'BudgetExceededError'
  }
}

/**
 * Thrown instead of falling back when an ACP agent failed during a run. The agent may already have changed files
 * or run commands, so only the caller can decide: retry through the same agent, use another model, or cancel.
 * The original error is kept in `original`, not `cause`, so error classification does not see it as retryable.
 */
export class AcpCallFailedError extends AiException {
  readonly sideEffectsPossible = true

  constructor(public agentKey: string, public original: unknown) {
    const detail = original instanceof Error ? original.message : String(original)
    super(
      `ACP agent "${agentKey}" failed during a run and may have changed files: ${detail}`,
      'E_AI_ACP_CALL_FAILED'
    )
    this.name = 'AcpCallFailedError'
  }
}

/**
 * Thrown when a tool execution is rejected by security policy or fails during run.
 */
export class ToolExecutionError extends AiException {
  constructor(public toolName: string, message: string, cause?: unknown) {
    super(`Tool execution error for "${toolName}": ${message}`, 'E_AI_TOOL_EXECUTION_ERROR', cause)
    this.name = 'ToolExecutionError'
  }
}

/**
 * An agent used as a tool (`agentAsTool`) failed. The parent model sees it as a tool error, and the parent run goes
 * on. `original` keeps the sub-agent's error.
 */
export class SubAgentError extends AiException {
  constructor(public agent: string, public original: unknown) {
    const detail = original instanceof Error ? original.message : String(original)
    super(`Sub-agent "${agent}" failed (E_AI_SUBAGENT_FAILED): ${detail}`, 'E_AI_SUBAGENT_FAILED')
    this.name = 'SubAgentError'
  }
}

/**
 * A sub-agent tried to run a tool that needs human approval. Sub-agents cannot ask, so the sub-agent run stops with
 * this error. A manifest with an `ask` tool is refused when the sub-agent tool is created.
 */
export class SubAgentApprovalError extends AiException {
  constructor(public agent: string, public toolName: string) {
    super(
      `Sub-agent "${agent}" cannot run tool "${toolName}": it needs human approval, and sub-agents cannot ask (E_AI_SUBAGENT_APPROVAL_REQUIRED)`,
      'E_AI_SUBAGENT_APPROVAL_REQUIRED'
    )
    this.name = 'SubAgentApprovalError'
  }
}
