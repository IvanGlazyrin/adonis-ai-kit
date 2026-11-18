import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Adonis AI Kit',
  description: 'AI toolkit for AdonisJS 7 on the Vercel AI SDK v7: provider fallback, circuit breakers, tool guardrails, cost tracking, MCP and ACP agents',
  lang: 'en-US',
  // The site is served from https://ivanglazyrin.github.io/adonis-ai-kit/
  base: '/adonis-ai-kit/',
  cleanUrls: true,
  lastUpdated: true,

  head: [
    ['link', { rel: 'icon', href: '/adonis-ai-kit/favicon.ico' }],
    ['meta', { name: 'theme-color', content: '#5A45FF' }],
  ],

  themeConfig: {
    siteTitle: 'Adonis AI Kit',
    logo: '/logo.svg',

    nav: [
      { text: 'Documentation', link: '/guide/introduction' },
      { text: 'Full Reference (1-to-1 Laravel style)', link: '/ai-sdk' },
      { text: 'Changelog', link: 'https://github.com/IvanGlazyrin/adonis-ai-kit/blob/main/CHANGELOG.md' },
      {
        text: 'v1.4.0',
        items: [
          { text: 'npm package', link: 'https://www.npmjs.com/package/adonis-ai-kit' },
          { text: 'GitHub repository', link: 'https://github.com/IvanGlazyrin/adonis-ai-kit' },
        ],
      },
    ],

    sidebar: [
      {
        text: 'Getting Started',
        collapsed: false,
        items: [
          { text: 'Introduction', link: '/guide/introduction' },
          { text: 'Installation', link: '/guide/installation' },
          { text: 'Configuration', link: '/guide/configuration' },
        ],
      },
      {
        text: 'Core Basics',
        collapsed: false,
        items: [
          { text: 'Text & Chat Generation', link: '/guide/text-and-chat' },
          { text: 'Streaming & SSE Macro', link: '/guide/streaming' },
          { text: 'Conversations & History', link: '/guide/conversations' },
        ],
      },
      {
        text: 'Agents & Workflows',
        collapsed: false,
        items: [
          { text: 'Agents & Manifests', link: '/guide/agents' },
          { text: 'Tools & Security Guardrails', link: '/guide/tools-guardrails' },
          { text: 'Human Tool Approval (HITL)', link: '/guide/resumable-approvals' },
          { text: 'MCP Servers as Tools', link: '/guide/mcp-tools' },
          { text: 'ACP Coding Agents', link: '/guide/acp-agents' },
          { text: 'Step Control, Cache & Recovery', link: '/guide/step-control-and-cache' },
        ],
      },
      {
        text: 'Resilience & Operations',
        collapsed: false,
        items: [
          { text: 'Failover & Circuit Breaker', link: '/guide/resilience-and-fallbacks' },
          { text: 'Token Budget & Live Cost', link: '/guide/budget-and-cost' },
          { text: 'Events & Observability', link: '/guide/observability' },
          { text: 'Live Catalog (models.dev)', link: '/guide/catalog' },
        ],
      },
      {
        text: 'Testing & Tooling',
        collapsed: false,
        items: [
          { text: 'Testing & Test Doubles', link: '/guide/testing' },
          { text: 'Ace CLI Commands', link: '/guide/cli' },
          { text: 'Complete Single-Page Reference', link: '/ai-sdk' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/IvanGlazyrin/adonis-ai-kit' },
    ],

    search: {
      provider: 'local',
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Ivan Glazyrin & contributors.',
    },
  },
})
