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

1. **Ошибки tools возвращаются модели — стандарт и в laravel/ai, и у нас.** Коммит `073cd73f` «Let agents recover from
   tool failures (#1191)»: «Recover from tool failures by default instead of behind an attribute».
   Наш `error_classifier` распознаёт `AI_NoSuchToolError` и `AI_InvalidToolInputError`
   (`adonis:src/error_classifier.ts:44-45`), но сам возврат ошибки модели делает AI SDK (`tool-error`-part),
   так что разрыва здесь нет (аудит optimus-grid, см. ниже). Остаётся только repair со списком имён (B2).
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

### B2. Repair неизвестного tool со списком допустимых имён — P3 (сужено после аудита)

- **У них:** стандарт возврата ошибок tools модели — `073cd73f` (#1191). Отдельно `#[RepairToolCalls]`
  (`laravel:src/Attributes/RepairToolCalls.php`, `laravel:src/Gateway/TextGenerationLoop.php:580,603`):
  неизвестный tool возвращается модели со списком допустимых имён и даёт дополнительный шаг.
- **У нас:** возврат ошибок модели уже работает. `ai@7.0.148` (kit) и `ai@7.0.137` (optimus) при неизвестном tool
  и невалидном input вызывают `parseToolCall` (`node_modules/ai/dist/index.js:4138-4154`), который отдаёт
  `tool-error`-part; он попадает в сообщения модели (`generateText` ~5780-5788, `streamText` ~8420,
  `toResponseMessages` ~4966). Отсутствует только repair со списком допустимых имён: опция `repairToolCall`
  (`index.d.ts:3842, 5379`) вызывается только на `NoSuchToolError`/`InvalidToolInputError` (`index.js:4100`).
  Ссылки на `index.js:2856/2880` в первой версии неверны (это ошибки tools, выполненные провайдером).
- **Почему полезно:** модель сама исправляет вызов. Но выигрыш меньше, чем считалось в первой версии спеки.
- **Реализация:** опция `repairToolCall` в `generateText`/`streamText` (имя проверить через context7, аудит
  подтверждает, что в текущей документации AI SDK она без префикса `experimental_`).
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
  или мокают внутренности. В `optimus-grid` есть ad hoc DI-сиды (`app/services/llm/llm_model_tester.ts:44-60`,
  `tests/unit/llm/fallback_llm_service.spec.ts`), переиспользуемого fake в kit нет (аудит).
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
- **Реализация:** проектировать от `toolApproval` и `experimental_toolApprovalSecret` из `ai` 7
  (`index.d.ts:3826`), а не с нуля. Персистентность pending-действия и состояния run'а — отдельная задача. Требует B8.
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

### B10. Failover с классами ошибок и событиями — уже есть, снято с плана (после аудита)

- **У них:** типизированный маркер `FailoverableException` и события `ProviderFailedOver`/`AgentFailedOver`.
- **У нас:** уже есть. `adonis:src/ai_manager.ts:639` (`onFallback`), `adonis:src/models/model_chain.ts:88, 151`,
  `adonis:src/error_classifier.ts` (`errorClass`, `countsAsFailure`), breaker по `provider:model` в
  `adonis:src/circuit_breaker.ts`. `optimus-grid` потребляет событие: `app/services/llm/fallback_llm_service.ts:16-22`
  (`FallbackEvent`), `app/agents/orchestration/phases/agent_runner.ts:154-173`.
- **Что осталось:** типизированный маркер для пользователей библиотеки — только если понадобится. Для наблюдаемости ничего не нужно.
- **Сначала:** проверить их non-stream failover на повтор tools (см. «Открытые вопросы»). Это по-прежнему
  не проверено, поэтому в README нельзя писать «у них повторяются side-effects».

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

## Аудит optimus-grid (2026-10-29)

`optimus-grid` зависит от `adonis-ai-kit ^1.2.1` из npm (`optimus-grid/package.json:112`), собственных копий ядра
нет. Его `app/services/llm/*`, `app/agents/orchestration/{budget,cost,confirmation}*.ts` и
`app/agents/tools/registry.ts` — адаптеры над kit. Значит, перенос в kit позволяет удалить код из optimus.

Статусы B1–B10 в optimus-grid: B1, B5, B6, B8, B9 — отсутствуют. B2 и B4 — частично. B3 — только учёт
cache-read, маркеров нет. B7 — HITL есть, но только в памяти (`execution_phase.ts:136-148`, таймаут 300_000).
B10 — реализован (см. выше).

Кандидаты на перенос в kit, по приоритету:

1. **Восстановление JSON из `NoObjectGeneratedError`.** `optimus-grid/app/utils/llm_response_parser.ts` (38 строк),
   вызов в `app/agents/orchestration/phases/agent_runner.ts:269-301`. В kit нет. **Не переносить как есть**
   (см. вторую проверку): парсер ломается на скобках внутри строк, не принимает массивы верхнего уровня и
   записывает 0 токенов. Переписать через `extractJsonMiddleware` из `ai` 7 (`index.d.ts:9575`).
2. **Тестовые fakes.** Основа для B4: инъекция `generateText` из `app/services/llm/llm_model_tester.ts:44-60`.
   Цена: низкая–средняя.
3. **Тестер моделей и лимитер.** `app/services/llm/llm_model_tester.ts` (146 строк),
   `app/services/llm/llm_model_test_rate_limiter.ts` (74). Перекрытие с `commands/ai_test.ts` в kit не проверено.
   Цена: средняя.
4. **Token bucket.** Ядро `app/services/bybit_rate_limiter.ts` (206 строк), переносить только общее ядро без
   категорий Bybit. Цена: низкая.
5. **Shared data bus для агентов.** `app/agents/orchestration/shared_data_bus.ts` (50 строк), метод
   `toContextString`. Цена: низкая.
6. **Хуки жизненного цикла агентов.** `app/agents/orchestration/hooks_engine.ts` (210 строк). Исполняет shell-команды,
   переносить только после ревью безопасности. Цена: средняя.
7. ~~Дубликат обёртки tools в optimus~~ — снято. Удалить `wrapToolsForExecution` в optimus нельзя без миграции
   на `AiManager`, которого там нет (см. вторую проверку).
8. **Hot-reload конфигов агентов.** `providers/runtime_services_provider.ts:300-312`. Слабая ценность.

Не относится к библиотеке: доменная часть трейдинга (`app/agents/tools/bybit_tools.ts`, `regime_detector.ts`,
`app/services/grid*`, `campaign`, `experiment`, `autopsy`, `system_one`), логгер транскриптов, mutex по группам
провайдеров (`app/utils/provider_group_lock.ts`).

Не проверено: поведение `ai` без `repairToolCall` в стриминге; перекрытие `llm_model_tester` с `commands/ai_test.ts`;
зависит ли kit от `jsonschema`. Сверка исходников по байтам невозможна: в `.js.map` нет `sourcesContent`.

## Вторая проверка (Opus, 2026-10-29)

Независимая перепроверка выводов. Большинство подтвердилось. Ниже — что изменилось.

**Главное: `optimus-grid` не использует `AiManager`.** `app/services/llm/llm_service_impl.ts:1` импортирует
`generateText`/`streamText` из `ai` напрямую; `AiManager` в `app/`, `start/`, `providers/` не найден. Значит:
- B1 и B3, реализованные в kit, до optimus сами по себе не дойдут. Нужна либо миграция optimus на `AiManager`,
  либо правка `llm_service_impl.ts`.
- «Копий ядра нет» верно только для breaker, classifier, budget, guard и catalog. Генерация у optimus своя.

**Безопасность fallback (B10 и README) — не доказана полностью.**
- `model_chain.ts:198` проверяет `!toolsExecuted`. Но `markToolsExecuted` срабатывает только для локальных
  tools с `execute` (`ai_manager.ts:671-681`). Tools, которые выполняет провайдер, не отмечаются.
- В optimus это закрыто второй проверкой по `step.toolCalls` в `onStepFinish` (`fallback_llm_service.ts:104-107`).
  В kit такой проверки нет.
- ACP-драйверы могут стоять в `fallbackCascade`. ACP выполняет свои tools сам, и отметки `toolsExecuted` там не
  найдено. Это вероятный путь повтора side-effects (полный путь ACP не трассировался).
- Вывод: до закрытия этих путей в README нельзя писать «never replays side-effects» без оговорок.

**«Fail-closed» верен только для реестра.** `AiManager.prepareTools` по умолчанию ставит `'allow'`
(`ai_manager.ts:226-227`, по данным проверки). Значит, B9 (MCP) должен идти только через `ToolRegistry`.

**В `ai@7` уже есть примитивы, которые спека не учла:**
- `prepareStep` и `activeTools` — закрывают B1.
- `extractJsonMiddleware({ transform })` (`index.d.ts:9575`) — заменяет самописный парсер JSON; `transform` позволяет
  подставить свой экстрактор.
- `toolApproval` и `experimental_toolApprovalSecret` (`index.d.ts:3826`) — основа для B7, проектировать от них.
- `onToolExecutionStart` — может заменить `trackExecution`.
- `pruneMessages` и `toolSearch` — относятся к B5 и B8.

**Изъяны парсера JSON в optimus:** скобки внутри строк ломают подсчёт глубины; массивы верхнего уровня не
поддерживаются; после первой ошибки `JSON.parse` дальше не ищет; восстановление пишет 0 токенов, хотя
`NoObjectGeneratedError` содержит `usage` (`index.js:188`).

**Пересмотр кандидатов:**
- Token bucket — лимитер для Bybit API, к AI-ядру не относится. Снять.
- Тестер моделей — переносить только очистку ошибок и программный `testModel` без fallback.
- Shared data bus и hooks engine — отложить.
- Пункт про удаление обёртки в optimus — снят (см. выше).

## Порядок работ

1. **Фаза 1 (дёшево, опираясь на примитивы `ai` 7):** B1 через `prepareStep`/`activeTools`, B3 через
   `providerOptions`, B4 (fakes с DI), JSON-восстановление через `extractJsonMiddleware`, исправление README.
   Учесть, что B1 и B3 не дойдут до optimus без миграции на `AiManager` или правки `llm_service_impl.ts`.
   B2 — только если останется время (P3).
2. **Фаза 1a (до любых заявлений о безопасности):** закрыть повтор side-effects — проверка по `step.toolCalls`
   в kit и путь ACP.
3. **Фаза 2:** B5, B6, очистка ошибок из тестера моделей.
4. **Фаза 3:** B8 (хранилище диалогов), затем B7 (resumable approvals) — в одном плане, от `toolApproval` из `ai` 7.
5. **Фаза 4:** B9 (MCP через `ToolRegistry`, не через `AiManager.prepareTools` с его `'allow'` по умолчанию).

## Открытые вопросы

- Повторяются ли выполненные tools при failover в non-stream run'е у laravel/ai? Нужно прочитать
  `laravel:src/Promptable.php` (`withModelFailover`, ~стр. 419) и тесты в `laravel:tests`.
- Имена API Vercel AI SDK v7: `prepareStep`, `experimental_repairToolCall`, `cacheControl` — через context7.
- Нужен ли RAG (embeddings, `SimilaritySearch`-аналог) в scope библиотеки? Если нет — пункт не входит в план.
- Можно ли сделать `ToolSearch`-подобную отложенную загрузку tools (BM25) — нужна ли при текущем числе tools?
