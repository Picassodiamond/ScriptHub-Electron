/**
 * ANSI escape handling for the console: SGR colours/styles are turned into spans, every other escape sequence
 * (cursor movement, OSC titles, …) is dropped. State carries over between lines, so each line keeps the state it
 * starts in (see OutputBuffer).
 */
export interface AnsiState {
  /** 0-15 = palette index (CSS var), '#rrggbb' = 256/true colour */
  fg?: number | string
  bg?: number | string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
}

export interface Span { text: string; state: AnsiState }

export const EMPTY: AnsiState = Object.freeze({}) as AnsiState

// CSI: ESC [ params intermediates final     OSC: ESC ] … (BEL | ESC \)     other two-character escapes
const ESC_RE = /\x1b\[([0-9;:?]*)([ -/]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g
const ESC_ONLY = /\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g

/** The text without any escape sequence. */
export function stripAnsi(text: string): string {
  return text.includes('\x1b') ? text.replace(ESC_ONLY, '') : text
}

const hex = (n: number) => n.toString(16).padStart(2, '0')
const rgb = (r: number, g: number, b: number) => `#${hex(r & 255)}${hex(g & 255)}${hex(b & 255)}`

/** xterm 256-colour index → palette index (0-15) or a hex string. */
function color256(n: number): number | string {
  if (n < 16) return n
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return rgb(v, v, v)
  }
  const i = n - 16
  const c = (x: number) => (x === 0 ? 0 : 55 + x * 40)
  return rgb(c(Math.floor(i / 36)), c(Math.floor(i / 6) % 6), c(i % 6))
}

function applySgr(prev: AnsiState, params: string): AnsiState {
  const codes = params === '' ? [0] : params.split(/[;:]/).map((p) => (p === '' ? 0 : parseInt(p, 10)))
  let s: AnsiState = { ...prev }
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]
    if (Number.isNaN(c)) continue
    if (c === 0) s = {}
    else if (c === 1) s.bold = true
    else if (c === 2) s.dim = true
    else if (c === 3) s.italic = true
    else if (c === 4) s.underline = true
    else if (c === 7) s.inverse = true
    else if (c === 22) { s.bold = false; s.dim = false }
    else if (c === 23) s.italic = false
    else if (c === 24) s.underline = false
    else if (c === 27) s.inverse = false
    else if (c >= 30 && c <= 37) s.fg = c - 30
    else if (c >= 90 && c <= 97) s.fg = c - 90 + 8
    else if (c === 39) delete s.fg
    else if (c >= 40 && c <= 47) s.bg = c - 40
    else if (c >= 100 && c <= 107) s.bg = c - 100 + 8
    else if (c === 49) delete s.bg
    else if (c === 38 || c === 48) {
      const key = c === 38 ? 'fg' : 'bg'
      if (codes[i + 1] === 5 && codes[i + 2] !== undefined) {
        s[key] = color256(codes[i + 2])
        i += 2
      } else if (codes[i + 1] === 2 && codes[i + 4] !== undefined) {
        s[key] = rgb(codes[i + 2], codes[i + 3], codes[i + 4])
        i += 4
      }
    }
  }
  // drop false flags so equal states compare equal
  for (const k of ['bold', 'dim', 'italic', 'underline', 'inverse'] as const) if (s[k] === false) delete s[k]
  return s
}

export const sameState = (a: AnsiState, b: AnsiState): boolean =>
  a.fg === b.fg && a.bg === b.bg && !!a.bold === !!b.bold && !!a.dim === !!b.dim && !!a.italic === !!b.italic &&
  !!a.underline === !!b.underline && !!a.inverse === !!b.inverse

/** The spans of one line (SGR applied from `start`) and the state at its end. */
export function parseLine(text: string, start: AnsiState = EMPTY): { spans: Span[]; end: AnsiState } {
  if (!text.includes('\x1b')) return { spans: text ? [{ text, state: start }] : [], end: start }
  const spans: Span[] = []
  let state = start
  let last = 0
  ESC_RE.lastIndex = 0
  for (let m = ESC_RE.exec(text); m; m = ESC_RE.exec(text)) {
    if (m.index > last) spans.push({ text: text.slice(last, m.index), state })
    last = m.index + m[0].length
    if (m[3] === 'm' && m[1] !== undefined && !m[1].startsWith('?')) state = applySgr(state, m[1])
  }
  if (last < text.length) spans.push({ text: text.slice(last), state })
  return { spans, end: state }
}

/** The end state of a line without building spans. */
export function endState(text: string, start: AnsiState = EMPTY): AnsiState {
  return text.includes('\x1b') ? parseLine(text, start).end : start
}

/** CSS class names and an inline style for a state (palette colours are CSS variables, see run.css). */
export function stateStyle(s: AnsiState): { cls: string; style: string } {
  const cls: string[] = []
  const style: string[] = []
  let fg = s.fg
  let bg = s.bg
  if (s.inverse) [fg, bg] = [bg ?? 'var(--code-bg)', fg ?? 'var(--code-text)']
  if (typeof fg === 'number') cls.push(`ansi-fg-${fg}`)
  else if (typeof fg === 'string') style.push(fg.startsWith('var(') || fg.startsWith('#') ? `color:${fg}` : '')
  if (typeof bg === 'number') cls.push(`ansi-bg-${bg}`)
  else if (typeof bg === 'string') style.push(`background:${bg}`)
  if (s.bold) cls.push('ansi-bold')
  if (s.dim) cls.push('ansi-dim')
  if (s.italic) cls.push('ansi-italic')
  if (s.underline) cls.push('ansi-underline')
  return { cls: cls.join(' '), style: style.filter(Boolean).join(';') }
}
