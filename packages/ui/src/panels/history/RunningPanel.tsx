/** "Running" on top of History: queued and running executions and sequences, updated by pushed events. */
import type { RunningPanel as RunningData } from '@scripthub/protocol'
import { Icon } from '../../components/Icon'
import { api, confirm, errorText, openTab, toast } from '../../core'
import { liveDuration } from './format'

export function RunningPanel({ running, now, reload }: { running: RunningData; now: number; reload: () => void }) {
  if (!running.active.length && !running.activeSeqs.length) return null

  const stopRun = async (r: any) => {
    if (!(await confirm({ title: 'Stop execution', message: `Stop ${r.script_name ?? r.id}?`, confirmLabel: 'Stop', danger: true }))) return
    try {
      await api['runs.stop']({ id: r.id })
      toast.info('Stop requested.')
    } catch (e) {
      toast.error(errorText(e))
    }
    reload()
  }
  const stopSeq = async (r: any) => {
    if (!(await confirm({ title: 'Stop sequence', message: 'Stop this sequence? The running steps are stopped and the rest are skipped.', confirmLabel: 'Stop', danger: true }))) return
    try {
      const res = await api['sequences.stop']({ id: r.id })
      if (res.ok) toast.info('Stop requested.')
      else toast.warning(res.error ?? 'This sequence is not running.')
    } catch (e) {
      toast.error(errorText(e))
    }
    reload()
  }
  const openRun = (r: any) => openTab({ kind: 'run', id: r.id, title: r.script_name ?? r.id, params: { scriptId: r.script_id } })
  const openSeq = (r: any) => openTab({ kind: 'sequence-run', id: r.id, title: r.name ?? r.id })

  return (
    <section class="panel" data-testid="running-panel" data-active-count={running.activeTotal}>
      <div class="panel-head"><h2>Running <span class="count-pill">{running.activeTotal}</span></h2></div>
      <div class="table-wrap">
        <table class="table">
          <tbody>
            {running.activeSeqs.map((r: any) => (
              <tr key={r.id} class="hist-seq" data-run={r.id}>
                <td class="mono small"><a href="#" onClick={(e) => { e.preventDefault(); openSeq(r) }}>{r.id}</a></td>
                <td class="strong"><Icon name="sequence" small class="hist-seq-icon" /> {r.name}</td>
                <td class="small muted hide-sm">{r.done ?? 0}/{(r.steps ?? []).length} steps</td>
                <td><span class={`st st-${r.paused ? 'paused' : r.status}`}>{r.status_label}</span></td>
                <td class="num mono small">{liveDuration(r, now)}</td>
                <td class="actions">
                  <div class="btn-row">
                    <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Diagram and consoles" aria-label="Open the sequence run" onClick={() => openSeq(r)}><Icon name="sequence" /></button>
                    <button type="button" class="btn btn-danger btn-sm" onClick={() => void stopSeq(r)}><Icon name="stop" class="i-fill" /> Stop</button>
                  </div>
                </td>
              </tr>
            ))}
            {running.active.map((r: any) => (
              <tr key={r.id} data-run={r.id}>
                <td class="mono small"><a href="#" onClick={(e) => { e.preventDefault(); openRun(r) }}>{r.id}</a></td>
                <td class="strong">{r.script_name}</td>
                <td class="small muted hide-sm">{r.host}</td>
                <td>
                  <span class={`st st-${r.status}`}>{r.status_label}{r.position ? ` · #${r.position}` : ''}</span>
                  {r.debug && <> <span class="badge badge-warn" title="Step-debug run">debug</span></>}
                </td>
                <td class="num mono small">{liveDuration(r, now)}</td>
                <td class="actions">
                  <div class="btn-row">
                    <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Console" aria-label="Open the console" onClick={() => openRun(r)}><Icon name="terminal" /></button>
                    <button type="button" class="btn btn-danger btn-sm" onClick={() => void stopRun(r)}><Icon name="stop" class="i-fill" /> Stop</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
