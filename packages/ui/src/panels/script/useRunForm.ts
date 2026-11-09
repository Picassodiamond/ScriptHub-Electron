/**
 * The Run form's state and actions (Django: run.html + script_start + preset_views). Lives in the page, not in the
 * Run tab, so Ctrl+Enter / `r` / Quick run work whichever right-hand tab is showing.
 */
import type { RunForm } from '@scripthub/protocol'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { api, confirm, errorText, openTab, toast } from '../../core'
import { bumpSaved, newToken, runTabTitle, setCurrentSource } from './store'
import { initialValues, postValues, type FieldLike, type RunValue } from './validate'

export type Mode = 'normal' | 'trace' | 'debug'

export interface RunFormState {
  form: RunForm | null
  loading: boolean
  loadError: string | null
  values: Record<string, RunValue>
  host: string
  mode: Mode
  errors: Record<string, string>
  hostError: string | null
  warnings: string[]
  /** names the user changed (kept when the form is reloaded after a metadata change) */
  touched: Set<string>
  busy: boolean
  setValue(name: string, v: RunValue): void
  setHost(h: string): void
  setMode(m: Mode): void
  /** Load values: '' = last run else defaults, '-' = defaults, '@n' = a recent run, otherwise a preset slug. */
  load(key?: string, keepTouched?: boolean): Promise<void>
  /** Reload after a metadata change, keeping what the user typed. */
  reload(): Promise<void>
  start(mode?: Mode): Promise<boolean>
  savePreset(name: string): Promise<boolean>
  renamePreset(slug: string, name: string): Promise<boolean>
  deletePreset(slug: string, name: string): Promise<void>
}

interface Options {
  id: string
  /** Called before starting: save unsaved script edits. Return false to cancel the run. */
  beforeRun?: () => Promise<boolean>
}

export function useRunForm({ id, beforeRun }: Options): RunFormState {
  const [form, setForm] = useState<RunForm | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, RunValue>>({})
  const [host, setHost] = useState('local')
  const [mode, setMode] = useState<Mode>('normal')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [hostError, setHostError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const touched = useRef(new Set<string>())
  const token = useRef(newToken())
  const latest = useRef({ form, values, host, mode, id, beforeRun })
  latest.current = { form, values, host, mode, id, beforeRun }
  const seq = useRef(0)

  const load = useCallback(async (key = '', keepTouched = false) => {
    const n = ++seq.current
    setLoading(true)
    try {
      const f = await api['runs.form']({ scriptId: id, preset: key })
      if (n !== seq.current) return
      const fresh = initialValues(f.fields as any)
      // keep what the user typed in fields that still exist (a metadata change reloads the form)
      const kept = latest.current.form && keepTouched ? latest.current.values : null
      if (kept) for (const name of touched.current) if (name in fresh && name in kept) fresh[name] = kept[name]
      if (!keepTouched) touched.current.clear()
      setForm(f)
      setValues(fresh)
      setHost(f.host)
      setErrors({})
      setHostError(null)
      setWarnings(f.warnings)
      setLoadError(f.blocked)
      if (!f.modesSupported) setMode('normal')
      token.current = newToken()
      if (f.source) setCurrentSource(id, f.source.key)
    } catch (e) {
      if (n === seq.current) setLoadError(errorText(e))
    } finally {
      if (n === seq.current) setLoading(false)
    }
  }, [id])

  useEffect(() => {
    touched.current.clear()
    void load('')
  }, [id, load])

  const reload = useCallback(() => load(latest.current.form?.source?.key ?? '', true), [load])

  const setValue = useCallback((name: string, v: RunValue) => {
    touched.current.add(name)
    setValues((cur) => ({ ...cur, [name]: v }))
    setErrors((cur) => {
      if (!(name in cur)) return cur
      const { [name]: _gone, ...rest } = cur
      return rest
    })
  }, [])

  const refreshLists = useCallback(async () => {
    try {
      const l = await api['presets.list']({ scriptId: latest.current.id })
      setForm((f) => (f ? { ...f, presets: l.presets, recent: l.recent } : f))
    } catch { /* the lists refresh on the next load */ }
  }, [])

  const start = useCallback(async (m?: Mode): Promise<boolean> => {
    const cur = latest.current
    if (!cur.form || cur.form.blocked) return false
    setBusy(true)
    try {
      if (cur.beforeRun && !(await cur.beforeRun())) return false
      const fields = cur.form.fields as unknown as FieldLike[]
      const r = await api['runs.start']({
        scriptId: cur.id, host: cur.host, values: postValues(fields, cur.values), mode: m ?? cur.mode, token: token.current,
      })
      if (r.ok) {
        token.current = newToken()
        setErrors({})
        setHostError(null)
        setWarnings([])
        openTab({ kind: 'run', id: r.runId, title: runTabTitle(r.runId), params: { scriptId: cur.id } })
        bumpSaved()
        void refreshLists()
        return true
      }
      setErrors(r.errors)
      setHostError(r.hostError)
      setWarnings(r.warnings)
      setForm((f) => (f ? { ...f, fields: r.fields } : f))
      return false
    } catch (e) {
      toast.error(errorText(e))
      return false
    } finally {
      setBusy(false)
    }
  }, [refreshLists])

  const savePreset = useCallback(async (name: string): Promise<boolean> => {
    const cur = latest.current
    if (!cur.form) return false
    try {
      const r = await api['presets.save']({ scriptId: cur.id, name, host: cur.host, values: postValues(cur.form.fields as unknown as FieldLike[], cur.values) })
      if (!r.ok) {
        toast.error(r.error)
        return false
      }
      toast.success(r.updated ? `Preset “${name}” updated.` : `Preset “${name}” saved.`)
      bumpSaved()
      await load(r.slug)
      return true
    } catch (e) {
      toast.error(errorText(e))
      return false
    }
  }, [load])

  const renamePreset = useCallback(async (slug: string, name: string): Promise<boolean> => {
    try {
      const r = await api['presets.rename']({ scriptId: latest.current.id, slug, newName: name })
      if (!r.ok) {
        toast.error(r.error)
        return false
      }
      toast.success('Preset renamed.')
      bumpSaved()
      await load(r.slug)
      return true
    } catch (e) {
      toast.error(errorText(e))
      return false
    }
  }, [load])

  const deletePreset = useCallback(async (slug: string, name: string) => {
    if (!(await confirm({ message: `Delete the preset “${name}”?`, danger: true, confirmLabel: 'Delete' }))) return
    try {
      await api['presets.delete']({ scriptId: latest.current.id, slug })
      bumpSaved()
      await load('-')
    } catch (e) {
      toast.error(errorText(e))
    }
  }, [load])

  return {
    form, loading, loadError, values, host, mode, errors, hostError, warnings, touched: touched.current, busy,
    setValue, setHost: (h) => { setHost(h); setHostError(null) }, setMode, load, reload, start, savePreset, renamePreset, deletePreset,
  }
}
