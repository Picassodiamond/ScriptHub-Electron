/** One field of the Run form, by parameter type (port of templates/runner/_field.html). */
import { termsOfDefinition, termsOfParam } from './meta'
import { checkValue, type FieldLike, type RunValue } from './validate'

export interface FieldProps {
  f: FieldLike & { input_name: string }
  value: RunValue | undefined
  onChange(v: RunValue): void
  /** the engine's message for this field (after a failed start) */
  error?: string | null
  /** show the early hint (the user already touched the field) */
  hint: boolean
  /** id prefix unique to the page showing the field (several script pages are mounted at once) */
  scope?: string
}

export function fieldTerms(f: { p: Record<string, any> }): string[] {
  return [...new Set([...termsOfParam(f.p), ...termsOfDefinition(f.p)])]
}

export function Field({ f, value, onChange, error, hint, scope }: FieldProps) {
  const p = f.p
  const id = `${scope ?? ''}id_${f.name}`
  const early = hint ? checkValue(f, value) : null
  const message = error || early
  const disabled = f.locked
  const str = typeof value === 'string' ? value : value === undefined || Array.isArray(value) || typeof value === 'boolean' ? '' : String(value)
  const cls = `field ${message ? 'has-error' : ''} ${f.input === 'checkbox' ? 'field-check' : ''}`

  let control
  if (f.input === 'checkbox') {
    control = (
      <label class="check">
        <input type="checkbox" id={id} name={f.input_name} checked={!!value} disabled={disabled} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
        <span>{p.label}</span>
      </label>
    )
  } else {
    let input
    if (f.input === 'textarea') {
      input = <textarea class="input" rows={4} id={id} name={f.input_name} placeholder={p.placeholder ?? ''} value={str} disabled={disabled} onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)} />
    } else if (f.input === 'select') {
      input = (
        <select class="input" id={id} name={f.input_name} value={str} disabled={disabled} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
          {!p.required && <option value="">— none —</option>}
          {f.choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      )
    } else if (f.input === 'multiselect') {
      const sel = new Set(Array.isArray(value) ? value : [])
      input = (
        <div class="check-list" id={id}>
          {f.choices.map((c) => (
            <label class="check" key={c.value}>
              <input
                type="checkbox" name={f.input_name} value={c.value} checked={sel.has(c.value)} disabled={disabled}
                onChange={(e) => {
                  const next = new Set(sel)
                  if ((e.target as HTMLInputElement).checked) next.add(c.value)
                  else next.delete(c.value)
                  onChange(f.choices.map((x) => x.value).filter((v) => next.has(v)))
                }}
              />
              <span>{c.label}</span>
            </label>
          ))}
        </div>
      )
    } else if (f.input === 'number') {
      input = <input class="input" type="number" step={1} id={id} name={f.input_name} value={str} min={p.min ?? undefined} max={p.max ?? undefined} placeholder={p.placeholder ?? ''} disabled={disabled} onInput={(e) => onChange((e.target as HTMLInputElement).value)} />
    } else if (f.input === 'decimal') {
      input = <input class="input" type="text" inputMode="decimal" id={id} name={f.input_name} value={str} placeholder={p.placeholder ?? ''} disabled={disabled} onInput={(e) => onChange((e.target as HTMLInputElement).value)} />
    } else {
      input = <input class="input" type={f.input as any} id={id} name={f.input_name} value={str} placeholder={p.placeholder ?? ''} autocomplete="off" disabled={disabled} onInput={(e) => onChange((e.target as HTMLInputElement).value)} />
    }
    control = (
      <>
        <label class="field-label" for={id}>{p.label}{p.required && <span class="req" title="Required">*</span>}</label>
        {input}
      </>
    )
  }

  const ranged = (f.input === 'number' || f.input === 'decimal') && (p.min != null || p.max != null)
  return (
    <div class={cls} data-field={f.name} data-terms={fieldTerms(f).join(' ')}>
      {control}
      {p.help && <div class="help">{p.help}</div>}
      {ranged && <div class="help">Allowed range: {p.min ?? '…'} to {p.max ?? '…'}</div>}
      {f.locked && <div class="help">Fixed — not editable at run time.</div>}
      {message && <div class="field-error" role="alert">{message}</div>}
    </div>
  )
}
