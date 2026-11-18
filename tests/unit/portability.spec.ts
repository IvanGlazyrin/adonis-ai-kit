import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { test } from '@japa/runner'

const SRC = join(import.meta.dirname, '../../src')

/** The files that may import AdonisJS. Everything else under `src/` must work without the framework. */
const ADONIS_ALLOWED = ['host_paths.ts', 'response_macro.ts', `lucid${sep}`]

/** Folders that must import only from themselves (plus the listed shared files), so they can be copied out. */
const SELF_CONTAINED: Record<string, string[]> = {
  events: ['../logger.js', '../types.js'],
  budget: ['../logger.js', '../types.js'],
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return full.endsWith('.ts') ? [full] : []
  })
}

/** Every module specifier a file imports or re-exports, static or dynamic. */
function specifiers(file: string): string[] {
  const source = readFileSync(file, 'utf-8')
  const found: string[] = []
  for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) found.push(match[1])
  return found
}

test.group('portability', () => {
  test('only allowlisted files import @adonisjs', ({ assert }) => {
    const offenders = sourceFiles(SRC)
      .filter((file) => specifiers(file).some((spec) => spec.startsWith('@adonisjs/')))
      .map((file) => relative(SRC, file))
      .filter((file) => !ADONIS_ALLOWED.some((allowed) => file === allowed || file.startsWith(allowed)))

    assert.deepEqual(offenders, [])
  })

  test('core does not re-export the response macro or the configure hook', ({ assert }) => {
    const imports = specifiers(join(SRC, 'core.ts'))
    assert.isAbove(imports.length, 10)
    assert.notInclude(imports, './response_macro.js')
    assert.notInclude(imports, '../configure.js')
  })

  test('events and budget import only their own folder', ({ assert }) => {
    const offenders: string[] = []
    for (const [folder, shared] of Object.entries(SELF_CONTAINED)) {
      for (const file of sourceFiles(join(SRC, folder))) {
        for (const spec of specifiers(file)) {
          if (spec.startsWith('../') && !shared.includes(spec)) offenders.push(`${relative(SRC, file)} -> ${spec}`)
        }
      }
    }
    assert.deepEqual(offenders, [])
  })
})
