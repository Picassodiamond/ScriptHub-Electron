/**
 * The run tab: status and summary, live stdout/stderr, and for trace / debug runs the source with the running line and
 * (debug) the stepping controls. Port of console.html + console.js, driven by engine events instead of polling.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Icon } from '../../components/Icon'
import {
  api, closeTab, confirm, errorText, hostInfo, openTab, readStore, saveFile, setTabStatus, toast, useCommand, writeStore, type PanelProps,
} from '../../core'
import { DebugBar, Inspector, debugLabel, canDo, type DebugAction } from './Debug'
import { copyText, fmtDuration, shortTime } from './format'
import { OutputPane, type PaneController } from './OutputPane'
import { SourcePane, editorLanguage, type SourceController } from './SourcePane'
import { useRunStream } from './useRunStream'

type Layout = 'side' | 'stack' | 'out'
const PANES_KEY = 'sr.panes'
const WRAP_KEY = 'sr.run.wrap'
const TS_KEY = 'sr.run.timestamps'

const readFlag = (k: string): boolean => readStore(k) === '1'
const readLayout = (hasSource: boolean): Layout => {
  const v = readStore(PANES_KEY)
  return v === 'side' || v === 'stack' || v === 'out' ? v : hasSource ? 'side' : 'stack'
}

interface Match { pane: 'out' | 'err'; line: number }

export function RunConsole({ tab, active }: PanelProps) {
  const runId = tab.id
  const stream = useRunStream(runId, active)
  const { info, status, out, err, version, debug, link, linkNote } = stream
  const run: Record<string, any> = info?.run ?? {}
  const isActive = status?.active ?? info?.active ?? false
  const hasSource = !!(info?.trace && info.traceLines?.length)
  const isDebug = !!info?.debug

  const [layout, setLayoutState] = useState<Layout>(() => readLayout(false))
  const [layoutTouched, setLayoutTouched] = useState(() => readStore(PANES_KEY) !== null)
  const [follow, setFollow] = useState(true)
  const [wrap, setWrapState] = useState(() => readFlag(WRAP_KEY))
  const [timestamps, setTimestampsState] = useState(() => readFlag(TS_KEY))
  const [query, setQuery] = useState('')
  const [filterOnly, setFilterOnly] = useState(false)
  const [cur, setCur] = useState(0)
  const [busy, setBusy] = useState(false)
  const [bps, setBps] = useState<number[]>([])
  const outCtl = useRef<PaneController | null>(null)
  const errCtl = useRef<PaneController | null>(null)
  const srcCtl = useRef<SourceController | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const bpBusy = useRef(0)
  const bpTouched = useRef(false)
  const serverBps = useRef<string | null>(null)

  // a trace run starts in the side-by-side layout unless the user chose one
  useEffect(() => { if (hasSource && !layoutTouched) setLayoutState('side') }, [hasSource])
  const setLayout = (l: Layout) => { setLayoutState(l); setLayoutTouched(true); writeStore(PANES_KEY, l) }
  const setWrap = (on: boolean) => { setWrapState(on); writeStore(WRAP_KEY, on ? '1' : '0') }
  const setTimestamps = (on: boolean) => { setTimestampsState(on); writeStore(TS_KEY, on ? '1' : '0') }

  // ------------------------------------------------------------- search --
  const matches = useMemo<Match[]>(() => {
    if (!query) return []
    return [
      ...out.search(query).map((line) => ({ pane: 'out' as const, line })),
      ...err.search(query).map((line) => ({ pane: 'err' as const, line })),
    ]
  }, [query, version, out, err])
  useEffect(() => setCur(0), [query])
  const current = matches.length ? matches[Math.min(cur, matches.length - 1)] : null

  const goTo = (m: Match | null) => {
    if (!m) return
    setFollow(false)
    if (m.pane === 'err' && layout === 'out') setLayout('stack')
    setTimeout(() => (m.pane === 'out' ? outCtl : errCtl).current?.scrollToLine(m.line), 0)
  }
  const step = (d: 1 | -1) => {
    if (!matches.length) return
    const i = (Math.min(cur, matches.length - 1) + d + matches.length) % matches.length
    setCur(i)
    goTo(matches[i])
  }
  const firstError = () => {
    const re = /\b(traceback|error|exception|fatal)\b/i
    const lineOf = (b: typeof err): number | null => {
      for (let i = 0; i < b.count; i++) if (re.test(b.lines[i])) return i
      return null
    }
    let m: Match | null = null
    const e = lineOf(err)
    if (e !== null) m = { pane: 'err', line: e }
    else if (!err.isEmpty) m = { pane: 'err', line: 0 }
    else {
      const o = lineOf(out)
      if (o !== null) m = { pane: 'out', line: o }
    }
    if (!m) return void toast.info('No errors in the output.')
    goTo(m)
  }
  const hasErrors = !err.isEmpty || out.lines.some((l) => /\b(traceback|error|exception|fatal)\b/i.test(l))

  // ------------------------------------------------------------ actions --
  const stop = async () => {
    if (!runId || !(await confirm({ message: 'Stop this execution?', confirmLabel: 'Stop', danger: true }))) return
    try {
      const r = await api['runs.stop']({ id: runId })
      if (r.stopped) toast.info('Stop requested.')
      else if (r.active) toast.warning('This run is not managed by this application instance, so it cannot be stopped from here.')
      else toast.info('This run has already finished.')
    } catch (e) { toast.error(errorText(e)) }
  }

  const remove = async () => {
    if (!runId || !(await confirm({ message: `Delete ${runId} and its logs?`, confirmLabel: 'Delete', danger: true }))) return
    try {
      const r = await api['runs.delete']({ id: runId })
      if (r.deleted) { toast.success('Run deleted.'); closeTab(tab.key) } else toast.warning('The run could not be deleted.')
    } catch (e) { toast.error(errorText(e)) }
  }

  const openScript = () => run.script_id && openTab({ kind: 'script', id: run.script_id, title: run.script_name })

  /** The script's Run form, with the values of this run when they are still among its recent runs. */
  const rerun = async () => {
    if (!run.script_id) return
    let preset: string | undefined
    try {
      const f = await api['runs.form']({ scriptId: run.script_id })
      const i = (f.recent ?? []).findIndex((r: any) => r.run_id === runId)
      preset = i >= 0 ? `@${i}` : undefined
    } catch { /* the form opens with its own defaults */ }
    openTab({ kind: 'script', id: run.script_id, title: run.script_name, params: { view: 'run', ...(preset ? { preset } : {}), nonce: Date.now() } })
  }

  const reveal = () => runId && void api['app.reveal']({ kind: 'run', id: runId }).catch((e) => toast.error(errorText(e)))

  const copy = async (b: typeof out, label: string) => {
    toast[(await copyText(b.text())) ? 'success' : 'error'](await Promise.resolve((b.isEmpty ? 'Nothing to copy.' : `${label} copied.`)))
  }

  const download = async (stream_: 'stdout' | 'stderr') => {
    if (!runId) return
    const b = stream_ === 'stdout' ? out : err
    try {
      const f = await api['runs.logPath']({ id: runId, stream: stream_ })
      if (b.dropped > 0) {
        // the view dropped old lines: read the whole file again, chunk by chunk
        let text = ''
        let offs = 0
        for (let g = 0; g < 20_000; g++) {
          const r = await api['runs.status']({ id: runId, out: stream_ === 'stdout' ? offs : 0, err: stream_ === 'stderr' ? offs : 0 })
          const chunk = stream_ === 'stdout' ? r.stdout : r.stderr
          const next = stream_ === 'stdout' ? r.stdout_next : r.stderr_next
          if (!chunk || next <= offs) break
          text += chunk
          offs = next
        }
        await saveFile(f.name, text)
      } else await saveFile(f.name, b.lines.slice(0, b.count).join('\n') + (b.count ? '\n' : ''))
    } catch (e) { toast.info(errorText(e)) }
  }

  // ------------------------------------------------------------ debugger --
  const sendDebug = useCallback(async (action: Exclude<DebugAction, 'stop'>) => {
    if (!runId) return
    setBusy(true)
    if (action === 'step' || action === 'continue') stream.setDebug({ ...(debug ?? { line: null, scopes: [], stack: [], breakpoints: [] }), state: 'running' } as any)
    try {
      const r = await api['runs.debug']({ id: runId, action })
      stream.setDebug(r.debug)
      if (!r.ok && r.error) toast.warning(r.error)
    } catch (e) { toast.warning(errorText(e)) } finally { setBusy(false) }
  }, [runId, debug])

  const onAction = (a: DebugAction) => (a === 'stop' ? void stop() : void sendDebug(a))

  const syncBreakpoints = useCallback((lines: number[]) => {
    if (!runId || !isActive) return
    bpBusy.current++
    void api['runs.debug']({ id: runId, action: 'breakpoints', lines }).catch(() => {}).finally(() => { bpBusy.current-- })
  }, [runId, isActive])

  const changeBreakpoints = useCallback((lines: number[]) => {
    const sorted = [...new Set(lines)].sort((a, b) => a - b)
    bpTouched.current = true
    setBps(sorted)
    syncBreakpoints(sorted)
  }, [syncBreakpoints])

  // A list the engine reports that is new (it changed since its last report) wins over ours, unless a change of ours is
  // still in flight; a repeat of an old report never undoes a click that the engine has not processed yet.
  useEffect(() => {
    if (!debug || !Array.isArray(debug.breakpoints) || debug.state === 'ended') return
    const srv = [...debug.breakpoints].sort((a, b) => a - b).join(',')
    const first = serverBps.current === null
    const changed = serverBps.current !== srv
    serverBps.current = srv
    if (bpBusy.current || !isActive || !changed || (first && bpTouched.current)) return
    if (srv !== bps.join(',')) setBps(srv ? srv.split(',').map(Number) : [])
  }, [debug])

  const toggleBpAtCursor = () => {
    const line = srcCtl.current?.cursorLine() || 0
    if (!line) return
    changeBreakpoints(bps.includes(line) ? bps.filter((l) => l !== line) : [...bps, line])
  }

  useEffect(() => {
    if (!active || !isDebug) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return
      const can = canDo(debug, isActive, busy)
      let handled = true
      if (e.key === 'F5' && e.shiftKey) { if (can.stop) void stop() }
      else if (e.key === 'F5') { if (can.continue) void sendDebug('continue') }
      else if (e.key === 'F10') { if (can.step) void sendDebug('step') }
      else if (e.key === 'F6') { if (can.pause) void sendDebug('pause') }
      else if (e.key === 'F9') toggleBpAtCursor()
      else handled = false
      if (handled) { e.preventDefault(); e.stopPropagation() }
    }
    window.addEventListener('keydown', onKey, true) // before the shell: F10 would open its menu bar
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, isDebug, debug, isActive, busy, bps, sendDebug])

  // Ctrl+F finds in the output; the Run command ("r") opens the run form again
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); search.current?.focus(); search.current?.select() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])
  useCommand('run.run', () => void rerun(), active)

  // the lower tab shows this run's state
  const tabState = status?.status ?? run.status ?? null
  useEffect(() => {
    const paused = isDebug && isActive && debug?.state === 'paused'
    setTabStatus(tab.key, !tabState ? null : paused ? 'paused' : tabState === 'running' || tabState === 'queued' ? 'running' : tabState === 'success' ? 'ok' : tabState === 'failed' || tabState === 'timed_out' ? 'failed' : 'other')
  }, [tab.key, tabState, isActive, debug?.state])
  useEffect(() => () => setTabStatus(tab.key, null), [tab.key])

  // --------------------------------------------------------------- render --
  if (!runId) return <div class="page"><p class="empty">No run selected.</p></div>
  if (stream.loadError) {
    return (
      <div class="page run-console-empty">
        <div class="flash flash-error"><span>{stream.loadError}</span></div>
        <p class="muted">This run no longer exists (it may have been deleted by the retention policy).</p>
        <button type="button" class="btn" onClick={() => closeTab(tab.key)}>Close tab</button>
      </div>
    )
  }

  const st = status?.status ?? run.status ?? 'queued'
  const paused = isDebug && isActive && debug?.state === 'paused'
  const chipClass = paused ? 'st-paused' : `st-${st}`
  const chipLabel = paused ? 'Paused' : status?.status_label ?? info?.statusLabel ?? st
  const exit = status?.exit_code ?? run.exit_code ?? null
  const errorText_ = status?.error ?? run.error ?? null
  const showError = !!errorText_ && st !== 'success'
  const queued = st === 'queued'
  const duration = stream.elapsed === null ? '—' : status?.status === 'running' ? fmtDuration(stream.elapsed) : status?.duration ?? fmtDuration(stream.elapsed)
  const seq = run.sequence?.run ? run.sequence : null
  const trace = stream.trace ?? (info?.trace as any) ?? null
  const traceLines = info?.traceLines ?? []
  const lang = info?.traceLang ?? ''
  const currentLine: number | null = isDebug ? (debug && debug.state !== 'ended' ? debug.line : stream.lineHistory[stream.lineHistory.length - 1] ?? null)
    : trace?.line ?? null
  const running = isDebug ? debug?.state === 'running' || debug?.state === 'detached' : isActive
  const visited = useMemo(() => [...stream.lineHits.keys()], [version, stream.lineHits])
  const recentLines = stream.lineHistory.slice(-14)
  const reveal_ = (l: number) => srcCtl.current?.reveal(l)

  const live = link === 'live'
  const showErr = layout !== 'out'

  return (
    <div class="run-console" data-testid="run-console" data-run={runId} data-status={st}>
      <div class="console-bar console-head">
        <span class={`st ${chipClass}`} data-testid="status-chip">{chipLabel}</span>
        {run.script_id
          ? <a class="strong plain clamp-1" href="#" title="Open the script" onClick={(e) => { e.preventDefault(); openScript() }}>{run.script_name}</a>
          : <span class="strong clamp-1">{run.script_name ?? runId}</span>}
        <span class="faint small mono">{runId}</span>
        {isDebug ? <span class="badge badge-warn"><Icon name="bug" small /> debug</span> : info?.trace ? <span class="badge"><Icon name="eye" small /> trace</span> : null}
        <span class="spacer" />
        <span class={`live ${live ? 'is-live' : ''}`} data-testid="live"><span class="sb-dot" /><span>{linkNote}</span></span>
        {hostInfo.value?.desktop && <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Show the run folder (logs, metadata)" onClick={reveal}><Icon name="folder" /></button>}
        <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Refresh now" onClick={() => void stream.refresh()}><Icon name="refresh" /></button>
        {!isActive && <button type="button" class="btn btn-ghost btn-icon btn-sm btn-del" title="Delete this run and its logs" onClick={() => void remove()}><Icon name="trash" /></button>}
        {run.script_id && <button type="button" class="btn btn-sm" title="Open the script's run form with these values" onClick={() => void rerun()}><Icon name="play" /> Run again</button>}
        {isActive && <button type="button" class="btn btn-danger btn-sm" id="stop-btn" onClick={() => void stop()}><Icon name="stop" class="i-fill" /> Stop</button>}
      </div>

      <div class="run-summary">
        <div class="rs-item"><div class="rs-label">Duration</div><div class="rs-val" data-testid="duration">{duration}</div></div>
        <div class="rs-item"><div class="rs-label">Exit code</div><div class="rs-val" data-testid="exit-code">{exit === null ? '—' : exit}</div></div>
        <div class="rs-item"><div class="rs-label">Started</div><div class="rs-val">{shortTime(status?.started_at ?? run.started_at)}</div></div>
        <div class="rs-item"><div class="rs-label">Completed</div><div class="rs-val">{shortTime(status?.finished_at ?? run.finished_at)}</div></div>
        <div class="rs-item hide-sm"><div class="rs-label">Host</div><div class="rs-val">{!run.host || run.host === 'local' ? 'local' : <>{run.host} <span class="faint">ssh</span></>}</div></div>
        <div class="rs-item hide-sm"><div class="rs-label">PID</div><div class="rs-val">{status?.pid ?? run.pid ?? '—'}</div></div>
        {run.initiator && <div class="rs-item hide-sm"><div class="rs-label">Started from</div><div class="rs-val">{run.initiator}</div></div>}
      </div>

      <div class="notes">
        {run.logs_deleted && <div class="flash flash-info"><span>The logs of this execution were removed by the retention policy; only its record remains.</span></div>}
        {queued && (
          <div class="flash flash-info" data-testid="queue-note">
            <span>Queued{status?.queue_position ? ` (position ${status.queue_position})` : ''} — waiting for a free execution slot.</span>
          </div>
        )}
        {showError && <div class="flash flash-error" data-testid="error-note"><span>{errorText_}</span></div>}
        {link === 'error' && <div class="flash flash-warn"><span>{linkNote}</span> <button type="button" class="btn btn-sm" onClick={() => void stream.refresh()}>Retry</button></div>}
      </div>

      <details class="run-details">
        <summary>Parameters &amp; command</summary>
        <div class="rd-body">
          <table class="table table-dense">
            <tbody>
              {(info?.paramRows ?? []).length
                ? info!.paramRows.map(([k, v]) => <tr key={k}><th class="th-row mono">{k}</th><td class="mono">{v}</td></tr>)
                : <tr><td class="muted">No parameters.</td></tr>}
            </tbody>
          </table>
          <pre class="codebox">{run.command}</pre>
          <p class="muted small" style="margin:10px 0 0">
            Script: <span class="mono wrap-anywhere">{run.script_path}</span>
            {seq && <> · step {seq.step} of <a href="#" onClick={(e) => { e.preventDefault(); openTab({ kind: 'sequence-run', id: seq.run, title: seq.name }) }}>{seq.name} ({seq.run})</a></>}
          </p>
        </div>
      </details>

      <div class="console-bar run-tools">
        <div class="run-find">
          <Icon name="search" small />
          <input
            ref={search} type="search" class="run-search" placeholder="Find in output (Ctrl+F)" value={query} aria-label="Find in output"
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1) }
              else if (e.key === 'Escape') { setQuery(''); (e.target as HTMLInputElement).blur() }
            }}
          />
          {query && <span class="faint small" data-testid="match-count">{matches.length ? `${Math.min(cur, matches.length - 1) + 1}/${matches.length}` : 'no match'}</span>}
          <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Previous match (Shift+Enter)" disabled={!matches.length} onClick={() => step(-1)}><Icon name="up" /></button>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Next match (Enter)" disabled={!matches.length} onClick={() => step(1)}><Icon name="down" /></button>
          <label class="check small"><input type="checkbox" checked={filterOnly} onChange={(e) => setFilterOnly((e.target as HTMLInputElement).checked)} /><span>Only matching lines</span></label>
        </div>
        <span class="spacer" />
        {hasErrors && <button type="button" class="btn btn-ghost btn-sm" title="Jump to the first error" onClick={firstError}><Icon name="zap" /> First error</button>}
        <label class="check small"><input type="checkbox" checked={follow} onChange={(e) => setFollow((e.target as HTMLInputElement).checked)} /><span>Auto-scroll</span></label>
        <label class="check small"><input type="checkbox" checked={wrap} onChange={(e) => setWrap((e.target as HTMLInputElement).checked)} /><span>Wrap</span></label>
        <label class="check small"><input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps((e.target as HTMLInputElement).checked)} /><span>Time</span></label>
        <div class="seg" role="group" aria-label="Output layout">
          <button type="button" class={`seg-btn ${layout === 'side' ? 'is-active' : ''}`} title="Side by side" onClick={() => setLayout('side')}><Icon name="layout" /></button>
          <button type="button" class={`seg-btn ${layout === 'stack' ? 'is-active' : ''}`} title="Stacked" onClick={() => setLayout('stack')}><Icon name="layout-rows" /></button>
          <button type="button" class={`seg-btn ${layout === 'out' ? 'is-active' : ''}`} title="Standard output only" onClick={() => setLayout('out')}><Icon name="terminal" /></button>
        </div>
      </div>

      <div class={`workspace ${hasSource ? 'has-source' : ''}`}>
        {hasSource && (
          <div class={`ws-top ${isDebug ? 'has-inspector' : ''}`}>
            <section class="pane trace-card" data-testid="trace-card">
              {isDebug
                ? <DebugBar debug={debug} active={isActive} busy={busy} onAction={onAction} />
                : (
                  <header class="pane-head">
                    <h2>Running line <span class="faint mono" data-testid="trace-line">{trace?.line ?? '—'}</span></h2>
                    <span class="spacer" />
                    <span class="muted small" data-testid="trace-state">
                      {trace?.stopped ? (isActive ? 'Tracing stopped — full speed' : 'Tracing was stopped during the run') : isActive ? 'Tracing…' : 'Last line reached'}
                    </span>
                    {!trace?.stopped && isActive && (
                      <button type="button" class="btn btn-ghost btn-sm" data-testid="trace-stop"
                        onClick={() => void api['runs.stopTrace']({ id: runId }).then((r) => { if (!r.ok) toast.info('Could not stop tracing (the run may have just finished).') }, (e) => toast.error(errorText(e)))}>
                        Stop tracing
                      </button>
                    )}
                  </header>
                )}
              {recentLines.length > 0 && (
                <div class="line-history" data-testid="line-history" title="Lines reached, newest last (hit counts are sampled)">
                  <span class="faint small">Lines</span>
                  {recentLines.map((l, i) => (
                    <button type="button" key={`${l}-${i}`} class={`lh-chip ${i === recentLines.length - 1 ? 'is-last' : ''}`} title={`line ${l} · seen ${stream.lineHits.get(l) ?? 1}×`} onClick={() => reveal_(l)}>{l}</button>
                  ))}
                </div>
              )}
              <SourcePane
                lines={traceLines} language={editorLanguage(lang)} debugMode={isDebug} current={currentLine} running={!!running} visited={visited}
                hits={stream.lineHits} breakpoints={bps} onBreakpoints={changeBreakpoints} controller={srcCtl}
              />
            </section>
            {isDebug && (
              <Inspector
                debug={debug} lang={lang} breakpoints={bps} lines={traceLines} onReveal={reveal_}
                onRemoveBreakpoint={(l) => changeBreakpoints(bps.filter((x) => x !== l))} onClearBreakpoints={() => changeBreakpoints([])}
              />
            )}
          </div>
        )}

        <div class={`panes ${layout === 'stack' ? 'layout-stack' : layout === 'out' ? 'layout-out' : ''}`}>
          <section class="pane">
            <header class="pane-head">
              <h2><span class="dot" style="background:var(--ok)" />Standard output</h2>
              <span class="spacer" />
              <button type="button" class="btn btn-ghost btn-sm" title="Copy stdout" onClick={() => void copy(out, 'Standard output')}><Icon name="copy" /> <span>Copy</span></button>
              <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Download stdout" onClick={() => void download('stdout')}><Icon name="download" /></button>
            </header>
            <OutputPane
              buffer={out} version={version} follow={follow} onFollowChange={setFollow} wrap={wrap} timestamps={timestamps} query={query}
              filterOnly={filterOnly} currentLine={current?.pane === 'out' ? current.line : null} controller={outCtl} label="Standard output"
            />
          </section>
          {showErr && (
            <section class="pane pane-err">
              <header class="pane-head">
                <h2><span class="dot" />Standard error</h2>
                <span class="spacer" />
                <button type="button" class="btn btn-ghost btn-sm" title="Copy stderr" onClick={() => void copy(err, 'Standard error')}><Icon name="copy" /> <span>Copy</span></button>
                <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Download stderr" onClick={() => void download('stderr')}><Icon name="download" /></button>
              </header>
              <OutputPane
                buffer={err} version={version} follow={follow} onFollowChange={setFollow} wrap={wrap} timestamps={timestamps} query={query}
                filterOnly={filterOnly} currentLine={current?.pane === 'err' ? current.line : null} controller={errCtl} label="Standard error" class="vlog-err"
              />
            </section>
          )}
        </div>
      </div>

      <footer class={`run-foot st-foot-${isActive ? 'active' : st}`} data-testid="run-foot">
        <span class={`st ${chipClass}`}>{chipLabel}</span>
        <span>
          {isActive
            ? (isDebug ? debugLabel(debug, true) : queued ? 'Waiting in the queue' : 'Running')
            : st === 'success' ? 'Finished successfully'
              : st === 'failed' ? 'Failed'
                : st === 'cancelled' ? 'Stopped'
                  : st === 'timed_out' ? 'Stopped by the timeout'
                    : st === 'interrupted' ? 'Interrupted' : chipLabel}
          {!isActive && exit !== null && <> · exit code <strong>{exit}</strong></>}
          {duration !== '—' && <> · {duration}</>}
        </span>
        {showError && <span class="muted clamp-1">· {errorText_}</span>}
        <span class="spacer" />
        <span class="faint small">{out.count.toLocaleString()} lines out · {err.count.toLocaleString()} err</span>
      </footer>
    </div>
  )
}
