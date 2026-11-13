# MCP Servers as Tools

The **Model Context Protocol (MCP)** enables AI agents to connect to local tools and enterprise data sources. MCP tools reach the model only as `ToolRegistry` tools.

Install the optional peer dependency (v2):

```bash
npm install @ai-sdk/mcp
```

Without it, `registerTools` throws `E_AI_MISSING_DEPENDENCY`.

---

## Configuring MCP Servers

Define your local stdio child process or remote HTTP/SSE MCP servers in `config/ai.ts`:

```ts
// config/ai.ts
export default defineConfig({
  // ...providers
  mcp: {
    servers: {
      filesystem: {
        command: 'node',
        args: ['./mcp/fs_server.js'],
        env: { STORAGE_DIR: '/var/storage' },
      },
      docsApi: {
        type: 'http', // or 'sse'
        url: 'https://docs.corp.internal/mcp',
        headers: {
          Authorization: `Bearer ${env.get('DOCS_MCP_TOKEN')}`,
        },
      },
    },
    requirePins: false,
  },
})
```

Register tools with your tool registry, grant permissions, and pass both tools and permissions per call:

```ts
import ai from 'adonis-ai-kit/services/main'

const registry = ai.getToolRegistry()
await ai.mcp.registerTools(registry) // connects lazily; a failing server is skipped with a warning

// Tools are named mcp__<server>__<tool>
registry.setAgentPermissions('support-agent', {
  mcp__filesystem__read: 'allow',
  mcp__filesystem__write: 'ask', // Require confirmation
})

const { tools, toolPermissions } = registry.getToolsWithApprovals('support-agent')
await ai.generateText({ prompt, tools, toolPermissions })
```

- `servers.<key>.tools: ['read']` registers only the listed tools of a server.
- `ai.shutdown()` (or `ai.mcp.close()`) closes the clients; a later `registerTools()` reconnects. There is no automatic reconnect and no way to unregister a tool.

---

## Security Model: Deny by Default

External MCP servers must not be trusted unconditionally:
1. **Explicit Permission Required:** An MCP tool without a permission entry is `deny`, in `ToolRegistry` and in `AiManager` / `AgentRunner` when passed directly. `AiManager` reads `toolPermissions`, so a tool missing there is dropped with a warning.
2. **Deterministic Naming:** Names are `mcp__<server>__<tool>`; characters outside `[A-Za-z0-9_-]` become `_`. The server key must start with a letter or digit and be 1-32 characters of `[A-Za-z0-9_-]`. A name over 64 characters, or one already registered, is not registered (warning) and is never cut.
3. **stdio Isolation:** A stdio server runs with your process's rights; the child gets only a whitelist of the environment (for example `PATH`) plus `env`. Run such servers in a container or as a separate user. Remote servers refuse redirects.

---

## Untrusted Metadata Sanitization

Remote MCP servers might contain malicious descriptions attempting prompt injection:
- Tool descriptions are stripped of control characters and invisible or format characters (bidi controls, zero-width characters, variation selectors, tag characters, noncharacters; Unicode category `Cf`), capped at 1,024 characters and prefixed with `[MCP:<server>]`. A `description` inside the input schema is cleaned the same way.
- Other schema text (`title`, `enum`, `default`, property names, ...) is only checked: a tool with an invisible character there is not registered.
- A tool whose input schema has a value inside more than 64 nested JSON levels (each object or array is one level, so about 30 nested properties) is not registered (fail-closed).
- `servers.<key>.describe: { read: '...' }` replaces a tool description with your own text. Server `instructions` never reach the system prompt.
- Tool **results** are not filtered: use `ask` for tools with side effects.

---

## Anti-Rug-Pull Tool Pinning

An external MCP server could change its tool definitions after you reviewed them (a "rug-pull").

Generate fingerprints for your MCP tools (a SHA-256 digest of each tool's description, input schema and title, base64url-encoded):

```ts
const digests = await ai.mcp.fingerprint('filesystem')
console.log(digests)
// {
//   read: 'q3V0mY1nR4...',
//   write: 'Zx8kP2tLw0...'
// }
```

Lock the digests into `config/ai.ts`:

```ts
mcp: {
  servers: {
    filesystem: {
      command: 'node',
      args: ['./mcp/fs_server.js'],
      pins: {
        read: 'q3V0mY1nR4...',
        write: 'Zx8kP2tLw0...',
      },
    },
  },
  requirePins: true, // Also refuse any tool without a pin
}
```

A pinned tool whose definition changed is not registered (warning). If it was registered before the change, its registration is replaced by one that refuses every call (`PolicyViolationError`), so the changed tool never runs. It stays refused until the server offers the pinned definition again or you review the change and update the pin.
