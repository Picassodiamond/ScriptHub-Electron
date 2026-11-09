/**
 * Settings (the old Settings page): features, execution limits, retention, interpreters, SSH and environment, SSH hosts,
 * data, appearance and about. One form with a Save / Revert bar; validation runs while typing and the engine's errors
 * are shown at the field they belong to. Extras over the Django page: search, section navigation, per-section defaults,
 * import / export as JSON, "changed" markers and an unsaved draft that survives closing the tab.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { SettingsState } from '@scripthub/protocol'
import { Icon } from '../../components/Icon'
import { api, ask, errorText, readStore, refreshShell, registerPanel, renameTab, saveFile, toast, useApi, useCloseGuard, useEvent, writeStore, type PanelProps } from '../../core'
import {
  DRAFT_KEY, SECTIONS, changedFields, defaultsDraft, draftFromJson, draftToJson, exportSettings, fromForm, importSettings, isDirty,
  mapServerErrors, restoreSection, searchSections, toForm, validate, FIELDS_OF,
  type Draft, type SectionId,
} from './model'
import {
  AboutSection, AppearanceSection, DataSection, ExecutionSection, FeaturesSection, HostsSection, InterpretersSection, RetentionSection, SshSection,
  type Ctx,
} from './sections'
import './settings.css'

const TITLE = 'Settings'

function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text()
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result ?? ''))
    r.onerror = () => reject(r.error ?? new Error('Could not read the file.'))
    r.readAsText(file)
  })
}

function downloadJson(name: string, data: unknown): void {
  void saveFile(name, JSON.stringify(data, null, 2) + '\n', 'application/json')
}

function SettingsPanel({ tab, active }: PanelProps) {
  const info = useApi('app.info', {}, [], true)
  const platform = info.data?.platform ?? 'win32'

  const [state, setState] = useState<SettingsState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [base, setBase] = useState<Draft | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [serverErrors, setServerErrors] = useState<string[]>([])
  const [attempted, setAttempted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [restored, setRestored] = useState(false)
  const [query, setQuery] = useState('')
  const [current, setCurrent] = useState<SectionId>('features')
  const root = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const ready = useRef(false)

  // ------------------------------------------------------------- loading ---
  /** `initial`: set up the form (restoring an unsaved draft). Otherwise only refresh hosts and data, never the user's edits. */
  const load = async (mode: 'initial' | 'refresh' | 'reset') => {
    try {
      const s = await api['settings.get']({})
      setState(s)
      setLoadError(null)
      if (mode === 'refresh' && ready.current) return
      const baseline = fromForm(s.form)
      setBase(baseline)
      const stored = mode === 'initial' ? draftFromJson(readStore(DRAFT_KEY)) : null
      if (stored && isDirty(stored, baseline)) {
        setDraft(stored)
        setRestored(true)
      } else {
        setDraft(baseline)
        setRestored(false)
        writeStore(DRAFT_KEY, null)
      }
      setServerErrors([])
      setAttempted(false)
      ready.current = true
    } catch (e) {
      setLoadError(errorText(e))
    }
  }
  useEffect(() => { void load('initial') }, [])
  // The tab stays mounted while runs happen elsewhere, so the data sizes (and which Clear buttons work) go stale:
  // refresh them when the tab is shown again and when runs or the workspace change. Edits in the form are never touched.
  useEffect(() => { if (active && ready.current) void load('refresh') }, [active])
  useEvent('runs.changed', () => { if (ready.current) void load('refresh') })
  useEvent('workspace.changed', () => { if (ready.current) void load('refresh') })

  // ------------------------------------------------------------- derived ---
  const dirty = !!(draft && base && isDirty(draft, base))
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  const problems = useMemo(() => (draft ? validate(draft) : null), [draft])
  const changed = useMemo(() => (draft && base ? changedFields(draft, base) : new Set<never>()), [draft, base])
  const server = useMemo(() => mapServerErrors(serverErrors), [serverErrors])
  const matching = useMemo(() => searchSections(query), [query])
  const changesBySection = (id: SectionId) => FIELDS_OF[id].filter((f) => changed.has(f)).length
  const problemsOfSection = (id: SectionId) => !!problems && FIELDS_OF[id].some((f) => problems.fields[f])

  // ------------------------------------------------- unsaved-draft guard ---
  useEffect(() => {
    if (!draft || !base) return
    writeStore(DRAFT_KEY, dirty ? draftToJson(draft) : null)
  }, [draft, base, dirty])

  useEffect(() => {
    renameTab(tab.key, dirty ? `${TITLE} •` : TITLE)
  }, [dirty, tab.key])

  useEffect(() => {
    if (!dirty) return
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty])

  // every way of closing the tab asks first when there are unsaved changes
  useCloseGuard(tab.key, () => {
    if (!dirtyRef.current) return true
    return (async () => {
      const answer = await ask({
        title: 'Unsaved settings', message: 'Save the changed settings before closing?',
        confirmLabel: 'Save', altLabel: "Don't save", cancelLabel: 'Cancel',
      })
      if (answer === 'cancel') return false
      if (answer === 'alt') {
        writeStore(DRAFT_KEY, null)
        return true
      }
      return saveRef.current()
    })()
  })

  // -------------------------------------------------------- navigation ---
  const goTo = (id: SectionId) => {
    setCurrent(id)
    root.current?.querySelector(`[data-section="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const wanted = typeof tab.params?.section === 'string' ? (tab.params.section as SectionId) : null
  useEffect(() => {
    if (wanted && draft && SECTIONS.some((s) => s.id === wanted)) goTo(wanted)
  }, [wanted, tab.params?.nonce, !!draft])

  // ------------------------------------------------------------- actions ---
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d))

  /** Resolves true when the settings were saved. */
  const save = async (): Promise<boolean> => {
    if (!draft || !problems) return false
    setAttempted(true)
    if (problems.count) {
      toast.error(`Not saved: ${problems.count} setting${problems.count === 1 ? ' needs' : 's need'} fixing.`)
      root.current?.querySelector('.has-error, .rl-row.has-error')?.scrollIntoView({ block: 'center' })
      return false
    }
    setSaving(true)
    try {
      const r = await api['settings.save']({ form: toForm(draft) })
      if (r.ok) {
        const saved = fromForm(r.form)
        setBase(saved)
        setDraft(saved)
        setServerErrors([])
        setAttempted(false)
        setRestored(false)
        writeStore(DRAFT_KEY, null)
        toast.success('Settings saved. They apply to the next execution.')
        void info.reload()
        void refreshShell()
        void load('refresh')
        return true
      }
      setServerErrors(r.errors)
      root.current?.querySelector('.settings-errors')?.scrollIntoView({ block: 'start' })
      return false
    } catch (e) {
      toast.error(errorText(e))
      return false
    } finally {
      setSaving(false)
    }
  }
  const saveRef = useRef(save)
  saveRef.current = save

  const revert = () => {
    if (!base) return
    setDraft(base)
    setServerErrors([])
    setAttempted(false)
    setRestored(false)
    writeStore(DRAFT_KEY, null)
  }

  const restore = (section: SectionId) => {
    setDraft((d) => (d ? restoreSection(d, section, platform) : d))
    setServerErrors([])
    toast.info(`${SECTIONS.find((s) => s.id === section)!.title}: built-in values put back. Press Save to keep them.`)
  }

  const restoreAll = () => {
    setDraft(defaultsDraft(platform))
    setServerErrors([])
    toast.info('All built-in values put back. Press Save to keep them.')
  }

  const doExport = () => {
    if (!draft) return
    downloadJson('scripthub-settings.json', exportSettings(draft))
  }

  const doImport = async (file: File | undefined) => {
    if (!file || !draft) return
    try {
      const { draft: next, applied, ignored } = importSettings(JSON.parse(await readFileText(file)), draft)
      setDraft(next)
      setServerErrors([])
      toast.success(`Imported ${applied.length} setting${applied.length === 1 ? '' : 's'} from ${file.name}${ignored.length ? ` (ignored: ${ignored.join(', ')})` : ''}. Press Save to apply them.`)
    } catch (e) {
      toast.error(e instanceof SyntaxError ? `${file.name} is not valid JSON.` : errorText(e))
    } finally {
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      if (dirty && !saving) void save()
    } else if (e.key === 'Escape' && query) setQuery('')
  }

  // ---------------------------------------------------------------- view ---
  if (loadError && !state) {
    return (
      <div class="page settings-page">
        <div class="flash flash-error"><span>Could not load the settings: {loadError}</span></div>
        <button type="button" class="btn" onClick={() => void load('initial')}>Try again</button>
      </div>
    )
  }
  if (!state || !draft || !base || !problems) return <div class="page settings-page"><p class="muted">Loading settings…</p></div>

  const ctx: Ctx = { draft, set, problems, attempted, server, changed: changed as Set<any>, query, platform, restore }
  const nChanges = changed.size
  const visible = SECTIONS.filter((s) => matching.has(s.id))
  const shows = (id: SectionId) => matching.has(id)

  return (
    <div class="page settings-page" ref={root} onKeyDown={onKeyDown as any}>
      <div class="settings-head">
        <h1>Settings</h1>
        <label class="searchbox" title="Search the settings (Esc clears)">
          <Icon name="search" />
          <input type="search" placeholder="Search settings…" aria-label="Search settings" value={query} onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} />
        </label>
        <div class="settings-tools">
          <button type="button" class="btn btn-sm btn-ghost" title="Load settings from a JSON file (not saved until you press Save)" onClick={() => fileInput.current?.click()}><Icon name="up" /> Import</button>
          <button type="button" class="btn btn-sm btn-ghost" title="Save the settings as a JSON file" onClick={doExport}><Icon name="download" /> Export</button>
          <input ref={fileInput} type="file" accept=".json,application/json" hidden aria-label="Import settings file" onChange={(e) => void doImport((e.currentTarget as HTMLInputElement).files?.[0])} />
        </div>
      </div>

      {restored && (
        <div class="flash flash-info settings-banner" role="status">
          <span>Unsaved changes from your last visit were restored.</span>
          <span class="spacer" />
          <button type="button" class="btn btn-sm" onClick={revert}>Discard them</button>
        </div>
      )}

      {serverErrors.length > 0 && (
        <div class="flash flash-error settings-errors" role="alert">
          <div><strong>Not saved.</strong><ul class="err-list">{serverErrors.map((e, i) => <li key={i}>{e}</li>)}</ul></div>
        </div>
      )}

      <div class="settings-layout">
        <nav class="settings-nav" aria-label="Settings sections">
          {visible.map((s) => {
            const n = changesBySection(s.id)
            return (
              <button key={s.id} type="button" class={current === s.id ? 'is-active' : ''} aria-current={current === s.id ? 'true' : undefined} onClick={() => goTo(s.id)}>
                <Icon name={s.icon} /> {s.title}
                <span class="nav-flag">
                  {problemsOfSection(s.id) && (attempted || n > 0) && <span class="dot-bad" title="Needs fixing" />}
                  {n > 0 && <span class="count-pill" title={`${n} unsaved change${n === 1 ? '' : 's'}`}>{n}</span>}
                </span>
              </button>
            )
          })}
          <p class="help">Changes apply to the next execution; no restart needed.</p>
        </nav>

        <div class="settings-body">
          {visible.length === 0 && <div class="settings-empty muted">No settings match “{query}”. <button type="button" class="btn btn-sm btn-ghost" onClick={() => setQuery('')}>Clear search</button></div>}
          {shows('features') && <FeaturesSection ctx={ctx} />}
          {shows('execution') && <ExecutionSection ctx={ctx} />}
          {shows('retention') && <RetentionSection ctx={ctx} />}
          {shows('interpreters') && <InterpretersSection ctx={ctx} />}
          {shows('ssh') && <SshSection ctx={ctx} />}
          {shows('hosts') && <HostsSection hosts={state.sshHosts} reload={() => load('refresh')} />}
          {shows('data') && <DataSection state={state} reload={() => load('refresh')} onCleared={async (kind) => { if (kind === 'settings' || kind === 'all') await load('reset') }} />}
          {shows('appearance') && <AppearanceSection />}
          {shows('about') && <AboutSection info={info.data} />}

          <div class="form-actions sticky-actions settings-actions">
            <button type="button" class="btn btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
              <Icon name="save" /> {saving ? 'Saving…' : 'Save settings'}
            </button>
            <button type="button" class="btn btn-ghost" disabled={!dirty || saving} onClick={revert}>Revert</button>
            <span class={`st-state${dirty ? ' is-dirty' : ''}`} role="status">
              {dirty ? `${nChanges} unsaved change${nChanges === 1 ? '' : 's'}` : 'All changes saved'}
            </span>
            <span class="spacer" />
            <button type="button" class="btn btn-ghost btn-sm" title="Put every setting back to its built-in value (not saved until you press Save)" onClick={restoreAll}>Restore all defaults</button>
          </div>
        </div>
      </div>
    </div>
  )
}

registerPanel('settings', SettingsPanel)
