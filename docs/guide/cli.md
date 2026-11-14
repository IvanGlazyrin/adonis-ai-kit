# Ace CLI Commands

`adonis-ai-kit` provides first-party commands for the AdonisJS **Ace CLI**.

The commands must be registered in `adonisrc.ts` (`commands: [() => import('adonis-ai-kit/commands')]`). `node ace add adonis-ai-kit` does it for you; see [Installation](./installation.md) for the manual setup.

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

Scaffold a typed wrapper class around the `ai` service in `app/ai/agents/`. It is plain TypeScript, not an agent manifest: it does not load a Markdown agent and `ai.agent()` does not read it.

```bash
node ace make:ai-agent CodeReviewer --provider=anthropic --model=claude-sonnet-5-5 --max-tokens=4096
```

This creates `app/ai/agents/code_reviewer_agent.ts` with a `CodeReviewerAgent` class (agent name `codereviewer-agent`), a system prompt, and `run()` / `stream()` methods that call `ai.generateText()` / `ai.streamText()` with the provider, model and `maxOutputTokens` (default 2048). The file default-exports an instance. An existing file is not overwritten.

The file is generated from a stub, so you can override it with your own `stubs/make/agent.stub` in the app.

The input is checked before anything is written, because it ends up in generated code. The command fails with exit code 1 when:

- the name is not letters and digits starting with a letter (`/^[A-Za-z][A-Za-z0-9]*$/`), so `../x` or `a/b` is rejected;
- `--provider` or `--model` contains anything other than letters, digits and `_ . / : @ -`;
- `--max-tokens` is not a positive integer.

Agents loaded with `ai.agent()` are Markdown manifests, not classes. To create one, write the manifest by hand (see [Agents & Manifests](/guide/agents)).
