# Human Tool Approval (Human-in-the-Loop)

Human-in-the-loop (HITL) safeguards allow humans to review sensitive actions (such as money transfers, database drops, or sending emails) before they happen.

---

## In-Process Approvals (`ConfirmationService`)

By default (`approvals: 'blocking'`), an `ask` tool waits in memory for the manager's `ConfirmationService`:

```ts
import ai from 'adonis-ai-kit/services/main'

const confirmations = ai.getConfirmationService()

// Listen for approval requests
confirmations.onActionCreated((action) => {
  console.log(`Approval required for tool: ${action.toolName}`)
  console.log('Arguments:', action.params)
})

// In your admin UI / Slack bot:
confirmations.approve(actionId)
// or
confirmations.reject(actionId, 'Permission denied by admin')
```

The wait times out after `defaultTimeoutMs` (default 60 seconds; per call `toolGuard.timeoutMs`). A timeout, an abort or a shutdown never approves: the call is rejected fail-closed. `getPendingActions()` lists what is waiting. A restart loses the waits.

---

## Resumable Approvals (Survives Process Restarts)

When approvals require hours or days of human review, keeping Node.js processes waiting in memory is brittle.

With `approvals: 'resumable'` the run stops at the `ask` tool and its state is stored in the conversation. The AI SDK signs each approval request with an HMAC secret:

```ts
// config/ai.ts
import env from '#start/env'
import { defineConfig, approvalSecret } from 'adonis-ai-kit'

export default defineConfig({
  // ...providers, conversations: { store: new LucidConversationStore() }
  approvals: {
    secret: approvalSecret(env.get('AI_APPROVAL_SECRET')), // >= 32 bytes
    ttlMs: 24 * 60 * 60 * 1000, // 24 hours (default)
  },
})
```

`resumable` needs a conversation, `approvals.secret`, and a durable conversation store (`store.durable === true`); the in-memory store is refused unless `approvals.allowVolatileStore: true` (tests and development). `approvals.mode: 'resumable'` makes it the default.

### Triggering an Approval

```ts
const run = await ai.generateText({
  prompt: 'Purge user record #4912',
  tools,
  toolPermissions: { purge_user: 'ask' },
  approvals: 'resumable',
  conversation: { id: conversation.id, owner: 'admin:1' },
})

console.log(run.status) // 'awaiting-approval'
console.log(run.pendingApprovals)
// [
//   {
//     approvalId: '...',
//     toolCallId: '...',
//     toolName: 'purge_user',
//     input: { userId: 4912 },
//     expiresAt: Date // 2026-11-04T12:00:00.000Z
//   }
// ]
```

`ai.conversations.pendingApprovals(id, owner)` returns the same list later. For registry tools, use `registry.getToolsWithApprovals(agentName)` and pass both `tools` and `toolPermissions`: without the permissions, a non-MCP tool is read as `allow` and runs with no approval.

---

## Resolving Approvals

Even after a server reboot or days later on a different container node, resume execution with `ai.conversations.resolveApprovals()`. Every approval of the paused step needs a decision in this one call:

```ts
const settled = await ai.conversations.resolveApprovals(
  conversation.id,
  'admin:1',
  [
    {
      approvalId: run.pendingApprovals[0].approvalId,
      approved: true, // or false to deny
      reason: 'Approved in ticket SEC-88', // optional
    },
  ],
  {
    tools,
    toolPermissions: { purge_user: 'ask' },
  }
)

console.log(settled.text) // "User record #4912 has been purged."
```

`ai.conversations.resume(id, owner, options)` continues a step whose approvals were all decided earlier (for example after a failed model call).

### Security Guarantees

1. **HMAC Signing:** A changed tool input or a missing signature throws `ApprovalSignatureError` (`E_AI_APPROVAL_INVALID`) and the step is closed with a denial. An unknown or forged `approvalId` throws `ApprovalNotFoundError`; a missing decision throws `ApprovalIncompleteError`.
2. **At-Most-Once Execution:** The decision and an "executing" mark are stored before the tool runs. An approved tool that already ran is never run again; one that was executing when the process stopped is reported to the model as "outcome unknown after restart".
3. **Owner & Expiry:** The owner is checked as for every conversation call. A decision after `ttlMs` is a denial (`reason: 'expired'`, listed in `expiredApprovalIds`). Concurrent decisions: one wins, the other gets `ConversationConflictError`.
4. **Replay Defense:** A replayed decision is `ApprovalNotFoundError`, and a call's own `messages` may not contain approval request/response parts (`E_AI_APPROVAL_REPLAY`), so approvals cannot be copied into another conversation.
5. **Secret Rotation:** Rotating the secret makes pending requests unverifiable, and they are refused. `approvalSecret()` redacts the value in JSON, `String()` and logs.
6. **Limits:** A provider-executed tool with `ask` is refused in `resumable` mode (`E_AI_CONFIG_ERROR`). Sub-agents cannot ask; ACP agents keep `ConfirmationService`.
