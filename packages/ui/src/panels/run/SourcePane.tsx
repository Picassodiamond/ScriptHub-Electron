/**
 * The script's source for trace and debug runs: read-only editor, the line being run highlighted (and an arrow in the
 * gutter when debugging), lines already reached tinted, and the breakpoint gutter for debug runs.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { CodeEditor, type EditorAdapter } from '../../editor'

export interface SourceController {
  reveal(line: number): void
  /** The line the editor cursor is on (1-based), 0 when unknown. */
  cursorLine(): number
}

interface Props {
  lines: string[]
  language: string
  debugMode: boolean
  /** The line being run / paused on. */
  current: number | null
  /** Executing right now (not paused): the current-line marker is the "running" one. */
  running: boolean
  /** Lines reached so far. */
  visited: number[]
  hits: Map<number, number>
  breakpoints: number[]
  onBreakpoints(lines: number[]): void
  controller: { current: SourceController | null }
}

/** The editor language for the trace language key the engine reports (python | shell | batch | powershell). */
export const editorLanguage = (lang: string): string => ({ python: 'python', shell: 'shell', batch: 'bat', powershell: 'powershell' } as Record<string, string>)[lang] ?? 'plaintext'

export function SourcePane(p: Props) {
  const ed = useRef<EditorAdapter | null>(null)
  const cursor = useRef(0)
  const latest = useRef(p)
  latest.current = p
  const [ready, setReady] = useState(false)
  const text = useMemo(() => p.lines.join('\n'), [p.lines])

  useEffect(() => {
    p.controller.current = {
      reveal: (line) => ed.current?.revealLine(line, true),
      cursorLine: () => cursor.current,
    }
    return () => { p.controller.current = null }
  }, [])

  // reached lines (lighter) and the current line
  useEffect(() => {
    if (!ready || !ed.current) return
    ed.current.setLineDecorations('trace', p.visited.filter((l) => l !== p.current).map((line) => ({
      line, kind: 'trace' as const, hover: `reached ${p.hits.get(line) ?? 1}× (sampled)`,
    })))
  }, [ready, p.visited, p.current, p.hits, text])

  useEffect(() => {
    if (!ready || !ed.current) return
    ed.current.setLineDecorations('current', p.current ? [{
      line: p.current, kind: p.running ? ('highlight' as const) : ('current' as const), glyph: p.debugMode ? ('current' as const) : undefined,
      hover: p.debugMode ? (p.running ? 'running' : 'paused here') : 'running line',
    }] : [])
    if (p.current) ed.current.revealLine(p.current, false)
  }, [ready, p.current, p.running, p.debugMode, text])

  useEffect(() => {
    if (ready && ed.current) ed.current.setBreakpoints(p.breakpoints)
  }, [ready, p.breakpoints, text])

  return (
    <div class="run-source" data-testid="run-source">
      <CodeEditor
        value={text} language={p.language} readOnly breakpoints={p.debugMode}
        onReady={(a) => {
          ed.current = a
          a.onCursorLine((l) => { cursor.current = l })
          a.onBreakpointsChange((lines) => latest.current.onBreakpoints(lines))
          setReady(true)
        }}
      />
    </div>
  )
}
