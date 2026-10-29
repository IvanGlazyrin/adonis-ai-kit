import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { z } from 'zod'
import type { Logger } from '../logger.js'
import { agentManifestSchema, type AgentManifest, type ToolPermission } from './manifest.js'

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

interface AppPaths {
  makePath(relative: string): string
}

/** The AdonisJS app service, or `null` when this code runs outside an AdonisJS process. */
async function loadAdonisApp(): Promise<AppPaths | null> {
  try {
    const { default: app } = await import('@adonisjs/core/services/app')
    return app
  } catch {
    return null
  }
}

/** A default folder under the app root, or under the working directory when no app is available. */
function defaultDir(app: AppPaths | null, relative: string): string {
  try {
    if (app) return app.makePath(relative)
  } catch {
    // the app is not booted: use the working directory instead
  }
  return path.resolve(process.cwd(), relative)
}

/** Strips a UTF-8 BOM and normalizes line endings so the frontmatter regex always matches. */
function normalizeContent(content: string): string {
  return content.replace(/^\u{FEFF}/u, '').replace(/\r\n/g, '\n')
}

/** Splits `---` frontmatter from the body. Returns `null` when the file has no frontmatter. */
function splitFrontmatter(raw: string): { yaml: string; body: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/)
  return match ? { yaml: match[1], body: (match[2] ?? '').trim() } : null
}

function parseFrontmatter(agentId: string, yaml: string): unknown {
  try {
    return parseYaml(yaml)
  } catch (err: unknown) {
    throw new Error(
      `Failed to parse YAML frontmatter for agent "${agentId}": ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

export interface AgentPromptConfig {
  id: string
  description: string
  mode: 'primary' | 'subagent'
  stopSteps: number
  skills: string[]
  systemPrompt: string
  body: string
  skillPrompts: Record<string, string>
  outputSchemaName?: string
  outputSchema?: z.ZodTypeAny
  permissions: Record<string, ToolPermission>
  phases: string[]
  model?: string
  provider?: string
  temperature?: number
  maxTokens?: number
  metadata?: Record<string, unknown>
}

export interface AgentLoaderOptions {
  configsDir?: string
  skillsDir?: string
  logger?: Logger
  schemaResolver?: (name: string) => z.ZodTypeAny | undefined
}

export class AgentLoader {
  private cache = new Map<string, AgentPromptConfig>()
  private configsDir?: string
  private skillsDir?: string
  private logger?: Logger
  private schemaResolver?: (name: string) => z.ZodTypeAny | undefined

  constructor(options: AgentLoaderOptions = {}) {
    this.configsDir = options.configsDir
    this.skillsDir = options.skillsDir
    this.logger = options.logger
    this.schemaResolver = options.schemaResolver
  }

  setSchemaResolver(resolver: (name: string) => z.ZodTypeAny | undefined) {
    this.schemaResolver = resolver
  }

  setLogger(logger: Logger) {
    this.logger = logger
  }

  async resolveDirs(
    customConfigsDir?: string,
    customSkillsDir?: string
  ): Promise<{ configsDir: string; skillsDir: string }> {
    const configsDir = customConfigsDir ?? this.configsDir
    const skillsDir = customSkillsDir ?? this.skillsDir
    if (configsDir && skillsDir) {
      return { configsDir, skillsDir }
    }

    const app = await loadAdonisApp()
    return {
      configsDir: configsDir || defaultDir(app, 'resources/agent-configs'),
      skillsDir: skillsDir || defaultDir(app, 'resources/agent-skills'),
    }
  }

  /**
   * Resolves `<dir>/<name>.md`, rejecting names that could escape `dir`
   * (`../`, absolute paths, separators). Returns `null` for unsafe names.
   */
  private safeResolve(dir: string, name: string): string | null {
    if (!SAFE_NAME.test(name) || name.includes('..')) return null
    const root = path.resolve(dir)
    const resolved = path.resolve(root, `${name}.md`)
    return resolved.startsWith(root + path.sep) ? resolved : null
  }

  loadSkill(skillName: string, skillsDir: string): string {
    const skillPath = this.safeResolve(skillsDir, skillName)
    if (!skillPath) {
      this.logger?.warn?.(`[AgentLoader] Refusing unsafe skill name: ${JSON.stringify(skillName)}`)
      return ''
    }

    const text = this.readSkillFile(skillPath)
    if (text !== null) return text

    this.logger?.warn?.(`[AgentLoader] Skill not found: ${skillName} at ${skillPath}`)
    return ''
  }

  /** The trimmed text of a skill file; `null` when it is absent or cannot be read (a read failure is logged). */
  private readSkillFile(skillPath: string): string | null {
    try {
      if (!fs.existsSync(skillPath)) return null
      return fs.readFileSync(skillPath, 'utf-8').trim()
    } catch (err: unknown) {
      this.logger?.warn?.(`[AgentLoader] Failed to read skill file "${skillPath}": ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  async loadAgentPrompt(
    agentId: string,
    customConfigsDir?: string,
    customSkillsDir?: string
  ): Promise<AgentPromptConfig> {
    const dirs = await this.resolveDirs(customConfigsDir, customSkillsDir)
    const cacheKey = `${dirs.configsDir}::${dirs.skillsDir}::${agentId}`
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!
    }

    const filePath = this.safeResolve(dirs.configsDir, agentId)
    if (!filePath) {
      throw new Error(`Invalid agent id: ${JSON.stringify(agentId)}`)
    }
    if (!fs.existsSync(filePath)) {
      throw new Error(`Agent prompt configuration file not found: ${filePath}`)
    }

    const raw = normalizeContent(fs.readFileSync(filePath, 'utf-8'))
    const { manifest, body } = this.readManifest(agentId, raw)
    const { systemPrompt, skillPrompts } = this.composeSkills(body, manifest.skills, dirs.skillsDir)
    const resolvedOutputSchema = manifest.outputSchema && this.schemaResolver
      ? this.schemaResolver(manifest.outputSchema)
      : undefined

    const config: AgentPromptConfig = {
      id: manifest.id,
      description: manifest.description,
      mode: manifest.mode,
      stopSteps: manifest.stopSteps,
      skills: manifest.skills,
      systemPrompt,
      body,
      skillPrompts,
      outputSchemaName: manifest.outputSchema,
      outputSchema: resolvedOutputSchema,
      permissions: manifest.permissions,
      phases: manifest.phases,
      model: manifest.model,
      provider: manifest.provider,
      temperature: manifest.temperature,
      maxTokens: manifest.maxTokens,
      metadata: manifest.metadata,
    }

    this.cache.set(cacheKey, config)
    return config
  }

  /** Reads the optional frontmatter and validates it. Without frontmatter the whole file is the body. */
  private readManifest(agentId: string, raw: string): { manifest: AgentManifest; body: string } {
    let manifestRaw: Record<string, unknown> = { id: agentId }
    let body = raw.trim()

    const parts = splitFrontmatter(raw)
    if (parts) {
      const parsed = parseFrontmatter(agentId, parts.yaml)
      // `id` defaults to the file name when the frontmatter omits it
      manifestRaw = { id: agentId, ...(parsed !== null && typeof parsed === 'object' ? parsed : {}) }
      body = parts.body
    }

    const manifestResult = agentManifestSchema.safeParse(manifestRaw)
    if (!manifestResult.success) {
      throw new Error(`Invalid agent manifest for "${agentId}": ${manifestResult.error.message}`)
    }
    return { manifest: manifestResult.data, body }
  }

  /** Appends each skill that loads to the body; a skill that cannot load is skipped. */
  private composeSkills(
    body: string,
    skillNames: string[],
    skillsDir: string
  ): { systemPrompt: string; skillPrompts: Record<string, string> } {
    const skillPrompts: Record<string, string> = {}
    const sections: string[] = []
    for (const skillName of skillNames) {
      const text = this.loadSkill(skillName, skillsDir)
      if (text) {
        skillPrompts[skillName] = text
        sections.push(text)
      }
    }
    const systemPrompt = sections.length > 0 ? [body, ...sections].join('\n\n---\n\n') : body
    return { systemPrompt, skillPrompts }
  }

  async loadAllAgentPrompts(
    customConfigsDir?: string,
    customSkillsDir?: string
  ): Promise<Record<string, AgentPromptConfig>> {
    const dirs = await this.resolveDirs(customConfigsDir, customSkillsDir)
    if (!fs.existsSync(dirs.configsDir)) {
      this.logger?.warn?.(`[AgentLoader] Configs directory does not exist: ${dirs.configsDir}`)
      return {}
    }

    const entries = fs.readdirSync(dirs.configsDir)
    const mdFiles = entries.filter((f) => f.endsWith('.md'))
    const results = await Promise.all(
      mdFiles.map(async (f) => {
        const id = f.replace(/\.md$/, '')
        return [id, await this.loadAgentPrompt(id, dirs.configsDir, dirs.skillsDir)] as const
      })
    )

    return Object.fromEntries(results)
  }

  invalidateCache(agentId?: string): void {
    if (!agentId) {
      this.cache.clear()
      return
    }

    for (const key of this.cache.keys()) {
      if (key.endsWith(`::${agentId}`)) {
        this.cache.delete(key)
      }
    }
  }
}

export const agentLoader = new AgentLoader()

export async function loadAgentPrompt(
  agentId: string,
  configsDir?: string,
  skillsDir?: string
): Promise<AgentPromptConfig> {
  return agentLoader.loadAgentPrompt(agentId, configsDir, skillsDir)
}

export async function loadAllAgentPrompts(
  configsDir?: string,
  skillsDir?: string
): Promise<Record<string, AgentPromptConfig>> {
  return agentLoader.loadAllAgentPrompts(configsDir, skillsDir)
}

export function invalidateAgentCache(agentId?: string): void {
  agentLoader.invalidateCache(agentId)
}
