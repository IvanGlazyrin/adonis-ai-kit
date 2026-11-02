# Changelog

All notable changes to `adonis-ai-kit` are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.3.0] - 2026-11-02

### Changed

- Skill files: frontmatter is no longer sent to the model. A `---` block at the top of a skill file is read (`description`, and `name` for a warning on mismatch) and removed from the body in both modes. Without a description, the first `# heading` is used as one. A skill file over 256 KB is skipped with a warning in both modes; before, it loaded in full. A file without frontmatter loads byte-identically.
- A retryable ACP failure during a run now throws `AcpCallFailedError` (code `E_AI_ACP_CALL_FAILED`, `sideEffectsPossible: true`) instead of the agent's own error. The original error is in `original`. It is not classified as retryable (`classifyErrorClass` returns `unknown` for it, since its message quotes the agent's error, which may say "timeout"), so the caller decides whether to retry through the agent, use another model, or cancel. The same error is thrown in a `driver: 'acp'` cascade, as in a model chain. One thrown by a tool (a sub-agent running an ACP agent, for example) stops the run after the step, so the model cannot start the agent again, and the call throws it.
- Fallback is now refused after provider-executed tool calls and after a retryable ACP failure. A provider-executed tool call (for example a server-side web search) counts as a side effect, as does a call to an ACP agent that started; a retryable ACP failure (timeout, overload, network) is thrown as `AcpCallFailedError` instead of moving to the next model. Missing ACP packages and config errors still fall back. Unknown tools (`invalid` calls) do not count, since they never ran.
- Tokens consumed by a failed attempt, from its finished steps (or from a `NoObjectGeneratedError`), are recorded in the cost tracker with `metadata.failed: true` and the error class. A stream that fails after it started records the usage of its finished steps.
- `AiManager` passes `onStepEnd` to the AI SDK instead of the deprecated `onStepFinish`. The `onStepFinish` option keeps working and runs after the side-effect check.
- The `ai` peer and dev dependency range is `^7.0.137` (it was `^7.0.0`).
- New `attemptSideEffectHooks()` export from `adonis-ai-kit/models` for code that calls the AI SDK directly: it returns the `onToolExecutionStart` and `onStepEnd` hooks that mark a side effect.

### Added

- Resumable approvals: `approvals: 'resumable'` on `generateText` / `streamText` (or `AiConfig.approvals.mode`) stops the run at an `ask` tool. The result has `status: 'awaiting-approval'` and `pendingApprovals`; `ai.conversations.resolveApprovals(id, owner, decisions, callOptions)` and `ai.conversations.resume(id, owner, callOptions)` continue it, also after a restart. Requests are signed with the AI SDK's HMAC (`experimental_toolApprovalSecret`, `approvals.secret`, at least 32 bytes; wrap it with `approvalSecret()` so it does not show in logs or JSON). A changed or unsigned request throws `ApprovalSignatureError` (`E_AI_APPROVAL_INVALID`), and the step is closed with a denial. An unknown or replayed id is `ApprovalNotFoundError`; a partial set of decisions is `ApprovalIncompleteError`. An approved tool runs at most once: its decision and "executing" mark are stored before it runs, and a retry uses the stored result. Expired approvals (`approvals.ttlMs`, default 24 hours) are denied (`expiredApprovalIds`). `resumable` needs a durable conversation store. `ToolRegistry.getToolsWithApprovals()` returns the tools with their `user-approval` / `not-applicable` statuses and their `toolPermissions`; pass the permissions to `AiManager` with the tools, because without them a non-MCP tool is read as `allow` and an `ask` tool would run without approval. A call's own `messages` (also `generateObject`'s) may not contain `tool-approval-request` or `tool-approval-response` parts (`E_AI_APPROVAL_REPLAY`), in either mode, because a copied signed approval could run its tool in another conversation; a message list taken from `responseMessages` of a step that asked for approval cannot be sent back as `messages`: continue a `resumable` step with a conversation and `resolveApprovals`. `prompt` must be a string (`E_AI_INVALID_ARGUMENT`); the AI SDK accepts a message list there, which would skip that check. An approved streaming tool runs once and the model gets its last chunk. `E_AI_APPROVAL_*` errors are fatal: they never move a call to another model.
- Conversations (`adonis-ai-kit/conversations`): `ai.conversations` (`start(owner)`, `get`, `list`, `delete`) and the `conversation: { id, owner, prepareHistory? }` option of `generateText` / `streamText` (also through `AgentRunner`). A turn is stored after the model answered, with a version check (`ConversationConflictError`); a failed or aborted call stores nothing. The owner is checked by the kit on every call: a foreign owner gets `E_AI_CONVERSATION_NOT_FOUND`, the same as an unknown id, and the model is not called. The `ConversationStore` port has an in-memory default (`durable: false`); `conversationStoreContract()` from `adonis-ai-kit/testing` checks an application adapter. `GenerateTextResult.responseMessages` and `conversation` are new fields.
- Sub-agents: `agentAsTool(runner, { toolGuard, spend, maxDepth })` from `adonis-ai-kit/agents` calls an agent as a tool of another agent. The sub-agent receives only the task, offers only the tools its manifest allows (deny by default), and cannot run an `ask` tool: the parent's call fails with `E_AI_SUBAGENT_APPROVAL_REQUIRED`. Failures reach the parent as `E_AI_SUBAGENT_FAILED`; an `AcpCallFailedError` stops the parent run, so the model cannot start the agent again (in `streamText` the run stops but the stream does not error). `SubAgentSpend` and `stopOnBudget(..., { extra })` count sub-agent spend in the parent's budget. Nesting is limited to `maxDepth` (default 1, `E_AI_SUBAGENT_DEPTH`); a `primary` agent is refused (`E_AI_CONFIG_ERROR`).
- Skills on demand: agent manifest `skillLoading: 'eager' | 'on-demand'` (default `eager`; `AgentRunnerOptions.skillLoading` overrides it). In `on-demand` the system prompt lists skill names and descriptions, and a `loadSkill` tool returns a skill body as a tool result. `createLoadSkillTool()` and `LOAD_SKILL_TOOL` are exported from `adonis-ai-kit/agents`.
- Call options on `generateText` / `streamText` (AI SDK v7 primitives): `prepareStep` (per-step control; its `model` is ignored with a warning, `AgentRunner` also drops any `instructions` or `system` it returns), `activeTools`, `providerOptions`, `repairToolCall` (passed through; the AI SDK already lists the allowed tool names in its error), `promptCache` (Anthropic `cacheControl` markers on the system prompt and on the last tool in name order, with the TTL rules validated before the call) and `jsonRecovery` (strips prose around the JSON answer with `schema`; off by default).
- `stopOnBudget({ maxTokens, maxCostUsd }, costTracker)` in `adonis-ai-kit/budget`: a `stopWhen` condition that ends the tool loop after the step that exceeds a token or cost limit.
- `extractFirstJsonValue(text)` export.
- `adonis-ai-kit/testing` subpath export: `fakeModel()` (scripted answers for `generateText` and `streamText`, recorded calls, assertions on prompts, offered tools and provider options), `fakeTools()` (recorded tool executions), `fakeApiError()`, `fakeProvider()`, `fakeLanguageModels()` and `fakeResolver()`. The fakes replace the model, so fallback, the circuit breaker, guards and cost tracking run as in production.
- MCP servers as tools (`adonis-ai-kit/mcp`, `ai.mcp.registerTools(ai.getToolRegistry())`): stdio and remote HTTP/SSE servers through `@ai-sdk/mcp` (new optional peer dependency `^2.0.0`; without it, `E_AI_MISSING_DEPENDENCY`). Tools are registered in `ToolRegistry` without a permission, so they are denied until the agent matrix, the per-call permissions or `toolPermissions` allow them. Names are `mcp__<server>__<tool>` (a name over 64 characters is refused, not cut). `servers.<key>.tools`, `describe`, `pins` (from `ai.mcp.fingerprint()`) and `requirePins` filter and pin the tools. `AiManager` and `AgentRunner` deny an MCP tool that has no permission, even when it is passed directly. Resources, prompts, elicitation, sampling and OAuth are not supported.
  - Server text is untrusted. The description is prefixed with the server, capped at 1024 characters and loses control characters and every default-ignorable code point, every format character (Unicode category `Cf`) and every noncharacter. That covers bidi and zero-width marks and controls, every variation selector (VS1–VS256), the Hangul fillers and the tag characters. The price is some visible text: for example the zero-width joiner and non-joiner (some emoji sequences and Persian text lose a character), the emoji presentation selectors VS15 and VS16, the Mongolian free variation selectors and vowel separator (U+180E), the combining grapheme joiner (U+034F), the Syriac abbreviation mark (U+070F), Arabic number signs, pound and piastre marks (U+0890–0891) and end-of-ayah marks, Khmer inherent vowels, the shorthand format controls (U+1BCA0–1BCA3), and some Egyptian, Kaithi and musical format controls; the interlinear annotation marks (U+FFF9–FFFB) and the invisible math operators (U+2061–2064) go too. Not removed: private-use characters, the Braille blank (U+2800), the Khitan filler (U+16FE4) and lone surrogates. C0 and C1 controls, tabs, line breaks and U+2028/U+2029 are cleaned only in descriptions (controls removed, the others turned into spaces); outside descriptions (property names and other schema text) they are kept.
  - Input schema: a `description` is cleaned and capped the same way where it is a schema keyword (a property schema, `items`, `anyOf` and so on), not inside data keywords (`default`, `enum`, `const`, `examples`, `x-…`). All other text (`title`, `enum`, `const`, `default`, `examples`, `pattern`, `$comment`, property names, other strings and keys) is only checked for invisible characters: C0 and C1 controls, tabs, line breaks and U+2028/U+2029 are kept there, and the text is not length-capped. An invisible character anywhere outside descriptions (a title, enum value, pattern, default, key or property name) refuses the tool: it is not registered (warning), and there is no override, since the `describe` option replaces only the tool description. A tool is also not registered when a value in its schema is inside more than 64 nested JSON levels (each object or array is one level; a nested property takes two, so about 30 nested properties), or when a `description` in a schema is not a string. The walk follows the schema structure, so a property may be named `description` (also with a boolean schema), and `default`, `const`, `enum` and `examples` may hold a `description` key.
  - A tool refused in one of these ways does not stop the others. If a tool fails to register for another reason, the tools before it stay registered, the rest of that server's tools are not registered, and the servers after it are not affected. A server that fails to connect or list is skipped with a warning.
  - Connections: two `registerTools` calls at once share one connection (one child process). A server that stops answering `listTools` is closed by the next `registerTools()`, which warns; the call after that connects it again and registers its tools on the new connection. The same holds after `close()`, in the same registry. A pinned tool whose definition changed is not registered; if it was registered before, on the same connection or before a reconnect, its registration is replaced by one with the same name that refuses every call (`PolicyViolationError`: changed since it was pinned), so the changed tool never runs. It is refused until the server offers the pinned definition again or the pin is updated (a new `McpTools` with the new pin needs a new registry). If after a reconnect a new definition is refused for another reason (a schema that cannot be cleaned), the earlier registration stays and the warning says so; it is still bound to the closed connection, so its calls fail. There is no way to unregister a tool, and no automatic reconnect after a failed call. `ai.shutdown()` closes the clients. One `McpTools` instance serves one `ToolRegistry`: it remembers what it registered, so a second registry used with the same instance is not populated.
- `LanguageModelSource` interface: `AiConfig.languageModels` accepts any object with `create(model)` and `shutdown()`. `LanguageModelFactory` already satisfies it.

### Fixed

Only defects that were in v1.2.1 are listed here.

- A streaming tool (`async function*`) did not run when a `toolGuard` or an `ask` permission wrapped it: `ToolRegistry.wrapTool` returned the generator object, and the model got that. It runs now, once, and the model gets its last chunk. On these paths the intermediate chunks are not shown; a streaming tool without a wrapper still streams them. Only a stream the tool returns directly is drained: a tool declared `async` that returns an object which happens to be an async iterable (a database cursor, for example) gives the model that object, with or without a wrapper, as the AI SDK does.
- Skills: a skill file that is a symlink to a file outside the skills directory is not loaded. The file is read from the resolved path that was checked, which narrows the race between the check and the read; it does not close it, since a file replaced by a link after the check is still followed. A path that cannot be resolved is logged with its error. A skills or agent configs directory at a drive or filesystem root is searched too; it was refused before.

## [1.2.1] - 2026-10-29

### Added

- Built-in pricing for `gpt-6-sol`, `gpt-6-astra`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `gemini-3.5-flash`, `gemini-3.5-flash-lite` and `gpt-oss-120b`, including OpenAI cache-write prices.
- The built-in fallback catalog (used when models.dev cannot be reached) lists `gpt-6-sol`, `claude-sonnet-5-5`, `gemini-3.5-flash` and `openai/gpt-oss-120b`.

### Changed

- The built-in SDK drivers' default model (used when the provider config sets no `defaultModel`) moved off retired IDs: OpenAI `gpt-4o` -> `gpt-6-sol`, Anthropic `claude-3-7-sonnet-latest` -> `claude-sonnet-5-5`, Google/Gemini `gemini-2.5-flash` -> `gemini-3.5-flash`, Groq `llama-3.3-70b-versatile` -> `openai/gpt-oss-120b`. Set `defaultModel` in the provider config to pin a model.
- Model prices come from models.dev at runtime (`catalog.autoPricing`, on by default) and take priority over the built-in pricing table. The table and the fallback catalog are checked against models.dev (snapshot 2026-10-29) and used when models.dev has no price. A model priced nowhere costs $0 with a one-time warning; set its price with `CostTracker.setPricing()`.
- Internal structure split into smaller functions, with no behavior change.

### Fixed

- A provider with no `defaultModel` got the literal model name `"default"` on the main call path, so the request did not use the driver's default model. The driver's default is now used, and cost tracking, the circuit breaker key and the reported `model` use its name.

## [1.2.0] - 2026-10-22

Includes the work previously staged as the 1.3.0 and 1.4.0 candidates, which were never published.

### Added

- `adonis-ai-kit/models` subpath export:
  - Types and helpers: `ResolvedModel`, `parseModelRef`, `modelKeyFor`, `breakerKeyFor`, `PROTOCOL_TO_NPM`, `resolveProviderNpm`.
  - `ProviderFactory`, `BUILTIN_PROVIDER_EXPORTS` and `ProviderFactoryRegistry` (lazy import of known AI SDK provider packages, plus `register()` for custom ones).
  - `LanguageModelFactory`: 180 s fetch timeout, secret-header redaction in logs, ACP models through `AcpDriver`, and `shutdown()`.
  - `ModelResolver` and `CatalogModelResolver`.
  - `buildChainCandidates`, `runModelChain` and `FallbackEvent` for running a call over an ordered model chain with per-credential circuit breakers.
- `AcpDriverDeps.runtime`: a prebuilt runtime config for the ACP driver.
- `AiManager` call options:
  - `schema` (structured `output` on `generateText` and `streamText`), `stopWhen`, `maxRetries`, `onStepFinish`.
  - `models` and `onFallback` to run a call over a dynamic model chain.
- `AiConfig.resolver` and `AiConfig.languageModels`.
- Optional `peerDependencies` for the AI SDK provider packages.
- `LanguageModelFactory` options `acp.inheritEnv` (pass the full server environment to agents) and `acp.shareDriver` (set to `false` to give every model its own driver and agent process).
- Single `Logger` type shared by all modules (`LoggerContract` stays as a deprecated alias).
- `ErrorClassification.errorClass` and `ErrorClassification.countsAsFailure`, plus the `countsAsBreakerFailure()` helper.
- `CircuitBreaker.acquire()` returning a `BreakerPermit`, and `CircuitBreaker.resetAll()`.
- `ToolAccessOptions.permissions` for per-call tool permissions.
- ACP: `AcpAgentConfig.credentialEnv` and `buildAcpRuntimeConfig(agentId, options)` with `projectMcpPath` (the positional form keeps working).
- Error taxonomy exported from the package root: `ErrorClass` (11 classes), `classifyErrorClass()`, `isRetryableError()` and `getUserFriendlyMessage()`.
- Replaceable ACP agent registry: `registerAcpAgent()`, `setAcpAgents()` and `resetAcpAgents()`, so an application can point an agent at the binary installed on the machine.
- Catalog option `injectSystemProviders` (default `true`) to turn off the automatic injection of openai/anthropic/google; superseded within this release by `systemProviders` and kept as a deprecated alias.
- Catalog: `systemProviders: { fallback, acp }` option (also available as `CatalogConfig.systemProviders`) to inject fallback and ACP providers independently.

### Changed

- Optional provider peer dependencies accept any version.
- Behavior changes to be aware of:
  - `prompt_too_long` and `no_output_generated` errors now fall back to the next provider but never open the circuit breaker.
  - Errors recognised only through `isRetryable === true` fall back, but no longer count against the circuit breaker.
  - `ErrorClassification` gained two required fields (`errorClass`, `countsAsFailure`). This only affects code that constructs the interface itself.
  - `dist/` is no longer tracked in git (it is still built and shipped in the npm package).

### Deprecated

- `injectSystemProviders` (added earlier in this release, then superseded by `systemProviders`) — use `systemProviders`.
- The `sourcecraft` and `freebuff` default ACP agents — they will be removed from the defaults in 2.0; register them with `registerAcpAgent()`.
- `LoggerContract` — use `Logger`.

### Fixed

- `ToolDefinition.description` accepts the AI SDK v7 tool description type (string or function); the confirmation action falls back to the tool name.
- One error taxonomy now drives both fallback and circuit-breaker decisions.
- HTTP status codes are found in `status`, `response.status`, nested `cause` and `lastError` (AI SDK `RetryError`).
- HTTP 409 and 425 are classified as `overloaded`.
- ACP agents registered with `setAcpAgents()`/`registerAcpAgent()` without `credentialEnv` inherit the built-in agent's credentials for the same id; `credentialEnv: []` opts out.
- `CircuitBreaker.execute()` frees its probe slot even if `isFailure` throws.
- Model chains fall through to the next candidate on missing provider packages, config errors and open breakers (without counting against the breaker), and reject a missing resolver up front.
- Rejections of an async `onFallback` handler are caught and logged.
- ACP models in `AiManager` chains use its `ConfirmationService`.
- `AcpDriver` blanks `process.env` keys that are missing from a custom env source.
- `LanguageModelFactory` with `acp.shareDriver: false` no longer retains a driver per call: the driver is released when its call ends.

### Notes

- An exhausted `models` chain rethrows the last error (or `ProviderUnavailableError` if no candidate could be attempted), unlike the provider cascade, which throws `CascadingFallbackError`.

### Development

- Japa test harness.

## [1.1.0]

Initial public release.
