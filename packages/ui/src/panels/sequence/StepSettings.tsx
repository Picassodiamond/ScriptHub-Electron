/** A step's settings in the right-hand column: where its values come from, host, join, and the parameter values (templates/runner/sequence_step.html). */
import type { StepForm } from '@scripthub/protocol'
import { useEffect, useMemo, useState } from 'preact/hooks'
import { Icon } from '../../components/Icon'
import { api, errorText, openTab, shell, toast, useApi } from '../../core'
import { ParamField } from './ParamField'
import { useUid } from '../../core/ids'
import { valuesOfFields } from './geometry'

export function StepSettings({ slug, stepId, onSaved }: { slug: string; stepId: string; onSaved(): void }) {
  const { data, error, loading, reload } = useApi('sequences.step', { slug, stepId }, [slug, stepId])
  if (error) return <div class="flash flash-error"><span>{error}</span></div>
  if (!data) return <p class="muted small seq-pad">{loading ? 'Loading…' : ''}</p>
  return <StepForm key={`${stepId}:${data.step?.preset ?? ''}`} form={data} slug={slug} stepId={stepId} onSaved={() => { onSaved(); void reload() }} />
}

function StepForm({ form, slug, stepId, onSaved }: { form: StepForm; slug: string; stepId: string; onSaved(): void }) {
  const uid = useUid('step')
  const [source, setSource] = useState(form.source || 'values')
  const [host, setHost] = useState(form.host || '')
  const [join, setJoin] = useState(form.join || 'all')
  const [values, setValues] = useState<Record<string, any>>(() => valuesOfFields(form.fields))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => { setErrors({}); setFormError(null) }, [source])

  const script = form.script
  const inFolder = useMemo(() => !!script && (shell.value?.tree ?? []).some((g) => g.scripts.some((s) => s.id === script.id)), [script])

  if (!script) {
    return <div class="flash flash-error"><span>The script of step {form.n} was not found ({String(form.step?.path || form.step?.script || '')}). Open its folder, or remove the step.</span></div>
  }
  if (form.problem) {
    return <div class="flash flash-error"><span>{script.name}: {script.metaError ?? form.problem}</span></div>
  }

  const save = async (e: Event) => {
    e.preventDefault()
    setSaving(true)
    setErrors({})
    setFormError(null)
    try {
      const r = await api['sequences.saveStep']({ slug, stepId, source, host, join, ...(source === 'values' ? { values } : {}) })
      if (r.ok) {
        toast.success('Step saved.')
        onSaved()
      } else {
        setErrors(r.errors ?? {})
        setFormError(r.error ?? (Object.keys(r.errors ?? {}).length ? 'Please correct the highlighted fields.' : null))
      }
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const paramFields = form.fields.filter((f) => f.p?.type !== 'password')
  const hasPassword = form.hasPassword

  return (
    <form class="seq-embed-form" onSubmit={save} data-testid="step-form" noValidate>
      <p class="small seq-step-script">
        <a href="#" class="strong" onClick={(e) => { e.preventDefault(); if (inFolder) openTab({ kind: 'script', id: script.id, title: script.name }); else toast.error('That script is not in the open folder.') }}>{script.name}</a>{' '}
        <span class="mono faint">{script.relative}</span>
      </p>
      {formError && <div class="flash flash-error notes"><span>{formError}</span></div>}
      {form.warnings.map((w) => <div class="flash flash-warning notes" key={w}><span>{w}</span></div>)}

      <div class="field">
        <label class="field-label" for={`${uid}-source`}>Values</label>
        <select class="input" id={`${uid}-source`} value={source} onChange={(e) => setSource((e.target as HTMLSelectElement).value)}>
          <option value="values">Saved with this step (below)</option>
          {form.presets.length > 0 && (
            <optgroup label="Use a preset of the script (stays up to date)">
              {form.presets.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
            </optgroup>
          )}
        </select>
        {hasPassword && <div class="help">Passwords are never saved: they are asked for when the sequence runs.</div>}
      </div>

      <div class="field">
        <label class="field-label" for={`${uid}-host`}>Host</label>
        <select class="input" id={`${uid}-host`} value={host} onChange={(e) => setHost((e.target as HTMLSelectElement).value)}>
          <option value="">Script default ({form.defaultHost})</option>
          {form.hosts.map((h) => <option key={h} value={h}>{h === 'local' ? 'local' : `${h} (ssh)`}</option>)}
        </select>
      </div>

      {form.incoming > 1 && (
        <div class="field">
          <span class="field-label">{form.incoming} arrows lead here</span>
          <div class="seg run-modes" role="radiogroup" aria-label="When several arrows lead here">
            <label class="seg-btn"><input type="radio" name="join" value="all" checked={join !== 'any'} onChange={() => setJoin('all')} />Wait for all</label>
            <label class="seg-btn"><input type="radio" name="join" value="any" checked={join === 'any'} onChange={() => setJoin('any')} />Start after the first</label>
          </div>
          <div class="help">Wait for all: the step runs when every arrow applies, otherwise it is skipped. Start after the first: it runs as soon as one arrow applies.</div>
        </div>
      )}

      {source === 'values' && (
        <div id="step-values">
          {paramFields.map((f) => (
            <ParamField key={f.name} scope={`${uid}-`} f={f} value={values[f.name]} error={errors[f.name]} onChange={(v) => setValues((o) => ({ ...o, [f.name]: v }))} />
          ))}
          {!paramFields.length && <p class="muted small">{hasPassword ? 'Only password parameters: they are asked for when the sequence runs.' : 'This script has no parameters to set.'}</p>}
        </div>
      )}

      <div class="form-actions">
        <button class="btn btn-primary" type="submit" disabled={saving}><Icon name="save" /> Save step</button>
      </div>
    </form>
  )
}
