import { tool } from 'ai'
import { z } from 'zod'
import type { SkillEntry } from './loader.js'

/** The tool that returns a skill's body in `on-demand` mode. The name is reserved: a caller tool with it is refused. */
export const LOAD_SKILL_TOOL = 'loadSkill'

/**
 * The `loadSkill` tool for a set of loaded skills. Its input accepts only those skill names, and the result is the
 * skill body in a `<skill_content>` wrapper.
 */
export function createLoadSkillTool(options: { skills: SkillEntry[] }) {
  const bodies = new Map(options.skills.map((skill) => [skill.name, skill.body]))
  const names = [...bodies.keys()] as [string, ...string[]]
  if (names.length === 0) {
    throw new Error('createLoadSkillTool needs at least one skill')
  }

  return tool({
    description:
      'Loads the full instructions of one of the available skills listed in the system prompt. Call it before a task that the skill covers; the instructions come back as the result.',
    inputSchema: z.object({ name: z.enum(names) }),
    execute: async ({ name }) => `<skill_content name="${name}">\n${bodies.get(name)}\n</skill_content>`,
  })
}
