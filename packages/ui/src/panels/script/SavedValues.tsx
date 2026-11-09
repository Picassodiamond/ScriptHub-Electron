/** The bottom panel under a script: saved values (presets and recent runs) side by side, highlighted where they differ. */
import { Icon } from '../../components/Icon'
import { api, confirm, errorText, openTab, toast, useApi, type PanelProps } from '../../core'
import { bumpSaved, currentSource, requestLoad, runTabTitle, savedBump } from './store'

export function SavedValues({ tab }: PanelProps) {
  const id = tab.id!
  const grid = useApi('presets.grid', { scriptId: id }, [id, savedBump.value])
  const detail = useApi('scripts.get', { id }, [id])
  const cols: any[] = grid.data?.columns ?? []
  const rows: any[] = grid.data?.rows ?? []
  const valid = detail.data?.script.metaValid !== false
  const current = currentSource.value[id]

  const runSaved = async (key: string) => {
    try {
      const r = await api['runs.start']({ scriptId: id, fromPreset: key })
      if (r.ok) {
        openTab({ kind: 'run', id: r.runId, title: runTabTitle(r.runId), params: { scriptId: id } })
        bumpSaved()
      } else toast.warning(r.warnings[0] ?? r.hostError ?? 'Those saved values could not be run; load them to fix them.')
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  const remove = async (c: any) => {
    if (!(await confirm({ message: `Delete the preset “${c.name}”?`, danger: true, confirmLabel: 'Delete' }))) return
    try {
      await api['presets.delete']({ scriptId: id, slug: c.key })
      bumpSaved()
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  if (grid.error) return <div class="empty"><p class="error-text">{grid.error}</p></div>
  return (
    <div class="pgrid-wrap" data-saved-values>
      {cols.length ? (
        <table class="pgrid">
          <thead>
            <tr>
              <th class="pg-param">Parameter</th>
              {cols.map((c) => (
                <th key={c.key} class={`pg-col ${c.kind === 'recent' ? 'is-recent' : ''} ${current === c.key ? 'is-current' : ''}`} data-col={c.key}>
                  <div class="pgc-name"><Icon name={c.kind === 'recent' ? 'clock' : 'save'} small /><span class="clamp-1" title={c.name}>{c.name}</span></div>
                  <div class="pgc-when">{c.kind === 'recent' && c.run_id && c.name !== c.run_id ? `${c.run_id} · ` : ''}{String(c.saved_at ?? '').slice(0, 16)}</div>
                  <div class="pgc-actions">
                    {valid && <button type="button" class="btn btn-ghost btn-sm" data-act="run" onClick={() => void runSaved(c.key)} title="Run with these values">Run</button>}
                    {valid && <button type="button" class="btn btn-ghost btn-sm" data-act="load" onClick={() => requestLoad(id, c.key)} title="Load into the run form to change them first">Load</button>}
                    {c.kind === 'preset' && (
                      <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="delete" onClick={() => void remove(c)} title="Delete this preset" aria-label={`Delete ${c.name}`}><Icon name="trash" /></button>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} class={r.varies ? 'varies' : ''}>
                <th class="pg-param">{r.label}{r.name !== 'host' && <div class="faint mono small">{r.name}</div>}</th>
                {r.cells.map((cell: any, i: number) => <td key={i} class={`${cell.changed ? 'is-changed' : ''} ${cell.muted ? 'is-muted' : ''}`}>{cell.text}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div class="empty">
          <Icon name="sliders" />
          <h2>Nothing saved yet</h2>
          <p>Every run remembers its values; name a set with “+ Save current values as preset…” on the Run tab.</p>
        </div>
      )}
    </div>
  )
}
