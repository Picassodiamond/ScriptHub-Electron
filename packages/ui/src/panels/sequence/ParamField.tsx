/** One parameter field of a step's values form (templates/runner/_field.html). Controlled by the parent's `values`. */
type Dict = Record<string, any>

export function ParamField({ f, value, error, onChange, scope }: { f: Dict; value: any; error?: string | null; onChange(v: any): void; scope?: string }) {
  const p = f.p ?? {}
  const id = `${scope ?? ''}seqf_${f.name}`
  const locked = !!f.locked
  const text = (e: Event) => onChange((e.target as HTMLInputElement).value)
  const choices: Array<{ value: string; label: string }> = f.choices ?? []
  const selected: string[] = Array.isArray(value) ? value : []

  let control
  if (f.input === 'checkbox') {
    control = (
      <label class="check">
        <input type="checkbox" id={id} checked={!!value} disabled={locked} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
        <span>{p.label}</span>
      </label>
    )
  } else if (f.input === 'textarea') {
    control = <textarea class="input" rows={4} id={id} value={value ?? ''} placeholder={p.placeholder ?? ''} disabled={locked} onInput={text} />
  } else if (f.input === 'select') {
    control = (
      <select class="input" id={id} value={value ?? ''} disabled={locked} onChange={text}>
        {!p.required && <option value="">— none —</option>}
        {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select>
    )
  } else if (f.input === 'multiselect') {
    control = (
      <div class="check-list" id={id}>
        {choices.map((c) => (
          <label class="check" key={c.value}>
            <input
              type="checkbox" checked={selected.includes(c.value)} disabled={locked}
              onChange={(e) => onChange((e.target as HTMLInputElement).checked ? [...selected, c.value] : selected.filter((x) => x !== c.value))}
            />
            <span>{c.label}</span>
          </label>
        ))}
      </div>
    )
  } else if (f.input === 'number') {
    control = <input class="input" type="number" step="1" id={id} value={value ?? ''} min={p.min ?? undefined} max={p.max ?? undefined} placeholder={p.placeholder ?? ''} disabled={locked} onInput={text} />
  } else if (f.input === 'decimal') {
    control = <input class="input" type="text" inputMode="decimal" id={id} value={value ?? ''} placeholder={p.placeholder ?? ''} disabled={locked} onInput={text} />
  } else {
    control = <input class="input" type={f.input || 'text'} id={id} value={value ?? ''} placeholder={p.placeholder ?? ''} autocomplete="off" disabled={locked} onInput={text} />
  }

  return (
    <div class={`field ${error ? 'has-error' : ''} ${f.input === 'checkbox' ? 'field-check' : ''}`} data-field={f.name}>
      {f.input !== 'checkbox' && (
        <label class="field-label" for={id}>{p.label}{p.required && <span class="req" title="Required">*</span>}</label>
      )}
      {control}
      {p.help && <div class="help">{p.help}</div>}
      {(f.input === 'number' || f.input === 'decimal') && (p.min != null || p.max != null) && (
        <div class="help">Allowed range: {p.min ?? '…'} to {p.max ?? '…'}</div>
      )}
      {locked && <div class="help">Fixed — not editable at run time.</div>}
      {error && <div class="field-error">{error}</div>}
    </div>
  )
}
