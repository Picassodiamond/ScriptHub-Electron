/**
 * A small YAML subset for saved values, sequences and script metadata (no dependency).
 * Port of runner/yamlish.py: same dialect, same output, same errors.
 */
export class YamlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'YamlError'
  }
}

type Y = any
const INDENT = '  '
const PLAIN_OK = /^[A-Za-z0-9_./@+=,-][A-Za-z0-9_./@+=, :()\\-]*$/
const RESERVED = new Set(['true', 'false', 'yes', 'no', 'on', 'off', 'null', '~', ''])
const INT = /^[-+]?\d+$/
const FLOAT = /^[-+]?(\d+\.\d*|\.\d+|\d+(\.\d*)?[eE][-+]?\d+)$/
const KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/
const FLOW_BAD = /[,[\]{}]/
export const FLOW_WIDTH = 100

const isMap = (v: Y): v is Record<string, Y> => v !== null && typeof v === 'object' && !Array.isArray(v)

// ------------------------------------------------------------------ dump ---
function scalar(v: Y): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return JSON.stringify(v)
  const s = String(v)
  if (PLAIN_OK.test(s) && !RESERVED.has(s.toLowerCase()) && !INT.test(s) && !FLOAT.test(s) &&
      !s.includes(': ') && !s.includes(' #') && !s.endsWith(' ') && !s.endsWith(':') && s === s.trim()) return s
  return JSON.stringify(s)
}

function key(k: Y): string {
  const s = String(k)
  return KEY.test(s) && !RESERVED.has(s.toLowerCase()) ? s : JSON.stringify(s)
}

function flowValue(v: Y): string {
  if (isMap(v)) return '{' + Object.entries(v).map(([k, x]) => `${key(k)}: ${flowValue(x)}`).join(', ') + '}'
  if (Array.isArray(v)) return '[' + v.map(flowValue).join(', ') + ']'
  let text = scalar(v)
  if (!text.startsWith('"') && FLOW_BAD.test(text)) text = JSON.stringify(String(v))
  return text
}

function dumpMap(d: Record<string, Y>, level: number, out: string[], flow: boolean): void {
  const pad = INDENT.repeat(level)
  for (const [k, v] of Object.entries(d)) {
    if (isMap(v)) {
      if (Object.keys(v).length) {
        out.push(`${pad}${key(k)}:`)
        dumpMap(v, level + 1, out, flow)
      } else out.push(`${pad}${key(k)}: {}`)
    } else if (Array.isArray(v)) {
      if (!v.length) {
        out.push(`${pad}${key(k)}: []`)
        continue
      }
      if (flow && !v.some(isMap)) {
        const line = `${pad}${key(k)}: ${flowValue(v)}`
        if (line.length <= FLOW_WIDTH || v.some(Array.isArray)) {
          out.push(line)
          continue
        }
      }
      out.push(`${pad}${key(k)}:`)
      for (const item of v) {
        if (isMap(item)) {
          if (!Object.keys(item).length) {
            out.push(`${pad}${INDENT}- {}`)
            continue
          }
          const sub: string[] = []
          dumpMap(item, level + 2, sub, flow)
          sub[0] = `${pad}${INDENT}- ` + sub[0].replace(/^ +/, '')
          out.push(...sub)
          continue
        }
        if (Array.isArray(item)) {
          if (!flow) throw new YamlError('Lists inside lists are not supported.')
          out.push(`${pad}${INDENT}- ${flowValue(item)}`)
          continue
        }
        out.push(`${pad}${INDENT}- ${scalar(item)}`)
      }
    } else out.push(`${pad}${key(k)}: ${scalar(v)}`)
  }
}

/** `data` as YAML text. `flow`: short lists of scalars on one line (`choices: [a, b]`). */
export function dump(data: Record<string, Y>, header = '', flow = false): string {
  const out = header ? header.split(/\r?\n/).map((l) => `# ${l}`.trimEnd()) : []
  dumpMap(data, 0, out, flow)
  return out.join('\n') + '\n'
}

// ------------------------------------------------------------------ load ---
function stripComment(text: string): string {
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\' && quote === '"') continue
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '#' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t')) return text.slice(0, i).trimEnd()
  }
  return text.trimEnd()
}

function parseScalar(raw: string, lineNo: number): Y {
  const s = raw.trim()
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s)
    } catch (e: any) {
      throw new YamlError(`line ${lineNo}: bad double-quoted string (${e.message})`)
    }
  }
  if (s.startsWith("'")) {
    if (s.length < 2 || !s.endsWith("'")) throw new YamlError(`line ${lineNo}: unterminated single-quoted string`)
    return s.slice(1, -1).replaceAll("''", "'")
  }
  if (s.startsWith('[') || s.startsWith('{')) return parseFlow(s, lineNo)
  if (s.length && '&*!|>'.includes(s[0])) throw new YamlError(`line ${lineNo}: this YAML feature is not supported here`)
  const low = s.toLowerCase()
  if (low === 'true' || low === 'yes' || low === 'on') return true
  if (low === 'false' || low === 'no' || low === 'off') return false
  if (low === 'null' || low === '~' || low === '') return null
  if (INT.test(s)) return parseInt(s, 10)
  if (FLOAT.test(s)) return parseFloat(s)
  return s
}

function parseFlow(s: string, lineNo: number): Y {
  let pos = 0
  const fail = (what: string): never => {
    throw new YamlError(`line ${lineNo}: ${what} in a [...] / {...} value`)
  }
  const spaces = () => {
    while (pos < s.length && (s[pos] === ' ' || s[pos] === '\t')) pos++
  }
  const quoted = (): Y => {
    const q = s[pos]
    let end = pos + 1
    while (end < s.length) {
      if (q === '"' && s[end] === '\\') {
        end += 2
        continue
      }
      if (s[end] === q) {
        if (q === "'" && s.slice(end + 1, end + 2) === "'") {
          end += 2
          continue
        }
        break
      }
      end++
    }
    if (end >= s.length) fail('an unterminated string')
    const text = s.slice(pos, end + 1)
    pos = end + 1
    return parseScalar(text, lineNo)
  }
  const plain = (stop: string): string => {
    const start = pos
    while (pos < s.length && !stop.includes(s[pos])) pos++
    return s.slice(start, pos).trim()
  }
  const value = (): Y => {
    spaces()
    if (pos >= s.length) fail('a missing value')
    const c = s[pos]
    if (c === '[' || c === '{') return collection()
    if (c === '"' || c === "'") return quoted()
    const text = plain(',]}')
    if (text && '&*!|>#'.includes(text[0])) fail(`an unsupported value '${text}'`)
    return parseScalar(text, lineNo)
  }
  const collection = (): Y => {
    const map = s[pos] === '{'
    const close = map ? '}' : ']'
    pos++
    const result: Y = map ? {} : []
    spaces()
    if (pos < s.length && s[pos] === close) {
      pos++
      return result
    }
    for (;;) {
      spaces()
      if (map) {
        const k = pos < s.length && s[pos] === '"' ? quoted() : plain(':,]}')
        spaces()
        if (pos >= s.length || s[pos] !== ':') fail("a key without ': value'")
        pos++
        result[String(k)] = value()
      } else result.push(value())
      spaces()
      if (pos < s.length && s[pos] === ',') {
        pos++
        spaces()
        if (pos < s.length && s[pos] === close) {
          pos++
          return result
        }
        continue
      }
      if (pos < s.length && s[pos] === close) {
        pos++
        return result
      }
      fail(`a missing ',' or '${close}'`)
    }
  }
  const result = collection()
  spaces()
  if (pos < s.length) fail('text after the closing bracket')
  return result
}

function splitKey(text: string, lineNo: number): [string, string] {
  let k: Y
  let rest: string
  if (text.startsWith('"')) {
    let end = 1
    while (end < text.length) {
      if (text[end] === '\\') {
        end += 2
        continue
      }
      if (text[end] === '"') break
      end++
    }
    k = parseScalar(text.slice(0, end + 1), lineNo)
    rest = text.slice(end + 1)
  } else {
    const idx = text.indexOf(':')
    if (idx <= 0) throw new YamlError(`line ${lineNo}: expected 'key: value'`)
    k = text.slice(0, idx).trim()
    rest = text.slice(idx)
  }
  if (!rest.startsWith(':') || (rest.length > 1 && rest[1] !== ' ' && rest[1] !== '\t'))
    throw new YamlError(`line ${lineNo}: expected 'key: value'`)
  return [String(k), rest.slice(1).trim()]
}

const ITEM_KEY = /^("(?:[^"\\]|\\.)*"|[^\s"'\-[{&*!|>#][^:]*):(\s|$)/

/** Parse the subset described above; throws YamlError. */
export function load(text: string): Record<string, Y> {
  const lines: Array<[number, number, string]> = []
  text.replace(/\r\n?/g, '\n').split('\n').forEach((raw, i) => {
    const n = i + 1
    const trimmed = raw.trim()
    if (trimmed === '' || raw.trimStart().startsWith('#')) return
    const lead = raw.slice(0, raw.length - raw.trimStart().length)
    if (lead.includes('\t')) throw new YamlError(`line ${n}: use spaces, not tabs, to indent`)
    if (trimmed === '---' || trimmed === '...') return
    const indent = raw.length - raw.replace(/^ +/, '').length
    lines.push([n, indent, stripComment(trimmed)])
  })

  let pos = 0
  const isItem = (c: string) => c.startsWith('- ') || c === '-'
  const item = (): Y => {
    const [n, ind, content] = lines[pos]
    const rest = content.slice(1).replace(/^ +/, '')
    if (ITEM_KEY.test(rest)) {
      lines[pos] = [n, ind + content.length - rest.length, rest]
      return block(lines[pos][1])
    }
    pos++
    return parseScalar(rest, n)
  }
  const block = (indent: number): Y => {
    let result: Y = null
    while (pos < lines.length) {
      const [n, ind, content] = lines[pos]
      if (ind < indent) break
      if (ind > indent) throw new YamlError(`line ${n}: unexpected indentation`)
      if (isItem(content)) {
        if (result === null) result = []
        else if (!Array.isArray(result)) throw new YamlError(`line ${n}: a list item inside a mapping`)
        result.push(item())
        continue
      }
      if (result === null) result = {}
      else if (!isMap(result)) throw new YamlError(`line ${n}: a mapping key inside a list`)
      const [k, value] = splitKey(content, n)
      pos++
      if (value === '') {
        if (pos < lines.length && lines[pos][1] > indent) result[k] = block(lines[pos][1])
        else if (pos < lines.length && lines[pos][1] === indent && lines[pos][2].startsWith('-')) {
          const items: Y[] = []
          while (pos < lines.length && lines[pos][1] === indent && isItem(lines[pos][2])) items.push(item())
          result[k] = items
        } else result[k] = null
      } else result[k] = parseScalar(value, n)
    }
    return result === null ? {} : result
  }

  const data = block(lines.length ? lines[0][1] : 0)
  if (pos < lines.length) throw new YamlError(`line ${lines[pos][0]}: unexpected indentation`)
  if (!isMap(data)) throw new YamlError('the file must be a mapping (key: value lines)')
  return data
}
