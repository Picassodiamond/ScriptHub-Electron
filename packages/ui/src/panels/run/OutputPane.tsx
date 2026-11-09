/**
 * One output stream as a virtualised log: only the rows in view are in the DOM (a run can print millions of lines), ANSI
 * colours, optional timestamps, search highlighting, follow-the-tail. With "wrap" on, rows have no fixed height, so only
 * the last WRAP_ROWS are rendered (turn wrap off to scroll through everything).
 */
import type { JSX } from 'preact'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { parseLine, stateStyle, type Span } from './ansi'
import { clock } from './format'
import { OutputBuffer, visibleText } from './outputBuffer'

export const ROW_HEIGHT = 19
const OVERSCAN = 12
const WRAP_ROWS = 2500
const DEFAULT_HEIGHT = 420

export interface PaneController {
  /** Scroll so that buffer line `line` is visible (centred). */
  scrollToLine(line: number): void
}

interface Props {
  buffer: OutputBuffer
  /** Re-render trigger (buffer.version). */
  version: number
  follow: boolean
  onFollowChange(on: boolean): void
  wrap: boolean
  timestamps: boolean
  query: string
  /** Show only the lines that match `query`. */
  filterOnly: boolean
  /** The buffer line of the current search match (gets a stronger highlight). */
  currentLine: number | null
  controller?: { current: PaneController | null }
  label: string
  class?: string
}

function highlight(text: string, q: string, strong: boolean) {
  if (!q) return text
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  const out: Array<string | JSX.Element> = []
  let i = 0
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, i)) {
    if (at > i) out.push(text.slice(i, at))
    out.push(<mark class={strong ? 'hit hit-cur' : 'hit'}>{text.slice(at, at + needle.length)}</mark>)
    i = at + needle.length
  }
  if (i < text.length) out.push(text.slice(i))
  return out
}

function Row({ raw, start, q, strong }: { raw: string; start: Parameters<typeof parseLine>[1]; q: string; strong: boolean }) {
  const spans: Span[] = parseLine(visibleText(raw), start).spans
  if (!spans.length) return <span> </span>
  return (
    <>
      {spans.map((s, i) => {
        const { cls, style } = stateStyle(s.state)
        return cls || style || q
          ? <span key={i} class={cls} style={style || undefined}>{highlight(s.text, q, strong)}</span>
          : s.text
      })}
    </>
  )
}

export function OutputPane(p: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(DEFAULT_HEIGHT)
  const user = useRef(false)
  const programmatic = useRef(false)
  const b = p.buffer

  // the rows shown: all lines, or the lines matching the filter
  const view = useMemo(() => (p.filterOnly && p.query ? b.search(p.query) : null), [p.filterOnly, p.query, p.version, b])
  const total = view ? view.length : b.count
  const rowOf = (line: number): number => (view ? view.indexOf(line) : line)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setHeight(el.clientHeight || DEFAULT_HEIGHT)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const scrollTo = (top: number) => {
    const el = box.current
    if (!el) return
    programmatic.current = true
    el.scrollTop = top
    setScrollTop(el.scrollTop)
    setTimeout(() => { programmatic.current = false }, 0)
  }

  // follow the tail
  useLayoutEffect(() => {
    const el = box.current
    if (el && p.follow) scrollTo(el.scrollHeight)
  }, [p.version, p.follow, total, p.wrap, p.timestamps])

  useEffect(() => {
    if (!p.controller) return
    p.controller.current = {
      scrollToLine(line) {
        const row = rowOf(line)
        if (row < 0) return
        if (p.wrap) {
          const el = box.current?.querySelector(`[data-line="${line}"]`) as HTMLElement | null
          el?.scrollIntoView({ block: 'center' })
        } else scrollTo(Math.max(0, row * ROW_HEIGHT - height / 2))
      },
    }
    return () => { if (p.controller) p.controller.current = null }
  })

  const onScroll = () => {
    const el = box.current
    if (!el) return
    setScrollTop(el.scrollTop)
    if (programmatic.current) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (!atBottom && p.follow && user.current) p.onFollowChange(false)
    else if (atBottom && !p.follow && user.current) p.onFollowChange(true) // scrolled back to the end by hand
  }
  const mark = () => { user.current = true }

  let rows: JSX.Element[]
  let padTop = 0
  let padBottom = 0
  let hidden = 0
  const rowEl = (row: number) => {
    const line = view ? view[row] : row
    const t = p.timestamps ? clock(b.times[line] ?? 0) : ''
    return (
      <div class="vrow" key={line} data-line={line} style={p.wrap ? undefined : `height:${ROW_HEIGHT}px`}>
        {p.timestamps && <span class="vts">{t || '        '}</span>}
        <span class="vtext"><Row raw={b.lines[line]} start={b.starts[line]} q={p.query} strong={line === p.currentLine} /></span>
      </div>
    )
  }
  if (p.wrap) {
    const first = Math.max(0, total - WRAP_ROWS)
    hidden = first
    rows = []
    for (let r = first; r < total; r++) rows.push(rowEl(r))
  } else {
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
    const last = Math.min(total, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN)
    padTop = first * ROW_HEIGHT
    padBottom = Math.max(0, (total - last) * ROW_HEIGHT)
    rows = []
    for (let r = first; r < last; r++) rows.push(rowEl(r))
  }

  return (
    <div
      class={`vlog ${p.wrap ? 'is-wrap' : ''} ${p.class ?? ''}`} ref={box} tabIndex={0} role="log" aria-label={p.label}
      onScroll={onScroll} onWheel={mark} onTouchMove={mark} onMouseDown={mark} onKeyDown={mark}
    >
      {(b.dropped > 0 || hidden > 0) && (
        <div class="vnote-wrap">
          <div class="vnote">
            {b.dropped > 0 && <>{b.dropped.toLocaleString()} earlier lines are not kept in this view; the log file has everything. </>}
            {hidden > 0 && <>{hidden.toLocaleString()} lines above are not shown while wrapping. </>}
          </div>
        </div>
      )}
      {total === 0 && <div class="vempty">{p.filterOnly && p.query ? 'No lines match.' : 'No output yet.'}</div>}
      <div class="vrows" style={p.wrap ? undefined : `padding-top:${padTop}px;padding-bottom:${padBottom}px`}>{rows}</div>
    </div>
  )
}
