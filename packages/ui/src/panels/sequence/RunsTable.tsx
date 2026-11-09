import { openTab } from '../../core'

type Dict = Record<string, any>

export const statusClass = (r: { status?: string; paused?: boolean }): string => `st st-${r.paused ? 'paused' : r.status}`

export function openSequenceRun(id: string): void {
  openTab({ kind: 'sequence-run', id, title: id })
}

/** The table of sequence runs (templates/runner/_sequence_runs.html). */
export function RunsTable({ runs, showName = false }: { runs: Dict[]; showName?: boolean }) {
  return (
    <div class="table-wrap">
      <table class="table table-dense">
        <thead>
          <tr><th>Run</th>{showName && <th>Sequence</th>}<th>Status</th><th class="num">Steps</th><th class="hide-sm">Started</th><th class="num">Duration</th></tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td class="mono small"><a href="#" onClick={(e) => { e.preventDefault(); openSequenceRun(r.id) }}>{r.id}</a></td>
              {showName && <td class="strong">{r.name}</td>}
              <td><span class={statusClass(r)}>{r.status_label}</span></td>
              <td class="num mono small">{r.done ?? 0}/{(r.steps ?? []).length}</td>
              <td class="small muted mono nowrap hide-sm">{r.started_display}</td>
              <td class="num mono small">{r.duration}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
