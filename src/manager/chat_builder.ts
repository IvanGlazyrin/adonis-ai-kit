import type { ModelMessage, ToolSet } from 'ai'
import type { ChatMessage, GenerateTextOptions, GenerateTextResult, StreamTextOptions, StreamTextResult } from '../types.js'

export interface ChatTarget {
  generateText(options: GenerateTextOptions): Promise<GenerateTextResult>
  streamText(options: StreamTextOptions): Promise<StreamTextResult>
}

/** Fluent conversation builder (Laravel AI / Prism syntax style). */
export function createChatBuilder(target: ChatTarget) {
  const messages: ChatMessage[] = []
  let systemPrompt: string | undefined
  let providerOverride: string | undefined
  let modelOverride: string | undefined
  let temperatureVal: number | undefined
  let agentNameVal: string | undefined
  let toolsVal: ToolSet | undefined

  const builder = {
    system: (prompt: string) => {
      systemPrompt = prompt
      return builder
    },
    user: (content: string) => {
      messages.push({ role: 'user', content })
      return builder
    },
    assistant: (content: string) => {
      messages.push({ role: 'assistant', content })
      return builder
    },
    provider: (name: string) => {
      providerOverride = name
      return builder
    },
    model: (name: string) => {
      modelOverride = name
      return builder
    },
    temperature: (val: number) => {
      temperatureVal = val
      return builder
    },
    agent: (name: string) => {
      agentNameVal = name
      return builder
    },
    tools: (tools: ToolSet) => {
      toolsVal = tools
      return builder
    },
    generate: () =>
      target.generateText({
        system: systemPrompt,
        messages: messages as ModelMessage[],
        provider: providerOverride,
        model: modelOverride,
        temperature: temperatureVal,
        agentName: agentNameVal,
        tools: toolsVal,
      }),
    stream: () =>
      target.streamText({
        system: systemPrompt,
        messages: messages as ModelMessage[],
        provider: providerOverride,
        model: modelOverride,
        temperature: temperatureVal,
        agentName: agentNameVal,
        tools: toolsVal,
      }),
  }

  return builder
}
