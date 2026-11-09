/** New script (Django new_script.html): create a script with a starter and its metadata in the open folder, then open it. */
import { useEffect, useMemo, useState } from 'preact/hooks'
import { Icon } from '../../components/Icon'
import { api, closeTab, errorText, openTab, registerPanel, runCommand, toast, useCommand, type PanelProps } from '../../core'
import type { NewScriptOptions } from '@scripthub/protocol'

type Form = NewScriptOptions['form']

// the same rules as the engine (newScript.ts); the engine stays the judge
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/
const FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,60}$/

/** Early hints per field (empty = fine). */
export function checkForm(form: Form, maxDepth: number, languages: Array<[string, string]>): Partial<Record<keyof Form, string>> {
  const out: Partial<Record<keyof Form, string>> = {}
  const name = form.filename.trim()
  const ext = languages.map(([e]) => e).find((e) => name.toLowerCase().endsWith(e.toLowerCase()))
  const stem = ext && ext.toLowerCase() === form.language.toLowerCase() ? name.slice(0, -ext.length) : name
  if (!name) out.filename = 'Enter a file name.'
  else if (!NAME_RE.test(stem)) out.filename = 'Use letters, digits, “_”, “-” and “.”, starting with a letter or digit (up to 80 characters).'
  const sub = form.subfolder.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (form.subfolder.trim()) {
    const parts = sub.split('/').filter(Boolean)
    if (/^[A-Za-z]:/.test(form.subfolder.trim()) || form.subfolder.trim().startsWith('/') || form.subfolder.trim().startsWith('\\'))
      out.subfolder = 'Give the sub-folder relative to the open folder.'
    else if (parts.some((p) => p === '.' || p === '..' || !FOLDER_RE.test(p))) out.subfolder = 'Folder names use letters, digits, spaces, “_”, “-” and “.”; “..” is not allowed.'
    else if (parts.length > maxDepth) out.subfolder = `At most ${maxDepth} levels deep.`
  }
  if (form.category.length > 60) out.category = 'At most 60 characters.'
  if (form.name.length > 120) out.name = 'At most 120 characters.'
  return out
}

function NewScript({ tab, active }: PanelProps) {
  const from = tab.params.from as string | undefined
  const [opts, setOpts] = useState<NewScriptOptions | null>(null)
  const [blocked, setBlocked] = useState<string | null>(null)
  const [form, setForm] = useState<Form>({ language: '.py', filename: '', subfolder: '', name: '', category: '' })
  const [errors, setErrors] = useState<string[]>([])
  const [touched, setTouched] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    setOpts(null)
    setBlocked(null)
    api['newScript.options']({ from })
      .then((o) => { if (live) { setOpts(o); setForm(o.form) } })
      .catch((e) => { if (live) setBlocked(errorText(e)) })
    return () => { live = false }
  }, [from, tab.params.nonce])

  const hints = useMemo(() => (opts ? checkForm(form, opts.maxDepth, opts.languages) : {}), [form, opts])
  const set = (k: keyof Form, v: string) => {
    setForm((f) => ({ ...f, [k]: v }))
    setTouched((t) => new Set(t).add(k))
  }
  const hint = (k: keyof Form) => (touched.has(k) ? hints[k] : undefined)
  const invalid = Object.values(hints).some(Boolean)

  const target = useMemo(() => {
    const sub = form.subfolder.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const file = form.filename.trim()
    if (!file) return ''
    const withExt = file.toLowerCase().endsWith(form.language.toLowerCase()) ? file : file + form.language
    return (sub ? `${sub}/` : '') + withExt
  }, [form])

  const submit = async () => {
    setTouched(new Set(['filename', 'subfolder', 'category', 'name']))
    if (invalid || busy || !opts) return
    setBusy(true)
    setErrors([])
    try {
      const r = await api['newScript.create'](form)
      if (!r.ok) return setErrors(r.errors)
      toast.success('Script created.')
      const title = r.path.split(/[\\/]/).pop() ?? 'script'
      closeTab(tab.key)
      openTab({ kind: 'script', id: r.id, title, params: { view: 'run' } })
    } catch (e) {
      setErrors([errorText(e)])
    } finally {
      setBusy(false)
    }
  }
  useCommand('run.run', () => void submit(), active)

  if (blocked) {
    return (
      <div class="page page-narrow new-script-page">
        <div class="flash flash-error"><span>{blocked}</span></div>
        <button type="button" class="btn" onClick={() => void runCommand('file.openFolder')}><Icon name="folder-open" /> Open folder…</button>
      </div>
    )
  }
  if (!opts) return <div class="empty muted" style="margin:10vh auto">Loading…</div>

  const folderName = opts.folder.split(/[\\/]/).filter(Boolean).pop() ?? opts.folder
  return (
    <div class="page page-narrow new-script-page">
      {errors.length > 0 && (
        <div class="flash flash-error" role="alert"><div><strong>Not created.</strong><ul class="err-list">{errors.map((e) => <li key={e}>{e}</li>)}</ul></div></div>
      )}
      <form class="panel" id="new-form" noValidate onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <div class="panel-head"><h2>Create in <span class="mono" title={opts.folder}>{folderName}</span></h2></div>
        <div class="panel-body">
          <div class="form-grid">
            <div class={`field ${hint('filename') ? 'has-error' : ''}`}>
              <label class="field-label" for="n_file">File name</label>
              <input class="input mono" id="n_file" maxLength={80} placeholder="cleanup_logs" autoFocus required value={form.filename} onInput={(e) => set('filename', (e.target as HTMLInputElement).value)} />
              {hint('filename') && <div class="field-error">{hint('filename')}</div>}
            </div>
            <div class="field">
              <label class="field-label" for="n_lang">Language</label>
              <select class="input" id="n_lang" value={form.language} onChange={(e) => set('language', (e.target as HTMLSelectElement).value)}>
                {opts.languages.map(([ext, label]) => <option key={ext} value={ext}>{label} ({ext})</option>)}
              </select>
            </div>
            <div class={`field ${hint('subfolder') ? 'has-error' : ''}`}>
              <label class="field-label" for="n_sub">Sub-folder <span class="faint small">optional</span></label>
              <input class="input mono" id="n_sub" list="n_sub_list" placeholder="e.g. maintenance" value={form.subfolder} onInput={(e) => set('subfolder', (e.target as HTMLInputElement).value)} />
              <datalist id="n_sub_list">{opts.subFolders.map((f) => <option key={f} value={f} />)}</datalist>
              {hint('subfolder') ? <div class="field-error">{hint('subfolder')}</div> : <div class="help">Relative to the open folder, at most {opts.maxDepth} levels deep; created if it does not exist.</div>}
            </div>
            <div class={`field ${hint('category') ? 'has-error' : ''}`}>
              <label class="field-label" for="n_cat">Category <span class="faint small">optional</span></label>
              <input class="input" id="n_cat" list="n_cat_list" maxLength={60} placeholder="defaults to the folder name" value={form.category} onInput={(e) => set('category', (e.target as HTMLInputElement).value)} />
              <datalist id="n_cat_list">{opts.categories.map((c) => <option key={c} value={c} />)}</datalist>
            </div>
            <div class={`field field-wide ${hint('name') ? 'has-error' : ''}`}>
              <label class="field-label" for="n_name">Display name <span class="faint small">optional</span></label>
              <input class="input" id="n_name" maxLength={120} placeholder="from the file name" value={form.name} onInput={(e) => set('name', (e.target as HTMLInputElement).value)} />
            </div>
          </div>
          <p class="help" style="margin:0">The script starts with a few lines of example code and a metadata block at its top. Existing files are never overwritten. It then opens in the editor.</p>
        </div>
        <div class="panel-foot">
          <button class="btn btn-primary btn-sm" type="submit" disabled={busy} data-create><Icon name="plus" /> Create script <kbd>Ctrl</kbd><kbd>↵</kbd></button>
          <span class="faint small mono" title={opts.folder} data-target>{target ? `${opts.folder}${/[\\/]$/.test(opts.folder) ? '' : '/'}${target}` : opts.folder}</span>
        </div>
      </form>
    </div>
  )
}

registerPanel('new-script', NewScript)
