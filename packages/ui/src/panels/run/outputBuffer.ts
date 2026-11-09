/**
 * The output of one stream as lines. Chunks arrive at arbitrary byte boundaries, so the last line is a partial one until
 * its newline comes. Carriage returns overwrite (progress bars); ANSI state is remembered per line start so a window of
 * lines can be rendered without parsing everything above it. Old lines are dropped past MAX_LINES (the log file keeps all).
 */
import { endState, EMPTY, stripAnsi, type AnsiState } from './ansi'

export const MAX_LINES = 200_000
const DROP_LINES = 20_000

/** What the line looks like after carriage returns (the text after the last `\r`). */
export function visibleText(raw: string): string {
  const i = raw.lastIndexOf('\r')
  return i < 0 ? raw : raw.slice(i + 1)
}

export class OutputBuffer {
  /** The last entry is the current (possibly empty) partial line. */
  lines: string[] = ['']
  starts: AnsiState[] = [EMPTY]
  times: number[] = [0]
  /** Lines dropped from the front to bound memory. */
  dropped = 0
  /** Bumped on every change; consumers re-render when it moves. */
  version = 0
  private searchCache: { version: number; query: string; hits: number[] } | null = null

  /** Number of lines to show: a trailing empty partial line (output ended with a newline) does not count. */
  get count(): number {
    return this.lines[this.lines.length - 1] === '' ? this.lines.length - 1 : this.lines.length
  }

  get isEmpty(): boolean {
    return this.count === 0
  }

  append(chunk: string, now = Date.now()): void {
    if (!chunk) return
    const parts = chunk.split('\n')
    let last = this.lines.length - 1
    if (parts[0] !== '' && this.lines[last] === '') this.times[last] = now
    this.lines[last] += parts[0]
    for (let i = 1; i < parts.length; i++) {
      // the current line is complete: drop the "\r" of a "\r\n", remember the ANSI state it ends in
      let done = this.lines[last]
      if (done.endsWith('\r')) done = done.slice(0, -1)
      this.lines[last] = done
      const next = endState(done, this.starts[last])
      this.lines.push(parts[i])
      this.starts.push(next)
      this.times.push(parts[i] ? now : 0)
      last++
    }
    if (this.lines.length > MAX_LINES) {
      this.lines.splice(0, DROP_LINES)
      this.starts.splice(0, DROP_LINES)
      this.times.splice(0, DROP_LINES)
      this.dropped += DROP_LINES
    }
    this.version++
  }

  clear(): void {
    this.lines = ['']
    this.starts = [EMPTY]
    this.times = [0]
    this.dropped = 0
    this.searchCache = null
    this.version++
  }

  /** The text (escapes removed, carriage returns applied). */
  text(): string {
    const out: string[] = []
    for (let i = 0; i < this.count; i++) out.push(stripAnsi(visibleText(this.lines[i])))
    return out.join('\n') + (this.count ? '\n' : '')
  }

  /** Indexes of the lines containing `query` (case-insensitive). Cached per version and query. */
  search(query: string): number[] {
    if (!query) return []
    const c = this.searchCache
    if (c && c.version === this.version && c.query === query) return c.hits
    const q = query.toLowerCase()
    const hits: number[] = []
    for (let i = 0; i < this.count; i++) if (stripAnsi(visibleText(this.lines[i])).toLowerCase().includes(q)) hits.push(i)
    this.searchCache = { version: this.version, query, hits }
    return hits
  }

  /** The first line that looks like an error (traceback, "error", …); null when there is none. */
  firstErrorLine(): number | null {
    const re = /\b(traceback|error|exception|fatal|failed|denied|not found)\b/i
    for (let i = 0; i < this.count; i++) if (re.test(stripAnsi(visibleText(this.lines[i])))) return i
    return this.count ? 0 : null
  }
}
