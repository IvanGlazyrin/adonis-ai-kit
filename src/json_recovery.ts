/**
 * The first complete JSON object or array in `text`, found by scanning past prose and markdown fences.
 *
 * A candidate starts at `{` or `[` and ends at its matching bracket; brackets inside JSON strings do not
 * count. A candidate that does not `JSON.parse` is skipped and the scan continues from the next opening
 * bracket. When no valid JSON is found, `text` is returned unchanged.
 */
export function extractFirstJsonValue(text: string): string {
  for (let start = 0; start < text.length; start++) {
    const open = text[start]
    if (open !== '{' && open !== '[') continue
    const end = matchingEnd(text, start)
    if (end === -1) continue
    const candidate = text.slice(start, end + 1)
    try {
      JSON.parse(candidate)
      return candidate
    } catch {
      // Not valid JSON: try the next opening bracket.
    }
  }
  return text
}

const CLOSER: Record<string, string> = { '{': '}', '[': ']' }

/** Index of the bracket that closes the one at `start`, or -1 when the brackets never balance. */
function matchingEnd(text: string, start: number): number {
  const expected: string[] = []
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{' || ch === '[') {
      expected.push(CLOSER[ch])
    } else if (ch === '}' || ch === ']') {
      if (expected.pop() !== ch) return -1
      if (expected.length === 0) return i
    }
  }
  return -1
}
