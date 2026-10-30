import { z } from 'zod'

export const toolPermissionSchema = z.enum(['allow', 'ask', 'deny'])
export type ToolPermission = z.infer<typeof toolPermissionSchema>

export const agentManifestSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().default(''),
    mode: z.enum(['primary', 'subagent']).default('subagent'),
    stop_steps: z.number().int().positive().optional(),
    stopSteps: z.number().int().positive().optional(),
    skills: z.array(z.string()).default([]),
    skillLoading: z.enum(['eager', 'on-demand']).default('eager'),
    outputSchema: z.string().optional(),
    permissions: z.record(z.string(), toolPermissionSchema).default({}),
    phases: z.array(z.string()).default([]),
    model: z.string().optional(),
    provider: z.string().optional(),
    temperature: z.number().optional(),
    maxTokens: z.number().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .transform((data) => ({
    id: data.id,
    description: data.description,
    mode: data.mode,
    stopSteps: data.stopSteps ?? data.stop_steps ?? 5,
    skills: data.skills,
    skillLoading: data.skillLoading,
    outputSchema: data.outputSchema,
    permissions: data.permissions,
    phases: data.phases,
    model: data.model,
    provider: data.provider,
    temperature: data.temperature,
    maxTokens: data.maxTokens,
    metadata: data.metadata,
  }))

export type AgentManifest = z.infer<typeof agentManifestSchema>
