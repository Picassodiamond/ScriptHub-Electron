/** The step debugger's toolbar and inspector (variables, call stack, breakpoints). */
import type { DebugState } from '@scripthub/protocol'
import type { JSX } from 'preact'
import { useRef } from 'preact/hooks'
import { Icon } from '../../components/Icon'

export type DebugAction = 'step' | 'continue' | 'pause' | 'detach' | 'stop'

export function debugLabel(d: DebugState | null, active: boolean): string {
  if (!d) return active ? 'Starting…' : 'Ended'
  switch (d.state) {
    case 'starting': return 'Starting…'
    case 'paused': return `Paused at line ${d.line}`
    case 'running': return 'Running…'
    case 'detached': return 'Detached — running at full speed'
    case 'ended': return 'Ended'
    default: return d.state
  }
}

/** Which buttons can be used in a debugger state. */
export function canDo(d: DebugState | null, active: boolean, busy: boolean): Record<DebugAction, boolean> {
  const paused = d?.state === 'paused'
  const running = d?.state === 'running'
  return { continue: paused && !busy, step: paused && !busy, pause: running && !busy, detach: (paused || running) && !busy, stop: active }
}

export function DebugBar({ debug, active, busy, onAction }: { debug: DebugState | null; active: boolean; busy: boolean; onAction(a: DebugAction): void }) {
  const can = canDo(debug, active, busy)
  const btn = (a: DebugAction, cls: string, icon: string, label: string, key: string, title: string, fill = false) => (
    <button type="button" class={`dbg-btn ${cls}`} data-dbg={a} title={title} disabled={!can[a]} onClick={() => onAction(a)}>
      <Icon name={icon} class={fill ? 'i-fill' : ''} /> <span class={a === 'detach' || a === 'stop' ? 'hide-sm' : ''}>{label}</span> {key && <kbd>{key}</kbd>}
    </button>
  )
  return (
    <div class="dbg-bar" role="toolbar" aria-label="Debugger">
      {btn('continue', 'dbg-continue', 'play', 'Continue', 'F5', 'Continue to the next breakpoint (F5)')}
      {btn('step', 'dbg-step', 'step', 'Step', 'F10', 'Step to the next line (F10)')}
      {btn('pause', 'dbg-pause', 'pause', 'Pause', 'F6', 'Pause at the next line (F6)', true)}
      <span class="dbg-sep" />
      {btn('detach', '', 'unplug', 'Detach', '', 'Detach: stop debugging and run at full speed')}
      {btn('stop', 'dbg-stop', 'stop', 'Stop', '', 'Stop the run (Shift+F5)', true)}
      <span class="dbg-state"><span id="dbg-state">{debugLabel(debug, active)}</span></span>
    </div>
  )
}

interface InspectorProps {
  debug: DebugState | null
  lang: string
  breakpoints: number[]
  lines: string[]
  onReveal(line: number): void
  onRemoveBreakpoint(line: number): void
  onClearBreakpoints(): void
}

export function Inspector({ debug, lang, breakpoints, lines, onReveal, onRemoveBreakpoint, onClearBreakpoints }: InspectorProps) {
  const prev = useRef<Record<string, string>>({})
  const state = debug?.state ?? 'starting'
  const paused = state === 'paused'
  const scopes: any[] = paused ? debug?.scopes ?? [] : []
  const hasVars = scopes.some((s) => (s.vars ?? []).length)
  const next: Record<string, string> = {}
  let varsBody: JSX.Element
  if (!paused) {
    varsBody = <p class="insp-empty">{state === 'running' ? 'Running… pause to inspect.' : state === 'starting' ? '' : 'Not paused.'}</p>
  } else if (!hasVars) {
    varsBody = <p class="insp-empty">{lang === 'python' ? 'No variables in this scope yet.' : 'Variables are shown for Python scripts.'}</p>
  } else {
    varsBody = (
      <table class="vars">
        <tbody>
          {scopes.flatMap((sc) => [
            scopes.length > 1 ? <tr class="v-scope" key={`h-${sc.name}`}><td colSpan={2}>{sc.name}</td></tr> : null,
            ...(sc.vars ?? []).map((v: any) => {
              const key = `${sc.name}:${v.name}`
              next[key] = v.value
              const changed = prev.current[key] !== undefined && prev.current[key] !== v.value
              return (
                <tr key={key} class={changed ? 'is-changed' : ''}>
                  <td class="v-name" title={`${v.name} : ${v.type}`}>{v.name}</td>
                  <td class="v-val">{v.value}<span class="v-type">{v.type}</span></td>
                </tr>
              )
            }),
          ])}
        </tbody>
      </table>
    )
  }
  if (paused) prev.current = next

  const stack: any[] = paused ? debug?.stack ?? [] : []
  const stackBody = !stack.length
    ? <p class="insp-empty">{paused && debug?.line ? `<script> · line ${debug.line}` : '—'}</p>
    : (
      <ul class="stack-list">
        {stack.map((f, i) => <li key={i} onClick={() => onReveal(f.line)}><span>{f.fn}</span><span class="s-line">:{f.line}</span></li>)}
      </ul>
    )

  return (
    <aside class="inspector" id="inspector" data-testid="inspector">
      <div class="insp-sec grow">
        <div class="insp-head">Variables <span class="spacer" /><span class="faint mono">{paused && debug?.line ? `line ${debug.line}` : ''}</span></div>
        <div class="insp-body" data-testid="dbg-vars">{varsBody}</div>
      </div>
      <div class="insp-sec">
        <div class="insp-head">Call stack</div>
        <div class="insp-body" style="max-height:140px" data-testid="dbg-stack">{stackBody}</div>
      </div>
      <div class="insp-sec">
        <div class="insp-head">Breakpoints <span class="spacer" />{breakpoints.length > 0 && <button type="button" class="btn btn-ghost btn-sm" onClick={onClearBreakpoints}>Clear all</button>}</div>
        <div class="insp-body" style="max-height:140px" data-testid="dbg-bps">
          {!breakpoints.length
            ? <p class="insp-empty">Click a line number to add one (F9 on the cursor line).</p>
            : (
              <ul class="bp-list">
                {breakpoints.map((n) => (
                  <li key={n}>
                    <span class="dot" /><span class="mono">{n}</span>
                    <span class="bp-code" onClick={() => onReveal(n)}>{(lines[n - 1] ?? '').trim()}</span>
                    <button type="button" title="Remove" aria-label={`Remove breakpoint ${n}`} onClick={() => onRemoveBreakpoint(n)}>×</button>
                  </li>
                ))}
              </ul>
            )}
        </div>
      </div>
    </aside>
  )
}
