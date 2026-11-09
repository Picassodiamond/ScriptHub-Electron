/**
 * Pure helpers of the script page (no DOM, no api): the metadata block inside the script text, and the
 * parameter-to-line marking. Port of the relevant parts of the old designer.js.
 */

/** `# --- scripthub ---` / `# --- end scripthub ---` (also `::` and `rem` for batch files). */
const MARK = /^\s*(?:#|::|rem\b)\s*--- (end )?scripthub ---\s*$/i

/** The metadata block of a script text ('' when there is none): from the start marker to the end marker. */
export function blockOf(text: string): string {
  const lines = String(text).split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const m = MARK.exec(lines[i])
    if (!m) continue
    if (!m[1] && start < 0) start = i
    else if (m[1] && start >= 0) return lines.slice(start, i + 1).join('\n')
  }
  return ''
}

/** 1-based line range of the metadata block, or null. */
export function blockRange(text: string): [number, number] | null {
  const lines = String(text).split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const m = MARK.exec(lines[i])
    if (!m) continue
    if (!m[1] && start < 0) start = i
    else if (m[1] && start >= 0) return [start + 1, i + 1]
  }
  return null
}

const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A term (parameter name, flag, env variable) as a whole word: not glued to identifier characters. */
export function termRegex(term: string): RegExp {
  return new RegExp(`(^|[^A-Za-z0-9_])${esc(term)}(?![A-Za-z0-9_])`)
}

/** Usable search terms: longer than one character, not a dash placeholder, not just digits. */
export function cleanTerms(terms: string[]): string[] {
  return terms.filter((t) => t.length > 1 && t !== '—' && !/^\d+$/.test(t))
}

/** 1-based numbers of the lines that mention any of `terms`. */
export function refLines(text: string, terms: string[]): number[] {
  const pats = cleanTerms(terms).map(termRegex)
  if (!pats.length) return []
  const hits: number[] = []
  text.split('\n').forEach((line, i) => {
    if (pats.some((p) => p.test(line))) hits.push(i + 1)
  })
  return hits
}

/** What marks a parameter's lines in the script: its name, its flag and its environment variable. */
export function termsOfParam(p: Record<string, any>): string[] {
  const out: string[] = []
  if (p.name) out.push(String(p.name))
  if (p.arg) out.push(String(p.arg))
  if (p.env_name) out.push(String(p.env_name))
  return out
}

/** The same for a parameter *definition* with defaults filled in (what the parameter editor shows). */
export function termsOfDefinition(p: Record<string, any>): string[] {
  const out: string[] = []
  const name = String(p.name ?? '')
  if (name) out.push(name)
  const mode = p.pass_as ?? 'flag'
  if (mode === 'flag') out.push(p.arg || `--${name.replace(/_/g, '-')}`)
  else if (mode === 'env') out.push(p.env_name || name.toUpperCase())
  return out
}
