/** Longest description the model gets for an MCP tool, prefix included, in code points. */
export const MCP_DESCRIPTION_MAX = 1024

/**
 * Characters removed from the text the model reads: every default-ignorable code point, every format character
 * (Unicode category Cf) and every noncharacter. They hide or reorder text: soft hyphen, zero-width and bidi marks and
 * controls, the byte-order mark, the Hangul fillers, the variation selectors VS1–VS256, and the tag characters, which
 * can carry a hidden ASCII message. The same classes also remove visible text, a deliberate trade-off (see the
 * changelog): the zero-width joiner and non-joiner (some emoji sequences and Persian text lose a character), the
 * emoji presentation selectors VS15 and VS16, the Mongolian free variation selectors and vowel separator (U+180E), the
 * combining grapheme joiner (U+034F), the Arabic number signs, pound and piastre marks (U+0890–0891) and end-of-ayah
 * marks, the Syriac abbreviation mark (U+070F), the Khmer inherent vowels, the interlinear annotation marks
 * (U+FFF9–FFFB), the invisible math operators (U+2061–2064), and some Egyptian, Kaithi, shorthand (U+1BCA0–1BCA3) and
 * musical format controls.
 * Not removed here: private-use characters, the Braille blank (U+2800), the Khitan filler (U+16FE4), lone surrogates,
 * and the C0 and C1 controls. A description loses the controls in `cleanText`; text outside descriptions keeps them.
 * The list is for orientation; the class above is the definition.
 */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Noncharacter_Code_Point}]/gu

/** Whether `text` holds a character that `INVISIBLE` removes. */
function hasInvisible(text: string): boolean {
  return text.replace(INVISIBLE, '') !== text
}

/** The text with tabs, line breaks and line separators as spaces, control and invisible characters removed, and trimmed. */
function cleanText(text: string): string {
  return text
    .replace(/[\t\n\r\u{2028}\u{2029}]/gu, ' ')
    .replace(/[\u{0}-\u{1F}\u{7F}-\u{9F}]/gu, '')
    .replace(INVISIBLE, '')
    .trim()
}

/** The text capped at `MCP_DESCRIPTION_MAX` code points; a cut text ends with an ellipsis. */
function capped(text: string): string {
  const chars = Array.from(text)
  return chars.length > MCP_DESCRIPTION_MAX ? `${chars.slice(0, MCP_DESCRIPTION_MAX - 1).join('')}…` : text
}

/**
 * The description an MCP tool is offered with. Server descriptions are untrusted: the text is cleaned (see `cleanText`),
 * prefixed with `[MCP:<server>]` so the model sees where it comes from, and capped at 1024 characters.
 */
export function safeDescription(server: string, description: string | undefined): string {
  return capped(`[MCP:${server}] ${cleanText(description ?? '')}`.trimEnd())
}

/**
 * Deepest JSON nesting the schema cleaner walks. Each object or array is one level, the root included; a schema with
 * a value inside more than 64 nested JSON levels is refused, never passed on uncleaned. A nested property takes two
 * levels (its schema and `properties`), so this is about 30 nested properties (31 in a bare `properties` chain).
 * A `description` string is not checked for depth: it is cleaned, not walked.
 */
export const SCHEMA_MAX_DEPTH = 64

/** Keywords whose value is a map from a name to a schema. The keys are names, not keywords. */
const SCHEMA_MAPS: ReadonlySet<string> = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])
/** Keywords whose value is one schema, or (`items` in draft-07, `additionalItems`) a list of them. */
const SCHEMA_VALUES: ReadonlySet<string> = new Set([
  'items',
  'additionalItems',
  'additionalProperties',
  'unevaluatedItems',
  'unevaluatedProperties',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'propertyNames',
  'contentSchema',
])
/** Keywords whose value is a list of schemas. */
const SCHEMA_LISTS: ReadonlySet<string> = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])

/**
 * A copy of a JSON schema for the model, whose text is untrusted. It throws, so the tool is refused, when:
 * - a value is inside more than `SCHEMA_MAX_DEPTH` (64) nested JSON levels (each object or array is one level; about
 *   30 nested properties);
 * - an object key (a property name or any other key) or any string value holds an invisible character (`INVISIBLE`),
 *   except a `description`, which is cleaned instead (`title`, `enum`, `const`, `default`, `examples`, `pattern`,
 *   `$comment`, `required` and every other string reach the model as they are, so they are checked, not cleaned);
 * - a `description` in a schema is not a string.
 * A `description` string is cleaned and capped like the tool description.
 *
 * The walk knows where schemas are, because `description` is a keyword only in a schema, not in data and not as a property
 * name. Handled: name-to-schema maps (`properties`, `patternProperties`, `$defs`, `definitions`, `dependentSchemas`,
 * `dependencies`), schema keywords (`items`, `additionalItems`, `additionalProperties`, `unevaluatedItems`,
 * `unevaluatedProperties`, `not`, `if`, `then`, `else`, `contains`, `propertyNames`, `contentSchema`) and lists of
 * schemas (`allOf`, `anyOf`, `oneOf`, `prefixItems`). A schema may be `true` or `false`. Every other keyword, including
 * `enum`, `const`, `default`, `examples` and unknown ones (`x-...`), is data: only checked for invisible characters.
 */
export function safeSchemaDescriptions<T>(value: T, depth = 0): T {
  return cleanedSchema(value, depth) as T
}

function assertDepth(depth: number): void {
  if (depth > SCHEMA_MAX_DEPTH) throw new RangeError(`the schema is nested deeper than ${SCHEMA_MAX_DEPTH} levels`)
}

function assertVisible(text: string, what: string): void {
  if (hasInvisible(text)) throw new Error(`a schema ${what} contains invisible characters`)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A schema: an object whose keywords are walked, or a boolean. Anything else is passed on as data. */
function cleanedSchema(value: unknown, depth: number): unknown {
  assertDepth(depth)
  if (!isPlainObject(value)) return checkedData(value, depth)
  // `Object.fromEntries` keeps a key such as `__proto__` as an own property; an assignment would set the prototype.
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      assertVisible(key, 'keyword')
      return [key, cleanedKeyword(key, child, depth + 1)]
    })
  )
}

/** The value of one keyword of a schema. */
function cleanedKeyword(key: string, child: unknown, depth: number): unknown {
  if (key === 'description') return cleanedDescription(child)
  if (SCHEMA_MAPS.has(key)) return cleanedSchemaMap(child, depth, cleanedSchema)
  // Draft-07 `dependencies`: a schema, or a list of property names (data).
  if (key === 'dependencies') return cleanedSchemaMap(child, depth, (item, at) => (Array.isArray(item) ? checkedData(item, at) : cleanedSchema(item, at)))
  if (SCHEMA_VALUES.has(key)) return Array.isArray(child) ? cleanedSchemaList(child, depth) : cleanedSchema(child, depth)
  if (SCHEMA_LISTS.has(key)) return Array.isArray(child) ? cleanedSchemaList(child, depth) : checkedData(child, depth)
  return checkedData(child, depth)
}

function cleanedSchemaList(list: unknown[], depth: number): unknown[] {
  assertDepth(depth)
  return list.map((item) => cleanedSchema(item, depth + 1))
}

/** A name-to-schema map: the keys are names (checked), the values are schemas. */
function cleanedSchemaMap(value: unknown, depth: number, walk: (item: unknown, depth: number) => unknown): unknown {
  assertDepth(depth)
  if (!isPlainObject(value)) return checkedData(value, depth)
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => {
      assertVisible(name, 'property name')
      return [name, walk(item, depth + 1)]
    })
  )
}

/** The value of a `description` keyword: a string, cleaned and capped. Anything else is refused. */
function cleanedDescription(child: unknown): string {
  if (typeof child === 'string') return capped(cleanText(child))
  throw new Error('a schema description is not a string')
}

/** Data (and unknown values): returned as it is, unless a key or a string holds an invisible character. */
function checkedData(value: unknown, depth: number): unknown {
  assertDepth(depth)
  if (typeof value === 'string') {
    assertVisible(value, 'string value')
    return value
  }
  if (Array.isArray(value)) return value.map((item) => checkedData(item, depth + 1))
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        assertVisible(key, 'key')
        return [key, checkedData(item, depth + 1)]
      })
    )
  }
  return value
}
