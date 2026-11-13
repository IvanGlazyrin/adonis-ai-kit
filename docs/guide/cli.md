# Ace CLI Commands

`adonis-ai-kit` provides first-party commands for the AdonisJS **Ace CLI**.

---

## `ai:test` {#ai-test}

Send a short test prompt to every provider configured in `config/ai.ts` (or one of them) and report latency, circuit breaker state and cost:

```bash
node ace ai:test
node ace ai:test --provider=anthropic --model=claude-sonnet-5-5 --prompt="Say PONG"
```

| Flag | Description |
| :--- | :--- |
| `--provider` | Test only this provider |
| `--model` | Model to test with (default: the provider's `defaultModel`) |
| `--prompt` | Test prompt (default asks for "PONG" and the model identity) |

### Output

The table has the columns `Provider`, `Model`, `Status`, `Latency`, `Circuit Breaker` and `Cost ($)`. `Status` is `✔ OK`, `⚠ FALLBACK (<provider>)` when another provider answered (not a pass for the tested one), or `✖ FAILED`. Each model's answer is logged, followed by the total session cost and tokens.

---

## `make:ai-agent` {#make-ai-agent}

Scaffold a typed agent class in `app/ai/agents/`:

```bash
node ace make:ai-agent CodeReviewer --provider=anthropic --model=claude-sonnet-5-5 --max-tokens=4096
```

This creates `app/ai/agents/code_reviewer_agent.ts` with a `CodeReviewerAgent` class (agent name `codereviewer-agent`), a system prompt, and `run()` / `stream()` methods that call `ai.generateText()` / `ai.streamText()` with the provider, model and `maxOutputTokens` (default 2048). The file default-exports an instance. An existing file is not overwritten.

For agents loaded with `ai.agent()`, write a Markdown manifest instead (see [Agents & Manifests](/guide/agents)).
