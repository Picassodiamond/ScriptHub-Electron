/** The Overview tab: the script's settings form (Django script_detail.html) and its recent runs. */
import { useUid } from '../../core/ids'
import type { InfoForm, ScriptDetail } from '@scripthub/protocol'
import { Icon } from '../../components/Icon'
import { api, errorText, hostInfo, openTab, toast } from '../../core'
import { runTabTitle } from './store'

export interface OverviewProps {
  detail: ScriptDetail
  info: InfoForm
  readOnly: boolean
  onChange(next: InfoForm): void
}

/** The hint about the name of a platform key. */
const label = (choices: Array<[string, string]>, key: string) => choices.find(([k]) => k === key)?.[1] ?? key

export function OverviewTab({ detail, info, readOnly, onChange }: OverviewProps) {
  const uid = useUid('ov')
  const s = detail.script
  const set = (k: keyof InfoForm, v: any) => onChange({ ...info, [k]: v })
  const dis = readOnly || !!detail.loadError
  const pick = async () => {
    try {
      const dir = await api['workspace.pickFolder']({})
      if (dir) set('working_directory', dir)
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  return (
    <div data-overview>
      {s.idConflict && (
        <div class="flash flash-warning notes" role="status">
          <span>This file has the same id as <span class="mono">{s.idConflict}</span> (a copy?). It gets a new id the next time it is saved.</span>
        </div>
      )}
      {(detail.loadError || s.metaError) && <div class="flash flash-error notes"><span>{detail.loadError ?? s.metaError}</span></div>}
      <section class="panel">
        <div class="panel-body cfg">
          <div class="form-grid">
            <div class="field"><label class="field-label" for={`${uid}-name`}>Name</label>
              <input class="input" id={`${uid}-name`} value={info.name} maxLength={120} placeholder={s.name} disabled={dis} onInput={(e) => set('name', (e.target as HTMLInputElement).value)} /></div>
            <div class="field"><label class="field-label" for={`${uid}-category`}>Category</label>
              <input class="input" id={`${uid}-category`} value={info.category} maxLength={60} placeholder={s.category} disabled={dis} onInput={(e) => set('category', (e.target as HTMLInputElement).value)} /></div>
          </div>
          <div class="field"><label class="field-label" for={`${uid}-description`}>Description</label>
            <textarea class="input" id={`${uid}-description`} rows={2} maxLength={2000} value={info.description} disabled={dis} onInput={(e) => set('description', (e.target as HTMLTextAreaElement).value)} /></div>
          <div class="form-grid">
            <div class="field"><label class="field-label" for={`${uid}-interpreter`}>Interpreter</label>
              <input class="input mono" id={`${uid}-interpreter`} value={info.interpreter} placeholder={s.interpreter || 'default'} disabled={dis} onInput={(e) => set('interpreter', (e.target as HTMLInputElement).value)} /></div>
            <div class="field"><label class="field-label" for={`${uid}-host`}>Host</label>
              <select class="input" id={`${uid}-host`} value={info.host} disabled={dis} onChange={(e) => set('host', (e.target as HTMLSelectElement).value)}>
                {detail.hosts.map((h) => <option key={h} value={h}>{h === 'local' ? 'local' : `${h} (ssh)`}</option>)}
              </select></div>
          </div>
          <div class="field"><label class="field-label" for={`${uid}-cwd`}>Working directory</label>
            <div class="inline-form">
              <input class="input mono" id={`${uid}-cwd`} value={info.working_directory} placeholder="script folder / ssh home" disabled={dis} onInput={(e) => set('working_directory', (e.target as HTMLInputElement).value)} />
              {hostInfo.value?.desktop && !dis && <button type="button" class="btn btn-icon" title="Browse…" aria-label="Browse for a folder" onClick={() => void pick()}><Icon name="folder" /></button>}
            </div></div>
          <div class="field"><label class="field-label" for={`${uid}-env`}>Environment</label>
            <textarea class="input mono" id={`${uid}-env`} rows={2} spellcheck={false} placeholder="NAME=value" value={info.environment} disabled={dis} onInput={(e) => set('environment', (e.target as HTMLTextAreaElement).value)} /></div>
          <div class="field field-last"><span class="field-label">Platforms</span>
            <div class="check-row">
              {detail.platformChoices.map(([key]) => (
                <label class="check" key={key}>
                  <input type="checkbox" value={key} checked={info.platforms.includes(key)} disabled={dis}
                    onChange={(e) => set('platforms', (e.target as HTMLInputElement).checked ? [...info.platforms, key] : info.platforms.filter((p) => p !== key))} />
                  <span>{label(detail.platformChoices, key)}</span>
                </label>
              ))}
            </div></div>
        </div>
      </section>

      {detail.runs.length > 0 && (
        <section class="panel">
          <div class="panel-head">
            <h2>Runs</h2><span class="spacer" />
            <button type="button" class="btn btn-ghost btn-sm" onClick={() => openTab({ kind: 'history', params: { script: s.id } })}>History</button>
          </div>
          <ul class="quick">
            {detail.runs.map((r: any) => (
              <li key={r.id}>
                <span class={`dot st-${r.status}`} title={r.status_label} />
                <a class="q-name plain mono small" href="#" title={r.status_label}
                  onClick={(e) => { e.preventDefault(); openTab({ kind: 'run', id: r.id, title: runTabTitle(r.id), params: { scriptId: s.id } }) }}>{r.id}</a>
                <span class="faint small mono">{r.duration}</span>
                <span class="faint small nowrap">{r.ago}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
