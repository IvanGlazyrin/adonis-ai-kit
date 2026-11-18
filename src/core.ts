/**
 * Everything the kit offers without the AdonisJS HTTP layer: the manager, models, guards, budget, catalog, agents,
 * MCP and approvals. `adonis-ai-kit` re-exports all of it plus the `response.streamAI()` macro and the `configure`
 * hook. Import from `adonis-ai-kit/core` to use the kit outside an AdonisJS HTTP server or to build on it in
 * another library.
 */
export * from './types.js'
export type { Logger } from './logger.js'
export * from './errors.js'
export * from './error_classifier.js'
export * from './circuit_breaker.js'
export * from './define_config.js'
export * from './ai_manager.js'
export * from './catalog/index.js'
export * from './acp/index.js'
export * from './agents/index.js'
export * from './guard/index.js'
export * from './budget/index.js'
export * from './models/index.js'
export * from './json_recovery.js'
export * from './approvals/index.js'
export { normalizeUsage, sumUsage, EMPTY_USAGE } from './usage.js'

// Explicitly resolve re-export ambiguities from star exports
export type { ToolPermission } from './guard/index.js'
