/** The Parameters tab: the definitions the run form is built from (Django script_parameters.html + param_editor.js). */
import { useMemo, useState } from 'preact/hooks'
import { Icon } from '../../components/Icon'
import { confirm } from '../../core'
import { termsOfDraft, checkDrafts, fromDraft, newDraft, summaryOf, type ParamDraft, type TypeInfo } from './paramModel'

export interface ParametersProps {
  drafts: ParamDraft[]
  info: Record<string, TypeInfo>
  readOnly: boolean
  /** messages from the engine after a failed save */
  errors: string[]
  onChange(next: ParamDraft[]): void
}

function Row({ children, label, wide }: { children: any; label: string; wide?: boolean }) {
  return <div class={`field ${wide ? 'field-wide' : ''}`}><label class="field-label">{label}</label>{children}</div>
}

function Card({ d, info, set, disabled }: { d: ParamDraft; info: Record<string, TypeInfo>; set(p: Partial<ParamDraft>): void; disabled: boolean }) {
  const allowed = info[d.type]?.allowed ?? []
  const isBool = d.type === 'boolean'
  const text = (k: keyof ParamDraft, ph = '', cls = '') => (
    <input class={`input ${cls}`} type="text" autocomplete="off" placeholder={ph} value={String(d[k] ?? '')} disabled={disabled} onInput={(e) => set({ [k]: (e.target as HTMLInputElement).value } as any)} />
  )
  return (
    <div class="pe-card">
      <div class="form-grid">
        <Row label="Name (used by the script)">{text('name', 'e.g. backup_path', 'mono')}</Row>
        <Row label="Label">{text('label', 'Shown on the form')}</Row>
        <Row label="Type">
          <select class="input" value={d.type} disabled={disabled} onChange={(e) => set({ type: (e.target as HTMLSelectElement).value })}>
            {Object.entries(info).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </Row>
        {!isBool && <Row label="Default value">{text('def', 'Default value')}<div class="help">Multi-select: comma-separated values.</div></Row>}
        {isBool && <div class="field field-check"><label class="check"><input type="checkbox" checked={d.defBool} disabled={disabled} onChange={(e) => set({ defBool: (e.target as HTMLInputElement).checked })} /><span>Checked by default</span></label></div>}
        <Row label="Help text" wide>{text('help', 'Help text under the field')}</Row>
        <Row label="Placeholder">{text('placeholder', 'Placeholder')}</Row>
        <div class="field field-check">
          {!isBool && <label class="check"><input type="checkbox" checked={d.required} disabled={disabled} onChange={(e) => set({ required: (e.target as HTMLInputElement).checked })} /><span>Required</span></label>}
          <label class="check"><input type="checkbox" checked={d.editable} disabled={disabled} onChange={(e) => set({ editable: (e.target as HTMLInputElement).checked })} /><span>Editable at run time</span></label>
        </div>
        {allowed.includes('choices') && (
          <Row label="Choices" wide>
            <textarea class="input" rows={3} placeholder="one per line:  value  or  value|Label" value={d.choices} disabled={disabled} onInput={(e) => set({ choices: (e.target as HTMLTextAreaElement).value })} />
          </Row>
        )}
        {allowed.includes('min') && (
          <div class="form-grid field-wide"><Row label="Minimum">{text('min')}</Row><Row label="Maximum">{text('max')}</Row></div>
        )}
        {allowed.includes('min_length') && (
          <div class="form-grid field-wide"><Row label="Min length">{text('min_length')}</Row><Row label="Max length">{text('max_length')}</Row></div>
        )}
        {allowed.includes('pattern') && <Row label="Validation pattern" wide>{text('pattern', 'Regular expression (must match the whole value)', 'mono')}</Row>}
        <Row label="Pass to script as">
          <select class="input" value={d.pass_as} disabled={disabled} onChange={(e) => set({ pass_as: (e.target as HTMLSelectElement).value })}>
            <option value="flag">Option flag (--name value)</option>
            <option value="positional">Positional argument</option>
            <option value="env">Environment variable</option>
          </select>
        </Row>
        {d.pass_as === 'flag' && <Row label="Flag">{text('arg', '--option-name', 'mono')}<div class="help">Blank = --name-with-hyphens.</div></Row>}
        {d.pass_as === 'positional' && <Row label="Position">{text('position', '1, 2, …')}</Row>}
        {d.pass_as === 'env' && <Row label="Variable name">{text('env_name', 'VARIABLE_NAME', 'mono')}<div class="help">Blank = NAME in upper case.</div></Row>}
      </div>
    </div>
  )
}

export function ParametersTab({ drafts, info, readOnly, errors, onChange }: ParametersProps) {
  const [open, setOpen] = useState<Set<number>>(new Set())
  const problems = useMemo(() => checkDrafts(drafts, info), [drafts, info])
  const toggle = (uid: number, on?: boolean) => setOpen((cur) => {
    const next = new Set(cur)
    if (on ?? !next.has(uid)) next.add(uid)
    else next.delete(uid)
    return next
  })
  const patch = (uid: number, p: Partial<ParamDraft>) => onChange(drafts.map((d) => (d.uid === uid ? { ...d, ...p } : d)))
  const move = (i: number, by: -1 | 1) => {
    const j = i + by
    if (j < 0 || j >= drafts.length) return
    const next = drafts.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  const remove = async (d: ParamDraft) => {
    if (!(await confirm({ message: 'Delete this parameter? It is removed when you save.', danger: true, confirmLabel: 'Delete' }))) return
    onChange(drafts.filter((x) => x.uid !== d.uid))
  }
  const add = () => {
    let n = drafts.length + 1
    const names = new Set(drafts.map((d) => d.name))
    while (names.has(`param_${n}`)) n++
    const d = newDraft(`param_${n}`)
    onChange([...drafts, d])
    toggle(d.uid, true)
  }

  return (
    <div data-parameters>
      {errors.length > 0 && (
        <div class="flash flash-error notes" role="alert"><div><strong>Not saved.</strong><ul class="err-list">{errors.map((e) => <li key={e}>{e}</li>)}</ul></div></div>
      )}
      <section class="panel">
        <div class="panel-head">
          <h2>Definitions <span class="count-pill">{drafts.length}</span></h2><span class="spacer" />
          {!readOnly && <button type="button" class="btn btn-ghost btn-icon btn-sm" id="add-param" title="Add a parameter" aria-label="Add a parameter" onClick={add}><Icon name="plus" /></button>}
        </div>
        {drafts.length === 0 && <div class="panel-body muted small" id="param-empty">None.</div>}
        {drafts.length > 0 && (
          <table id="param-list" class="table pe-table">
            {drafts.map((d, i) => {
              const o = fromDraft(d, info)
              const sm = summaryOf(o)
              const isOpen = open.has(d.uid)
              const issues = problems.get(d.uid)
              return (
                <tbody class="pe-item" key={d.uid} data-terms={termsOfDraft(d, info).join(' ')} data-param={d.name}>
                  <tr class={`pe-row ${isOpen ? 'is-open' : ''}`} onClick={(e) => { if (!(e.target as HTMLElement).closest('button')) toggle(d.uid) }}>
                    <td class="pe-c-num">{i + 1}</td>
                    <td class="pe-c-label">{sm.label}</td>
                    <td class="pe-c-name mono">{sm.name}</td>
                    <td class="pe-c-type">{sm.type}</td>
                    <td class="pe-c-def mono">{sm.def}</td>
                    <td class="pe-c-req">{sm.req}</td>
                    <td class="pe-c-rt">{sm.rt}</td>
                    <td class="pe-c-pass mono">{sm.pass}</td>
                    <td class="pe-actions">
                      <div class="btn-row">
                        {issues && <span class="error-text" title={issues.join('\n')} aria-label="Has problems">!</span>}
                        {!readOnly && <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Move up" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><Icon small name="up" /></button>}
                        {!readOnly && <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Move down" aria-label="Move down" disabled={i === drafts.length - 1} onClick={() => move(i, 1)}><Icon small name="down" /></button>}
                        <button type="button" class={`btn btn-ghost btn-icon btn-sm ${isOpen ? 'is-on' : ''}`} title={isOpen ? 'Close' : 'Edit'} aria-label={isOpen ? 'Close' : 'Edit'} onClick={() => toggle(d.uid)}><Icon small name="edit" /></button>
                        {!readOnly && <button type="button" class="btn btn-ghost btn-icon btn-sm btn-del" title="Delete parameter" aria-label="Delete parameter" onClick={() => void remove(d)}><Icon small name="trash" /></button>}
                      </div>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr class="pe-edit">
                      <td colSpan={9}>
                        {issues && <ul class="err-list error-text small" data-issues>{issues.map((m) => <li key={m}>{m}</li>)}</ul>}
                        <Card d={d} info={info} disabled={readOnly} set={(p) => patch(d.uid, p)} />
                      </td>
                    </tr>
                  )}
                </tbody>
              )
            })}
          </table>
        )}
      </section>
    </div>
  )
}
