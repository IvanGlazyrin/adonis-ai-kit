import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { z } from 'zod'
import type { Logger } from '../logger.js'
import { agentManifestSchema, type AgentManifest, type ToolPermission } from './manifest.js'
import { LOAD_SKILL_TOOL } from './skill_tool.js'

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * The real path of `file` (symlinks followed) when it lies inside `dir` (also followed), else `null`. The caller reads
 * the returned path, so the file it checked is the file it reads. A path that cannot be resolved throws.
 */
function realPathInside(dir: string, file: string): string | null {
  const root = fs.realpathSync(dir)
  const real = fs.realpathSync(file)
  return real.startsWith(withSeparator(root)) ? real : null
}

/** The directory path with a trailing separator, so a prefix test does not match a sibling (`skills` vs `skills2`). */
function withSeparator(dir: string): string {
  return dir.endsWith(path.sep) ? dir : dir + path.sep
}

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

/** A skill file read for use: its name, the one-line description shown to the model, and the body. */
export interface SkillEntry {
  name: string
  description: string
  /** The skill text without its frontmatter block. */
  body: string
}

/** Skill files above this size are not loaded (the same limit as laravel/ai). */
export const MAX_SKILL_BYTES = 256 * 1024

/**
 * Reads a skill file. Optional `---` frontmatter gives `description`; `name`, when present, must match the file name
 * (a mismatch is a warning only). Without a description the first `# heading` is used, then the skill name.
 * A broken frontmatter block is a warning: the description then comes from the heading and the body has no block.
 */
function parseSkill(name: string, raw: string, warn: (message: string) => void): SkillEntry {
  const normalized = normalizeContent(raw)
  const parts = splitFrontmatter(normalized)
  // Without frontmatter the body is the file as it was (trimmed), so eager prompts stay byte-identical.
  let body = parts ? parts.body : raw.trim()
  let meta: Record<string, unknown> = {}

  if (parts) {
    try {
      const parsed = parseYaml(parts.yaml)
      if (parsed !== null && typeof parsed === 'object') meta = parsed as Record<string, unknown>
    } catch (err: unknown) {
      warn(`[AgentLoader] Skill "${name}" has invalid YAML frontmatter; its description comes from the heading: ${err instanceof Error ? err.message : String(err)}`)
      body = parts.body
    }
    if (typeof meta.name === 'string' && meta.name !== name) {
      warn(`[AgentLoader] Skill file "${name}" declares name "${meta.name}" in its frontmatter`)
    }
  }

  const declared = typeof meta.description === 'string' ? meta.description.trim() : ''
  const heading = body.match(/^#\s+(.+?)\s*$/m)?.[1]
  return { name, description: declared || heading || name, body }
}

/** The agent body with the skill bodies appended, each after a `---` line. */
export function appendSkillBodies(body: string, skills: SkillEntry[]): string {
  return skills.length > 0 ? [body, ...skills.map((skill) => skill.body)].join('\n\n---\n\n') : body
}

/**
 * The on-demand system prompt: the body, then one `name: description` line per skill and the rule to load a skill
 * before a task it covers. Fixed text, so the prompt is identical on every step (prompt cache).
 */
export function composeOnDemandPrompt(body: string, skills: SkillEntry[]): string {
  if (skills.length === 0) return body
  const index = skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')
  return [
    body,
    '## Available skills',
    `Before a task that one of these skills covers, call the \`${LOAD_SKILL_TOOL}\` tool with its name, then follow the instructions it returns.`,
    index,
  ].join('\n\n---\n\n')
}

export interface AgentPromptConfig {
  id: string
  description: string
  mode: 'primary' | 'subagent'
  stopSteps: number
  skills: string[]
  /** `eager`: every skill body is in `systemPrompt`. `on-demand`: `systemPrompt` lists names and descriptions only. */
  skillLoading: 'eager' | 'on-demand'
  systemPrompt: string
  /** The system prompt with every skill body inlined, whatever `skillLoading` is. */
  eagerSystemPrompt: string
  body: string
  skillPrompts: Record<string, string>
  /** The skills that loaded, with their descriptions. */
  skillEntries: SkillEntry[]
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
    return resolved.startsWith(withSeparator(root)) ? resolved : null
  }

  /** The body of a skill (no frontmatter); empty when the skill does not load. */
  loadSkill(skillName: string, skillsDir: string): string {
    return this.loadSkillEntry(skillName, skillsDir)?.body ?? ''
  }

  /** A skill with its description; `null` when it is missing, unsafe, unreadable or over the size limit (each logged). */
  loadSkillEntry(skillName: string, skillsDir: string): SkillEntry | null {
    const skillPath = this.safeResolve(skillsDir, skillName)
    if (!skillPath) {
      this.logger?.warn?.(`[AgentLoader] Refusing unsafe skill name: ${JSON.stringify(skillName)}`)
      return null
    }
    if (!fs.existsSync(skillPath)) {
      this.logger?.warn?.(`[AgentLoader] Skill not found: ${skillName} at ${skillPath}`)
      return null
    }
    let realPath: string | null
    try {
      realPath = realPathInside(skillsDir, skillPath)
    } catch (err: unknown) {
      this.logger?.warn?.(`[AgentLoader] Failed to resolve skill "${skillName}" at ${skillPath}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
    if (!realPath) {
      this.logger?.warn?.(`[AgentLoader] Skill "${skillName}" resolves outside the skills directory (symlink?) and is not loaded: ${skillPath}`)
      return null
    }
    return this.readSkillFile(skillName, realPath)
  }

  /** `null` when the file cannot be read or is over `MAX_SKILL_BYTES` (both are logged). */
  private readSkillFile(skillName: string, skillPath: string): SkillEntry | null {
    try {
      if (fs.statSync(skillPath).size > MAX_SKILL_BYTES) {
        this.logger?.warn?.(`[AgentLoader] Skill "${skillName}" is larger than ${MAX_SKILL_BYTES} bytes and is not loaded: ${skillPath}`)
        return null
      }
      const raw = fs.readFileSync(skillPath, 'utf-8')
      return parseSkill(skillName, raw, (message) => this.logger?.warn?.(message))
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
    const { systemPrompt, eagerSystemPrompt, skillPrompts, skillEntries } = this.composeSkills(
      body,
      manifest.skills,
      dirs.skillsDir,
      manifest.skillLoading
    )
    const resolvedOutputSchema = manifest.outputSchema && this.schemaResolver
      ? this.schemaResolver(manifest.outputSchema)
      : undefined

    const config: AgentPromptConfig = {
      id: manifest.id,
      description: manifest.description,
      mode: manifest.mode,
      stopSteps: manifest.stopSteps,
      skills: manifest.skills,
      skillLoading: manifest.skillLoading,
      systemPrompt,
      eagerSystemPrompt,
      body,
      skillPrompts,
      skillEntries,
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

  /**
   * Loads the skills a manifest lists. A skill that cannot load is skipped. `eagerSystemPrompt` always holds every
   * body; `systemPrompt` is that prompt in `eager` mode, and the body with a name-and-description index in `on-demand`.
   */
  private composeSkills(
    body: string,
    skillNames: string[],
    skillsDir: string,
    skillLoading: 'eager' | 'on-demand'
  ): { systemPrompt: string; eagerSystemPrompt: string; skillPrompts: Record<string, string>; skillEntries: SkillEntry[] } {
    const skillPrompts: Record<string, string> = {}
    const skillEntries: SkillEntry[] = []
    for (const skillName of skillNames) {
      const entry = this.loadSkillEntry(skillName, skillsDir)
      if (entry && entry.body) {
        skillPrompts[skillName] = entry.body
        skillEntries.push(entry)
      }
    }
    const eagerSystemPrompt = appendSkillBodies(body, skillEntries)
    const systemPrompt = skillLoading === 'on-demand' ? composeOnDemandPrompt(body, skillEntries) : eagerSystemPrompt
    return { systemPrompt, eagerSystemPrompt, skillPrompts, skillEntries }
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
