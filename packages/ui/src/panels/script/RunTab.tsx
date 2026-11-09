/** The Run tab of the right column: values source, run form, preset box, Run button and mode (Django run.html). */
import { useState } from 'preact/hooks'
import { Icon } from '../../components/Icon'
import { Field } from './Field'
import type { RunFormState } from './useRunForm'
import { setCurrentSource } from './store'
import { useUid } from '../../core/ids'

const NEW = '+'

export function RunTab({ id, run, onReset }: { id: string; run: RunFormState; onReset(): void }) {
  const { form } = run
  const uid = useUid('run')
  const formId = `${uid}-form`
  const [naming, setNaming] = useState<string | null>(null) // the name being typed for a new preset
  const [renaming, setRenaming] = useState<string | null>(null)

  if (run.loading && !form) return <div class="panel"><div class="panel-body muted">Loading…</div></div>
  if (!form) return <div class="flash flash-error"><span>{run.loadError ?? 'The run form could not be loaded.'}</span></div>
  if (form.blocked) {
    return (
      <div>
        <div class="flash flash-error"><span>{form.blocked}</span></div>
        <p class="help">Fix the metadata block at the top of the script (or in the Overview tab), then save.</p>
      </div>
    )
  }

  const source = form.source
  const preset = source?.kind === 'preset' ? source : null
  const pickValue = !source || source.kind === 'defaults' ? '-' : source.key
  const hasErrors = Object.keys(run.errors).length > 0 || !!run.hostError

  const onPick = (v: string) => {
    if (v === NEW) {
      setNaming(preset?.label ?? '')
      return
    }
    setNaming(null)
    void run.load(v)
  }
  const saveNew = async () => {
    const name = (naming ?? '').trim()
    if (!name) return
    if (await run.savePreset(name)) setNaming(null)
  }

  return (
    <div data-run-tab>
      {hasErrors && <div class="flash flash-error notes" role="alert"><span>{run.hostError ?? 'Please correct the highlighted fields.'}</span></div>}
      {run.warnings.map((w) => <div class="flash flash-warning notes" key={w}><span>{w}</span></div>)}

      <div class="values-bar" aria-label="Load values">
        <Icon small class="faint" name={source?.kind === 'recent' ? 'clock' : source?.kind === 'preset' ? 'save' : 'sliders'} />
        <select class="input input-sm" aria-label="Load values from" id={`${uid}-preset`} value={pickValue} onChange={(e) => onPick((e.target as HTMLSelectElement).value)}>
          <option value="-">Defaults</option>
          {form.recent.length > 0 && (
            <optgroup label="Recent runs">
              {form.recent.map((r: any) => <option key={r.key} value={r.key}>{r.label} · {r.when}</option>)}
            </optgroup>
          )}
          {form.presets.length > 0 && (
            <optgroup label="Presets">
              {form.presets.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
            </optgroup>
          )}
          <option value={NEW}>+ Save current values as preset…</option>
        </select>
      </div>

      {naming !== null && (
        <section class="panel" data-new-preset>
          <div class="panel-body preset-box">
            <div class="inline-form">
              <input
                class="input input-sm grow" type="text" maxLength={60} value={naming} autoFocus placeholder="Preset name (an existing name updates that preset)" aria-label="Preset name"
                onInput={(e) => setNaming((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void saveNew() } else if (e.key === 'Escape') setNaming(null) }}
              />
              <button type="button" class="btn btn-sm btn-primary" disabled={!naming.trim()} onClick={() => void saveNew()}>Save</button>
              <button type="button" class="btn btn-sm" onClick={() => setNaming(null)}>Cancel</button>
            </div>
            {form.hasPassword && <div class="help">Passwords are never saved.</div>}
          </div>
        </section>
      )}

      <form class="panel" id={formId} noValidate onSubmit={(e) => { e.preventDefault(); void run.start() }}>
        <div class="panel-body">
          <div class={`field host-field ${run.hostError ? 'has-error' : ''}`}>
            <label class="field-label" for={`${uid}-host`}>Host</label>
            <select class="input" id={`${uid}-host`} name="host" value={run.host} onChange={(e) => run.setHost((e.target as HTMLSelectElement).value)}>
              {form.hosts.map((h) => <option key={h} value={h}>{h === 'local' ? 'local' : `${h} (ssh)`}</option>)}
            </select>
            {run.hostError && <div class="field-error">{run.hostError}</div>}
          </div>
          {(form.fields as any[]).map((f) => (
            <Field key={f.name} scope={`${uid}-`} f={f} value={run.values[f.name]} error={run.errors[f.name]} hint={run.touched.has(f.name)} onChange={(v) => run.setValue(f.name, v)} />
          ))}
          {!form.fields.length && <div class="muted small">This script has no parameters.</div>}
        </div>
      </form>

      {preset && (
        <section class="panel" data-preset-box>
          <div class="panel-body preset-box">
            <div class="inline-form">
              <input class="input input-sm grow" type="text" maxLength={60} aria-label="Rename preset" value={renaming ?? preset.label}
                onInput={(e) => setRenaming((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && renaming?.trim()) { e.preventDefault(); void run.renamePreset(preset.key, renaming).then(() => setRenaming(null)) } }} />
              <button type="button" class="btn btn-sm" disabled={!renaming?.trim() || renaming === preset.label}
                onClick={() => void run.renamePreset(preset.key, renaming!).then((ok) => ok && setRenaming(null))}>Rename</button>
              <button type="button" class="btn btn-ghost btn-icon btn-sm btn-del" title="Delete preset" aria-label="Delete preset"
                onClick={() => void run.deletePreset(preset.key, preset.label)}><Icon name="trash" /></button>
            </div>
            <div class="inline-form">
              <button type="button" class="btn btn-sm" data-update-preset onClick={() => void run.savePreset(preset.label)} title="Store the values shown now in this preset">Update with the current values</button>
            </div>
          </div>
        </section>
      )}

      <div class="side-bar">
        <button type="submit" form={formId} class="btn btn-primary play" disabled={run.busy} data-run>
          <Icon name="play" /> Run <kbd>Ctrl</kbd><kbd>↵</kbd>
        </button>
        {form.modesSupported && (
          <div class="seg run-modes" role="radiogroup" aria-label="Run mode">
            <label class="seg-btn" title="Full speed"><input type="radio" name="mode" value="normal" checked={run.mode === 'normal'} onChange={() => run.setMode('normal')} />Normal</label>
            <label class="seg-btn" title="Highlight the running line"><input type="radio" name="mode" value="trace" checked={run.mode === 'trace'} onChange={() => run.setMode('trace')} /><Icon small name="eye" />Trace</label>
            <label class="seg-btn" title="Pause on line 1; step, breakpoints, variables"><input type="radio" name="mode" value="debug" checked={run.mode === 'debug'} onChange={() => run.setMode('debug')} /><Icon small name="bug" />Debug</label>
          </div>
        )}
        <button type="button" class="btn btn-ghost btn-sm" title="Discard changes and load the defaults" onClick={() => { setNaming(null); setRenaming(null); onReset(); setCurrentSource(id, '-') }}>Reset</button>
      </div>
    </div>
  )
}
