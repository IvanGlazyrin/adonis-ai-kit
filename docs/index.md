---
layout: home

hero:
  name: "Adonis AI Kit"
  text: "AI and agent workflows for AdonisJS 7"
  tagline: "Vercel AI SDK v7, multi-provider cascading fallback, circuit breakers, tool security guardrails, token budget tracking, and ACP coding agents."
  actions:
    - theme: brand
      text: Get Started
      link: /guide/introduction
    - theme: alt
      text: Full Laravel-Style Reference
      link: /ai-sdk
    - theme: alt
      text: View on GitHub
      link: https://github.com/IvanGlazyrin/adonis-ai-kit

features:
  - title: Multi-Provider SRE Resilience
    details: Automated cascading failover (OpenAI, Anthropic, Gemini, Groq, Ollama, custom models) with isolated per-model circuit breakers and fail-closed side-effect guards.
    icon: 🛡️
  - title: Tool Security & HITL Guardrails
    details: Granular policy enforcement (allow, ask, deny), call limits, argument validation, and signed resumable approvals that survive process restarts.
    icon: 🔒
  - title: Live Cost & Token Budgeting
    details: Real-time USD pricing via models.dev, bounded ring-buffer usage tracking, and atomic pre-flight token reservations to stop budget blowouts.
    icon: 💰
  - title: Expressive AdonisJS Streaming
    details: Built-in response.streamAI() macro for Server-Sent Events (SSE), background heartbeat keep-alives, and instant client-disconnect abort propagation.
    icon: ⚡
  - title: Agent Client Protocol (ACP)
    details: Orchestrate CLI coding agents like Claude Code, opencode, or custom ACP agents with a sanitized child-process environment and optional MCP servers.
    icon: 🤖
  - title: MCP Servers as Tools
    details: Securely mount stdio or HTTP Model Context Protocol servers with deny-by-default policies, untrusted text sanitization, and anti-rug-pull pins.
    icon: 🔌
---
