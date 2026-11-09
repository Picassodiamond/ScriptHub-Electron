/** The runs list: what is running now and the latest runs; a click opens the run as a tab. */
import { Icon } from '../components/Icon'
import { api, openTab, runCommand, shell, useEvent, usePoll } from '../core'
import { useEffect, useState } from 'preact/hooks'

export function RunsSide() {
  const [active, setActive] = useState<any[]>([])
  const [seqs, setSeqs] = useState<any[]>([])
  const recent: any[] = (shell.value?.runs ?? []).filter((r: any) => !['queued', 'running'].includes(r.status)).slice(0, 25)

  const load = async () => {
    try {
      const r = await api['runs.running']({})
      setActive(r.active ?? [])
      setSeqs(r.activeSeqs ?? [])
    } catch { /* keep the last list */ }
  }
  useEvent('runs.changed', () => void load()) // started / finished anywhere
  usePoll(load, 30000, true) // safety net
  useEffect(() => { void load() }, [])

  const openRun = (r: any) => openTab({ kind: 'run', id: r.id, title: r.script_name ?? r.id, params: { scriptId: r.script_id } })
  const row = (r: any) => (
    <a key={r.id} href="#" class="tree-item" title={r.id} onClick={(e) => { e.preventDefault(); openRun(r) }}>
      <span class={`dot st-${r.status}`} />
      <span class="ti-name">{r.script_name ?? r.id}</span>
      <span class="faint small">{r.ago ?? ''}</span>
    </a>
  )

  return (
    <>
      <div class="side-head">
        <div class="side-title-block"><span class="side-title">Runs</span></div>
        <div class="side-actions">
          <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Open the run history" aria-label="Open the run history" onClick={() => void runCommand('view.runs')}><Icon name="list" /></button>
        </div>
      </div>
      <div class="side-body">
        <div class="tree">
          {(active.length > 0 || seqs.length > 0) && (
            <div class="tree-group">
              <div class="tree-summary is-static">Running <span class="tree-count">{active.length + seqs.length}</span></div>
              <div class="tree-items">
                {active.map(row)}
                {seqs.map((s) => (
                  <a key={s.id} href="#" class="tree-item" onClick={(e) => { e.preventDefault(); openTab({ kind: 'sequence-run', id: s.id, title: s.name ?? s.id }) }}>
                    <Icon name="sequence" small /><span class="ti-name">{s.name ?? s.id}</span><span class="dot st-running" />
                  </a>
                ))}
              </div>
            </div>
          )}
          <div class="tree-group">
            <div class="tree-summary is-static">Recent <span class="tree-count">{recent.length}</span></div>
            <div class="tree-items">{recent.map(row)}</div>
          </div>
          {!recent.length && !active.length && <p class="tree-empty">Nothing has run yet.</p>}
        </div>
      </div>
    </>
  )
}
