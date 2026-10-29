# Changelog

All notable changes to `adonis-ai-kit` are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.2.1] - 2026-10-29

### Added

- Built-in pricing for `gpt-6-sol`, `gpt-6-astra`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `gemini-3.5-flash`, `gemini-3.5-flash-lite` and `gpt-oss-120b`.
- The built-in fallback catalog (used when models.dev cannot be reached) lists `gpt-6-sol`, `claude-sonnet-5-5`, `gemini-3.5-flash` and `openai/gpt-oss-120b`.

### Changed

- The built-in SDK drivers' default model (used when the provider config sets no `defaultModel`) moved off retired IDs: OpenAI `gpt-4o` -> `gpt-6-sol`, Anthropic `claude-3-7-sonnet-latest` -> `claude-sonnet-5-5`, Google/Gemini `gemini-2.5-flash` -> `gemini-3.5-flash`, Groq `llama-3.3-70b-versatile` -> `openai/gpt-oss-120b`. Set `defaultModel` in the provider config to pin a model.
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
