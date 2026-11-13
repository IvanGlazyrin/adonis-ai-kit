# Agents & Manifests

## Defining Agents

`adonis-ai-kit` provides two ways to declare agents:
1. **File-based Markdown manifests** with YAML frontmatter, loaded with `ai.agent(name)`.
2. **Scaffolded agent classes** generated with Ace.

---

## Markdown Agent Manifests

`ai.agent(name)` loads `resources/agent-configs/<name>.md` (`agentConfigsDir`) and returns an `AgentRunner`. The body is the agent's system prompt:

```markdown
<!-- resources/agent-configs/security-auditor.md -->
---
id: security-auditor
description: Reviews pull requests for security vulnerabilities
provider: anthropic
model: claude-sonnet-5-5
stop_steps: 8
skills:
  - owasp-top-10
  - jwt-security
skillLoading: on-demand
permissions:
  scan_repository: allow
  audit_dependencies: allow
  open_issue: ask
---

You are a senior security researcher reviewing pull requests.
Audit every change against the OWASP Top 10 guidelines and flag potential SSRF or SQL injection vulnerabilities.
```

Frontmatter fields: `id` (defaults to the file name), `description`, `mode` (`primary` or `subagent`, default `subagent`), `provider`, `model`, `temperature`, `maxTokens`, `stop_steps` (default 5), `skills`, `skillLoading` (`eager` or `on-demand`, default `eager`), `permissions` (tool name → `allow` / `ask` / `deny`), `outputSchema`, `phases` and `metadata`.

- `outputSchema` is the **name** of a Zod schema. The app resolves it once with `ai.getAgentLoader().setSchemaResolver((name) => schemas.get(name))`, where `schemas` is a `SchemaRegistry` from `adonis-ai-kit/guard`. Without a resolver the name is ignored, and `runStructured()` then throws because there is no schema.
- `phases` and `metadata` are passed through to the loaded agent's config. The kit does not act on them.

Tools are passed to the runner; the manifest's `permissions` filter them:

```ts
import ai from 'adonis-ai-kit/services/main'

const auditor = await ai.agent('security-auditor', {
  tools: { scan_repository, audit_dependencies, open_issue },
  defaultToolPermission: 'deny', // tools the manifest does not list are dropped
})

const result = await auditor.run('Audit pull request #3491')
console.log(result.text)
```

- A tool the manifest does not mention gets `defaultToolPermission`, which defaults to `allow` (the manifest then acts as a deny/ask list). An MCP tool without an entry is always `deny`.
- `run(prompt | options)`, `runStream()` / `stream()` and `runStructured(schema, prompt)` are available. A caller cannot re-introduce a denied tool or replace the agent's prompt.

---

## Scaffolded Agent Classes

Generate an agent class with the Ace CLI:

```bash
node ace make:ai-agent SupportBot --provider=openai --model=gpt-6-sol
```

This creates `app/ai/agents/support_bot_agent.ts`: a `SupportBotAgent` class with a system prompt and `run()` / `stream()` methods that call `ai.generateText()` / `ai.streamText()`. The file default-exports an instance:

```ts
// app/controllers/support_controller.ts
import supportBot from '../ai/agents/support_bot_agent.js'

const result = await supportBot.run({ prompt: 'Can you check order #3491?' })
console.log(result.text)
```

---

## Skills & Progressive Disclosure (On-Demand)

Skills are instructional Markdown documents stored in `resources/agent-skills/` (`agentSkillsDir`, e.g. `jwt-security.md`). A skill may start with frontmatter whose `description` the model sees; without it the first `# heading` is used, then the file name.

### Eager vs. On-Demand Loading

- **Eager Loading (Default):** The bodies of all listed skills are added to the system prompt.
- **On-Demand Loading (`skillLoading: on-demand`):** Only skill names and descriptions are in the system prompt. The model calls the built-in `loadSkill` tool when it needs a skill, and the body comes back as a tool result.

```markdown
---
skillLoading: on-demand
skills:
  - gdpr-compliance
  - pci-dss-rules
---
```

- Each `loadSkill` call uses one step of the tool loop, so raise `stop_steps` if a run needs several skills.
- `loadSkill` is reserved: a caller tool with that name is refused, and a manifest `deny` or `ask` for it is a config error.
- A skill over 256 KB, or a symlink to a file outside the skills directory, is not loaded.

> [!TIP]
> On-demand skills keep the base prompt small for agents with many or large skills. A few short skills are simpler as `eager`.

---

## Sub-Agents

Turn an agent into a callable tool of another agent with `agentAsTool`:

```ts
import { stepCountIs } from 'ai'
import ai from 'adonis-ai-kit/services/main'
import { agentAsTool, SubAgentSpend } from 'adonis-ai-kit/agents'
import { stopOnBudget } from 'adonis-ai-kit/budget'

const spend = new SubAgentSpend()
const researcher = await ai.agent('market-researcher')

const lead = await ai.agent('strategy-lead', {
  tools: {
    delegateResearch: agentAsTool(researcher, { maxDepth: 1, spend }),
  },
})

const result = await lead.run({
  prompt: 'Analyze EU fintech market expansion',
  stopWhen: [stepCountIs(8), stopOnBudget({ maxCostUsd: 1 }, ai.getCostTracker(), { extra: spend })],
})
```

### Sub-Agent Isolation Rules

1. **Task Only:** Only the task string is forwarded. The parent's chat history is never sent to the sub-agent (the parent model can still copy text from its history into the task).
2. **Forced Deny-by-Default:** The sub-agent's tools are only those its manifest allows; every other tool is denied (`defaultToolPermission: 'deny'` is forced). Tool guards are not inherited; pass one with `agentAsTool(runner, { toolGuard })`.
3. **No Unsupervised Approvals:** A manifest with an `ask` tool is refused when the sub-agent tool is created, and an `ask` tool reached at run time fails the parent's tool call with `E_AI_SUBAGENT_APPROVAL_REQUIRED`.
4. **Failures:** A failed sub-agent returns a tool error (`E_AI_SUBAGENT_FAILED`) to the parent, which goes on. An ACP call failure stops the parent run with `AcpCallFailedError`.
5. **Budget Accounting:** `SubAgentSpend` collects the sub-agent's tokens and cost; they count toward the parent's budget when passed as `extra` to `stopOnBudget`.
6. **Nesting:** One level by default (`maxDepth: 1`). A `primary` agent cannot be a sub-agent.
