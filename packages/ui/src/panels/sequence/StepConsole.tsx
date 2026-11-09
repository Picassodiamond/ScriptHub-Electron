/**
 * The console of one step's run, live and without polling: `runs.status` seeds the output, then `runs.watch` pushes
 * `run.output` / `run.status` events from where it stopped. (Replaces the embedded execution_console iframe.)
 */
import type { RunStatus } from '@scripthub/protocol'
import { useEffect, useRef, useState } from 'preact/hooks'
import { Icon } from '../../components/Icon'
import { api, confirm, errorText, onEvent, openTab, toast } from '../../core'
import { statusClass } from './RunsTable'

const MAX_CHARS = 2_000_000

const cap = (s: string): string => (s.length > MAX_CHARS ? s.slice(s.length - MAX_CHARS) : s)

export function StepConsole({ runId, title }: { runId: string; title?: string }) {
  const [st, setSt] = useState<Omit<RunStatus, 'stdout' | 'stdout_next' | 'stderr' | 'stderr_next' | 'debug'> | null>(null)
  const [out, setOut] = useState('')
  const [err, setErr] = useState('')
  const [error, setError] = useState<string | null>(null)
  const body = useRef<HTMLDivElement>(null)
  const follow = useRef(true)

  useEffect(() => {
    let live = true
    setSt(null); setOut(''); setErr(''); setError(null)
    follow.current = true
    const offs = onEvent('run.output', (p) => {
      if (!live || p.id !== runId) return
      if (p.stdout) setOut((o) => cap(o + p.stdout))
      if (p.stderr) setErr((o) => cap(o + p.stderr))
    })
    const offst = onEvent('run.status', (p) => { if (live && p.id === runId) setSt(p) })
    void (async () => {
      try {
        const s = await api['runs.status']({ id: runId, out: 0, err: 0 })
        if (!live) return
        const { stdout, stderr, stdout_next, stderr_next, debug: _d, ...rest } = s
        setSt(rest)
        setOut(cap(stdout))
        setErr(cap(stderr))
        if (s.active) await api['runs.watch']({ id: runId, out: stdout_next, err: stderr_next })
      } catch (e) {
        if (live) setError(errorText(e))
      }
    })()
    return () => {
      live = false
      offs()
      offst()
      void api['runs.unwatch']({ id: runId }).catch(() => undefined)
    }
  }, [runId])

  useEffect(() => {
    const el = body.current
    if (el && follow.current) el.scrollTop = el.scrollHeight
  }, [out, err])

  const stop = async () => {
    if (!(await confirm({ message: 'Stop this step?', danger: true, confirmLabel: 'Stop' }))) return
    try { await api['runs.stop']({ id: runId }) } catch (e) { toast.error(errorText(e)) }
  }

  return (
    <div class="seq-console-body" data-testid="step-console">
      <div class="seq-console-head">
        {st && <span class={statusClass({ status: st.status })}>{st.status_label}</span>}
        <span class="mono small faint clamp-1" title={runId}>{runId}</span>
        {st && <span class="small muted">{st.duration}{st.exit_code !== null && st.exit_code !== undefined ? ` · exit ${st.exit_code}` : ''}</span>}
        <span class="spacer" />
        {st?.active && <button type="button" class="btn btn-sm btn-danger" onClick={() => void stop()}><Icon name="stop" /> Stop</button>}
        <button type="button" class="btn btn-ghost btn-sm" title="Open this run in its own tab" onClick={() => openTab({ kind: 'run', id: runId, title: title ?? runId })}>
          <Icon name="external" /> Open run
        </button>
      </div>
      {error && <div class="flash flash-error"><span>{error}</span></div>}
      {st?.error && <div class="small error-text seq-console-error">{st.error}</div>}
      <div
        class="seq-console-out" ref={body}
        onScroll={(e) => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24 }}
      >
        {out || err ? (
          <>
            {out && <pre class="out out-stdout" data-stream="stdout">{out}</pre>}
            {err && <pre class="out out-stderr" data-stream="stderr">{err}</pre>}
          </>
        ) : <p class="muted small">{st?.active ? 'No output yet…' : st ? 'No output.' : 'Loading…'}</p>}
      </div>
    </div>
  )
}
