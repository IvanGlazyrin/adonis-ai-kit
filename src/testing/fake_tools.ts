import { tool, type ToolSet } from 'ai'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { FakeAssertionError } from './fake_model.js'

/** Tools whose calls are recorded, with assertions on those calls. */
export interface FakeTools {
  /** Pass as `tools` to a call. */
  tools: ToolSet
  /** The inputs each tool received, by tool name, in call order. */
  readonly inputs: Record<string, readonly unknown[]>
  /**
   * Fails unless the tool ran at least once. `match` is an input to compare with deep equality, or a
   * predicate over the input; when given, some call must match it.
   */
  assertToolCalled(name: string, match?: unknown): void
  /** Fails if the tool ran at all. */
  assertToolNotCalled(name: string): void
}

/**
 * Tools for tests. Each implementation receives the input the model sent and returns the tool result;
 * every execution is recorded. The `execute` of each tool is a real AI SDK tool, so the SDK runs it in the loop.
 */
export function fakeTools(implementations: Record<string, (input: unknown) => unknown>): FakeTools {
  const inputs: Record<string, unknown[]> = {}
  const tools: ToolSet = {}
  for (const [name, implementation] of Object.entries(implementations)) {
    inputs[name] = []
    tools[name] = tool({
      inputSchema: z.any(),
      execute: async (input: unknown) => {
        inputs[name].push(input)
        return implementation(input)
      },
    })
  }

  return {
    tools,
    inputs,
    assertToolCalled(name, match) {
      const received = inputs[name]
      if (!received) throw new FakeAssertionError(`no fake tool named "${name}"`)
      if (received.length === 0) throw new FakeAssertionError(`tool "${name}" was never called`)
      if (match === undefined) return
      const matched = received.some((input) =>
        typeof match === 'function' ? Boolean(match(input)) : isDeepStrictEqual(input, match)
      )
      if (!matched) {
        throw new FakeAssertionError(
          `tool "${name}" was called, but none of its inputs matched ${JSON.stringify(match)}: ${JSON.stringify(received)}`
        )
      }
    },
    assertToolNotCalled(name) {
      const received = inputs[name]
      if (received && received.length > 0) {
        throw new FakeAssertionError(`tool "${name}" was called ${received.length} time(s), expected none`)
      }
    },
  }
}
