# Сравнение с laravel/ai и что заимствовать — исследование

Дата: 2026-10-29.
Источники:
- laravel/ai, ветка `1.x`, коммит `073cd73f` — локальный клон `C:\projects\laravel-ai`.
- Документация: https://laravel.com/docs/ai-sdk (прочитана частично, см. «Ограничения проверки»).
- adonis-ai-kit, `main` @ `39a2e70`.

Ссылки вида `laravel:src/...` — файлы в клоне laravel/ai. Ссылки вида `adonis:src/...` — файлы этого репозитория.

## Цель

Зафиксировать, что стоит позаимствовать из laravel/ai, в каком порядке и почему. Эта спека — вход для
будущих планов. Реализации здесь нет.

## Ограничения проверки

- Docs читались через WebFetch, текст обрезается на ~100k символов. Не прочитаны разделы Failover, Images,
  Reranking, Files, Vector Stores, Usage, Testing, Events. Для них опираюсь на исходники, а не на docs.
- Имена API Vercel AI SDK (`prepareStep`, `experimental_repairToolCall`, `providerOptions.anthropic.cacheControl`)
  не сверены с актуальной документацией. Перед реализацией проверить через context7.
- Failover в non-stream пути (повторяется ли уже выполненный tool при переходе на другого провайдера) не
  выяснен — см. «Открытые вопросы».

## Корректировки первоначальных выводов

Первая версия сравнения (в чате) была сделана по обрезанной docs. Исходники это поправили:

1. **Ошибки tools возвращаются модели — уже стандарт в laravel/ai.** Коммит `073cd73f` «Let agents recover from
   tool failures (#1191)»: «Recover from tool failures by default instead of behind an attribute».
   У нас `error_classifier` распознаёт `AI_NoSuchToolError` и `AI_InvalidToolInputError`
   (`adonis:src/error_classifier.ts:44-45`), но обратно в цикл модели ничего не передаётся. Это разрыв, а не
   «фича Laravel».
2. **Fakes есть для всех модальностей, а не только для агентов.** `laravel:src/Concerns/InteractsWithFake*.php`
   (Agents, Audio, Classification, Embeddings, Files, Images, Reranking, Stores, Transcriptions) и
   `laravel:src/Gateway/Fake*Gateway.php`.
3. **Failover у них явный и типизированный.** Маркер `laravel:src/Exceptions/FailoverableException.php`
   реализуют `RateLimitedException`, `ProviderOverloadedException`, `ProviderConnectionException`,
   `InsufficientCreditsException`. Переход на следующего провайдера — `withModelFailover` в
   `laravel:src/Promptable.php` (~стр. 419). События `AgentFailedOver`, `ProviderFailedOver`.
   В стриме failover отключается, если клиенту уже что-то отдано: `laravel:src/Promptable.php:226-229`
   и `laravel:src/Responses/StreamableAgentResponse.php:289` (`hasYielded()`).
4. **Их HTTP-клиент — Laravel HTTP client, не «cURL/Guzzle-обёртки».** В docs результат — `Illuminate\Http\Client\Response`
   (`$response->raw`). Утверждение в нашем `README.md:14-28` неточно — см. «Исправление README».
5. **Наш README-тезис «безопасный fallback» не проверен против их failover.** Я не знаю, повторяют ли они
   выполненные tools при переходе на другого провайдера в non-stream пути. Пока это не доказано, в README
   нельзя писать «у них повторяются side-effects».

## Решения (приоритет и фаза)

Нумерация B1–B10 (borrow), чтобы не путать с D-решениями в `docs/superpowers/specs/`.

### B1. Хук на каждый шаг (аналог `prepareStep`) — P1

- **У них:** `laravel:src/PendingStep.php`, middleware `laravel:src/Middleware/Stop.php`. На шаге
  можно `withoutTools`, `withModel`, `withInstructions`, `withMaxTokens`; остановка по условию
  (`Stop::unless(fn ($step) => $step->usage->inputTokens < 50_000)`) — из docs «Middleware».
- **У нас:** `onStepFinish` (`adonis:src/ai_manager.ts:715-720`) только уведомляет. Следующий шаг
  изменить нельзя.
- **Почему лучше:** можно отключить опасные tools после первого шага, дешёвую модель использовать для
  маршрутизации и дорогую — для финального ответа, и останавливать tool-loop по бюджету внутри run'а,
  а не только между вызовами.
- **Реализация:** опереться на `prepareStep` в Vercel AI SDK (имя проверить через context7).
- **Цена:** низкая.

### B2. Ошибки tools возвращаются модели — P1

- **У них:** стандарт по умолчанию, `073cd73f` (#1191). Отдельно `#[RepairToolCalls]`
  (`laravel:src/Attributes/RepairToolCalls.php`, `laravel:src/Gateway/TextGenerationLoop.php:580,603`):
  неизвестный tool возвращается модели со списком допустимых имён и даёт дополнительный шаг.
- **У нас:** разрыв (см. корректировку 1).
- **Почему лучше:** модель сама исправляет вызов, не нужен отдельный запрос к пользователю.
- **Реализация:** перехватить `NoSuchToolError` / `InvalidToolInputError` внутри tool-loop и вернуть их
  как tool-result с ошибкой. Для `RepairToolCalls`-поведения проверить `experimental_repairToolCall`.
- **Цена:** низкая.

### B3. Маркеры кэша промптов с TTL — P1

- **У них:** `laravel:src/Attributes/CacheInstructions.php`, `CacheToolDefinitions`; реализация в
  `laravel:src/Gateway/Anthropic/Concerns/BuildsTextRequests.php`. Смешивать разные TTL нельзя
  (исключение из docs «Provider Options, Headers, and Caching»).
- **У нас:** `cacheReadTokens` считается и показывается (`README.md:131`), но cache-маркеры не ставятся
  (в `adonis:src` нет `cacheControl`).
- **Почему лучше:** учёт и реальная экономия связываются в одну систему. Бюджет уже знает про скидку
  на cache-read, теперь она начнёт появляться.
- **Реализация:** `providerOptions.anthropic.cacheControl` на system и tools (имя проверить).
- **Цена:** низкая.

### B4. Fakes для тестов пользователей библиотеки — P1

- **У них:** `laravel:src/Concerns/InteractsWithFake*.php` для всех модальностей.
- **У нас:** для пользователя `adonis-ai-kit` нет подменяемого провайдера. Тесты приложения ходят в сеть
  или мокают внутренности.
- **Почему лучше:** это главный барьер для adoption библиотеки. Тесты приложения не должны зависеть от сети и ключей.
- **Реализация:** `ai.fake(responses)` с ассертами на вызовы и промпты. Минимальная версия — только текст и
  агенты, остальное по мере надобности.
- **Цена:** низкая–средняя.

### B5. Skills по требованию (progressive disclosure) — P2

- **У них:** `laravel:src/Tools/LoadSkill.php`, `laravel:src/Skills/Skill.php`. Модель получает список
  skills и сама вызывает `LoadSkill`, инструкции подгружаются только тогда, когда нужны.
- **У нас:** `adonis:src/agents/loader.ts:63` — `skillPrompts: Record<string, string>`, `loadSkill`
  (`:132`) читает весь файл и кладёт в промпт целиком.
- **Почему лучше:** экономия токенов растёт с числом skills. Это прямо связано с бюджетом.
- **Реализация:** tool `loadSkill(name)` в `ToolRegistry`, в системном промпте только имена и описания.
- **Цена:** низкая–средняя.

### B6. Правила для sub-agent'ов — P2

- **У них (по docs и `laravel:src/Tools/AgentTool.php`, `laravel:src/Contracts/CanActAsTool.php`):**
  sub-agent работает в изоляции без истории родителя; sub-agent не может вызывать tools, требующие
  approval.
- **У нас:** `mode: 'subagent'` есть в `adonis:src/agents/manifest.ts`, правил изоляции не найдено.
- **Почему лучше:** без изоляции sub-agent тратит токены на чужую историю, а approval-tools внутри
  sub-agent'а некуда направить.
- **Цена:** низкая.

### B7. Resumable approvals — P3 (самое ценное, самое дорогое)

- **У них:** `laravel:src/Approvals/{Approval,PendingApproval,Decision,Decisions}.php`. Approvable-tool
  по умолчанию требует подтверждения. Run сохраняется и продолжается позже. Без истории выбрасывается
  `ApprovalNotResumableException` (`laravel:src/Exceptions/ApprovalNotResumableException.php`).
- **У нас:** `adonis:src/guard/confirmation.ts:44` — `pending = new Map()` в памяти. Таймаут через
  `setTimeout` (`:114`). Если процесс перезапустился или человек ответил позже таймаута, действие теряется.
  `sessionId` (`:146`) только привязывает approve/reject.
- **Почему лучше:** HITL — главная фича guard-модуля. Сейчас она работает только для быстрых ответов в
  одном процессе.
- **Реализация:** порт персистентности для pending-действия и состояния run'а. Требует B8 (история).
- **Цена:** высокая.

### B8. Хранилище диалогов — P3

- **У них:** `laravel:src/Middleware/RememberConversation.php`, миграции `agent_conversations` и
  `agent_conversation_messages`, `ConversationStore` с `paginateConversationMessages`,
  `conversationBelongsTo`, `pendingApprovalsFor` (docs «Conversation and Memory»).
- **У нас:** истории диалогов нет. `sessionId` в `adonis:src/agents/agent_runner.ts:24` используется только
  для привязки approval (`adonis:src/ai_manager.ts:694`).
- **Урок из их кода:** `continue()` не проверяет владельца, и это задокументировано как ответственность
  вызывающего кода. Для нас владелец должен быть обязательным аргументом.
- **Реализация:** интерфейс `ConversationStore` с in-memory дефолтом и адаптером под Lucid в приложении.
- **Цена:** средняя.

### B9. MCP-tools через ToolRegistry — P3

- **У них:** `laravel:src/Tools/McpTool.php`, `laravel:src/Tools/McpServerTool.php`,
  `laravel:src/Tools/Concerns/NormalizesMcpResult.php`. По docs требует пакет `laravel/mcp`.
- **У нас:** MCP-клиента для tools нет. MCP упоминается только как передача серверов ACP-агентам
  (`adonis:src/acp/acp_agents.ts:30,40,51`).
- **Почему лучше:** описания внешних tools недоверенные. Если добавлять MCP, то только через реестр с
  fail-closed. По умолчанию `deny` (`adonis:src/guard/registry.ts`, `defaultPermission`). Здесь мы строже,
  чем opt-in модель approval у них.
- **Цена:** средняя.

### B10. Failover с явными классами ошибок — P2 (после проверки)

- **У них:** типизированный маркер `FailoverableException` и события `ProviderFailedOver`/`AgentFailedOver`.
- **У нас:** `adonis:src/error_classifier.ts` классифицирует ошибки по `errorClass` и `countsAsFailure`,
  breaker по `provider:model` в `adonis:src/circuit_breaker.ts`. Это уже сильнее, чем в явной модели.
- **Что взять:** события failover для наблюдаемости. Типизированный маркер — только если нужен для
  пользователей библиотеки.
- **Сначала:** проверить их non-stream failover на повтор tools (см. «Открытые вопросы»).

## Не заимствуем

- **Широту провайдеров.** У них драйверы написаны вручную. У нас это даёт Vercel AI SDK. Копирование —
  шаг назад.
- **PHP-билдер JSON Schema** (`laravel:src/Schema`). У нас Zod, и в TypeScript он лучше.
- **Eloquent-полиморфизм участников.** Нам нужен интерфейс и адаптер под Lucid.
- **`continue()` без проверки владельца.** Антипаттерн.
- **Broadcasting и Vercel data protocol** (`laravel:src/Vercel`, `laravel:src/Streaming`). Завязаны на
  Laravel-инфраструктуру. Аналоги в Adonis — проверить отдельно.

## Где мы уже сильнее

- **Fail-closed реестр** (`adonis:src/guard/registry.ts`, `defaultPermission: 'deny'`) против opt-in approval.
- **Circuit breaker по `provider:model`** (`adonis:src/circuit_breaker.ts`).
- **Бюджет в USD** с учётом cache-read и reasoning-токенов (`adonis:README.md`, раздел 5).

## Исправление README

`adonis:README.md:14-28` — таблица сравнения. Строки про Laravel AI надо переписать:

- «Custom cURL/Guzzle wrappers» → неточно: Laravel HTTP client (`Illuminate\Http\Client`).
- «Retries from scratch (risk of double actions)» → не проверено. Пока не доказано, убрать или переформулировать.
- «Basic parameter mapping» для tool security → неточно: есть approval-flow, middleware со `Stop`.
- «Static configuration files» для каталога → частично верно, уточнить.

Перед публикацией на npm эту таблицу проверить и переписать.

## Порядок работ

1. **Фаза 1 (дёшево, опираясь на существующий код):** B1, B2, B3, B4, исправление README.
2. **Фаза 2:** B5, B6, B10 (события failover).
3. **Фаза 3:** B8 (хранилище диалогов), затем B7 (resumable approvals) — в одном плане.
4. **Фаза 4:** B9 (MCP через реестр).

## Открытые вопросы

- Повторяются ли выполненные tools при failover в non-stream run'е у laravel/ai? Нужно прочитать
  `laravel:src/Promptable.php` (`withModelFailover`, ~стр. 419) и тесты в `laravel:tests`.
- Имена API Vercel AI SDK v7: `prepareStep`, `experimental_repairToolCall`, `cacheControl` — через context7.
- Нужен ли RAG (embeddings, `SimilaritySearch`-аналог) в scope библиотеки? Если нет — пункт не входит в план.
- Можно ли сделать `ToolSearch`-подобную отложенную загрузку tools (BM25) — нужна ли при текущем числе tools?
