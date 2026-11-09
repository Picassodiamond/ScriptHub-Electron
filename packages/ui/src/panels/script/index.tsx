/**
 * The script page (Django: _script_base / _script_doc / script_detail / script_parameters / run). The centre is the
 * script in the editor; the right column has Overview, Parameters and Run; the saved-values grid is the bottom panel.
 * ONE Save (Ctrl+S) saves the script and whichever settings or parameter forms changed.
 */
import type { InfoForm, ScriptDetail, ScriptDoc } from '@scripthub/protocol'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Icon, Lang } from '../../components/Icon'
import {
  api, ask, confirm, errorText, forceCloseTab, hostInfo, openTab, readStore, refreshShell, registerPanel, renameTab, shell, side2On, toast,
  tabs, toggleSide2, useCloseGuard, useCommand, useEvent, writeStore, type PanelProps,
} from '../../core'
import { CodeEditor, languageFor, type EditorAdapter } from '../../editor'
import './script.css'
import { OverviewTab } from './OverviewTab'
import { ParametersTab } from './ParametersTab'
import { RunTab } from './RunTab'
import { SavedValues } from './SavedValues'
import { VersionsDialog } from './VersionsDialog'
import { blockOf, refLines } from './meta'
import { fromDraft, toDraft, type ParamDraft, type TypeInfo } from './paramModel'
import { loadRequest, setDirty } from './store'
import { useRunForm, type Mode } from './useRunForm'

type View = 'overview' | 'parameters' | 'run'
const VIEW_KEY = 'scripthub.rightTab'
const DRAFT_KEY = (id: string) => `scripthub.draft.${id}`

interface Draft { text: string; hash: string }

const readDraft = (id: string): Draft | null => {
  try {
    const d = JSON.parse(readStore(DRAFT_KEY(id)) ?? 'null')
    return d && typeof d.text === 'string' && typeof d.hash === 'string' ? d : null
  } catch {
    return null
  }
}
const writeDraft = (id: string, d: Draft | null): void => writeStore(DRAFT_KEY(id), d ? JSON.stringify(d) : null)

const snapshot = (drafts: ParamDraft[], types: Record<string, TypeInfo>): string => JSON.stringify(drafts.map((d) => fromDraft(d, types)))
const baseTitle = (t: string): string => t.replace(/^● /, '')
const isTyping = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null
  return !!el?.tagName && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || !!el.closest?.('.monaco-editor'))
}

function ScriptPage({ tab, active }: PanelProps) {
  const id = tab.id!
  const [detail, setDetail] = useState<ScriptDetail | null>(null)
  const [doc, setDoc] = useState<ScriptDoc | null>(null)
  const [error, setError] = useState<string | null>(null)

  // ---- script text
  const [text, setText] = useState('')
  const [base, setBase] = useState('')
  const [hash, setHash] = useState('')
  const [versions, setVersions] = useState<ScriptDoc['versions']>([])
  const [warning, setWarning] = useState<string | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [pendingDraft, setPendingDraft] = useState<Draft | null>(null)
  const adapter = useRef<EditorAdapter | null>(null)

  // ---- settings and parameter forms
  const [info, setInfo] = useState<InfoForm | null>(null)
  const [infoBase, setInfoBase] = useState('')
  const [drafts, setDrafts] = useState<ParamDraft[]>([])
  const [draftsBase, setDraftsBase] = useState('')
  const [infoErrors, setInfoErrors] = useState<string[]>([])
  const [paramErrors, setParamErrors] = useState<string[]>([])

  const [view, setViewState] = useState<View>(() => {
    const v = (tab.params.view as string) ?? readStore(VIEW_KEY)
    return v === 'overview' || v === 'parameters' || v === 'run' ? v : 'run'
  })
  const [saving, setSaving] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [refsLabel, setRefsLabel] = useState('')
  const [cursor, setCursor] = useState(1)
  const savingRef = useRef(false)
  const sticky = useRef<string[] | null>(null)
  const titleBase = useRef(baseTitle(tab.title))

  const setView = (v: View) => { setViewState(v); writeStore(VIEW_KEY, v) }
  const typeInfo = detail?.typeInfo ?? {}

  // ---- what is unsaved
  const scriptDirty = !!doc?.editor && text !== base
  const blockChanged = scriptDirty && blockOf(text) !== blockOf(base)
  const infoDirty = !!info && JSON.stringify(info) !== infoBase
  const paramsDirty = !!detail && snapshot(drafts, typeInfo) !== draftsBase
  const dirty = scriptDirty || infoDirty || paramsDirty
  const latest = useRef({ text, base, hash, scriptDirty, infoDirty, paramsDirty, dirty, info, drafts, id })
  latest.current = { text, base, hash, scriptDirty, infoDirty, paramsDirty, dirty, info, drafts, id }

  // ---- loading
  const apply = useCallback((d: ScriptDetail, c: ScriptDoc, force: boolean) => {
    const cur = latest.current
    setDetail(d)
    if (force || !(cur.infoDirty || cur.paramsDirty)) {
      setInfo(d.form)
      setInfoBase(JSON.stringify(d.form))
      const list = (d.params as Record<string, any>[]).map(toDraft)
      setDrafts(list)
      setDraftsBase(snapshot(list, d.typeInfo))
    }
    setDoc(c)
    setVersions(c.versions)
    if (force || !cur.scriptDirty) {
      const t = c.editor?.text ?? c.source.text
      setText(t)
      setBase(t)
      setHash(c.editor?.hash ?? '')
      adapter.current?.setValue(t)
      const draft = c.editor ? readDraft(d.script.id) : null
      setPendingDraft(draft && draft.hash === c.editor!.hash && draft.text !== t ? draft : null)
      if (draft && !(draft.hash === c.editor?.hash && draft.text !== t)) writeDraft(d.script.id, null)
    }
  }, [])

  const run = useRunForm({
    id,
    beforeRun: async () => (latest.current.dirty ? saveAll() : true),
  })

  const loadAll = useCallback(async (force: boolean, useId?: string) => {
    const sid = useId ?? latest.current.id
    try {
      const [d, c] = await Promise.all([api['scripts.get']({ id: sid }), api['scripts.doc']({ id: sid })])
      apply(d, c, force)
      setError(null)
    } catch (e) {
      setError(errorText(e))
    }
  }, [apply])

  useEffect(() => { void loadAll(true) }, [id, loadAll])
  useEvent('workspace.changed', () => { if (!savingRef.current) void loadAll(false) })

  // a request from the saved-values grid ("Load")
  const req = loadRequest.value
  const handled = useRef(0)
  useEffect(() => {
    if (!req || req.id !== id || req.nonce === handled.current) return
    handled.current = req.nonce
    setView('run')
    void run.load(req.key)
  }, [req?.nonce])

  // ---- tab title, dirty flag, guards
  // The shell renames script tabs to the script's name whenever it refreshes; put the dirty dot back each time.
  const liveTitle = tabs.value.find((t) => t.key === tab.key)?.title ?? tab.title
  useEffect(() => {
    const plain = baseTitle(liveTitle)
    titleBase.current = plain
    const want = `${dirty ? '● ' : ''}${plain}`
    if (liveTitle !== want) renameTab(tab.key, want)
  }, [dirty, liveTitle, tab.key])
  useEffect(() => {
    setDirty(id, dirty)
    return () => setDirty(id, false)
  }, [dirty, id])

  useEffect(() => {
    if (!dirty) return
    const guard = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty])

  // every way of closing the tab (x, middle-click, Ctrl+W, Close others / all) asks first when there are unsaved changes
  useCloseGuard(tab.key, () => {
    if (!latest.current.dirty) return true
    return (async () => {
      const answer = await ask({
        title: 'Unsaved changes', message: `Save the changes to ${titleBase.current || 'this script'} before closing?`,
        confirmLabel: 'Save', altLabel: "Don't save", cancelLabel: 'Cancel',
      })
      if (answer === 'cancel') return false
      if (answer === 'alt') {
        writeDraft(latest.current.id, null) // discarded on purpose: do not offer it back
        return true
      }
      return saveRef.current() // a failed save keeps the tab open, with its error shown
    })()
  })

  // a safety net for closing the tab with unsaved edits: the next time the script opens it offers them back
  useEffect(() => {
    if (!scriptDirty) return
    const t = setTimeout(() => writeDraft(latest.current.id, { text, hash }), 500)
    return () => clearTimeout(t)
  }, [text, hash, scriptDirty])

  // ---- saving
  const replaceTab = (newId: string) => {
    openTab({ kind: 'script', id: newId, title: titleBase.current, params: { ...tab.params } })
    forceCloseTab(tab.key) // the page moves to its new id: no question
  }

  const saveScript = async (force = false): Promise<boolean> => {
    const cur = latest.current
    const r = await api['editor.save']({ id: cur.id, text: cur.text, baseHash: cur.hash, force })
    if (!r.ok) {
      if (r.conflict) setConflict(r.error)
      else toast.error(r.error)
      return false
    }
    setConflict(null)
    setWarning(r.warning)
    if (r.warning) toast.warning(r.warning)
    setBase(cur.text)
    writeDraft(cur.id, null)
    try {
      const again = await api['editor.read']({ id: r.id })
      if (again.info) setHash(again.info.hash)
      setVersions(again.versions)
    } catch { /* the hash refreshes on the next load */ }
    return true
  }

  const saveAll = async (): Promise<boolean> => {
    if (savingRef.current) return false
    const cur = latest.current
    if (cur.scriptDirty && blockOf(cur.text) !== blockOf(cur.base) && (cur.infoDirty || cur.paramsDirty)) {
      toast.warning('The metadata block at the top of the script and the Overview / Parameters form were both changed. They are the same settings: undo one of them, then save.')
      return false
    }
    if (!cur.dirty) {
      toast.info('Nothing to save.')
      return true
    }
    savingRef.current = true
    setSaving(true)
    setInfoErrors([])
    setParamErrors([])
    try {
      let sid = cur.id
      let reload = false
      if (cur.scriptDirty) {
        if (!(await saveScript())) return false
        reload = blockOf(cur.text) !== blockOf(cur.base)
      }
      if (cur.infoDirty && cur.info) {
        const r = await api['scripts.saveInfo']({ id: sid, form: cur.info })
        if (!r.ok) {
          setInfoErrors(r.errors)
          setView('overview')
          return false
        }
        sid = r.id
        reload = true
      }
      if (cur.paramsDirty) {
        const r = await api['scripts.saveParameters']({ id: sid, parameters: cur.drafts.map((d) => fromDraft(d, typeInfo)) })
        if (!r.ok) {
          setParamErrors(r.errors)
          setView('parameters')
          return false
        }
        sid = r.id
        reload = true
      }
      if (reload) {
        await loadAll(true, sid)
        void run.reload()
        void refreshShell()
      }
      toast.success('Saved.')
      if (sid !== cur.id) replaceTab(sid)
      return true
    } catch (e) {
      toast.error(errorText(e))
      return false
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const saveRef = useRef(saveAll)
  saveRef.current = saveAll

  const overwrite = async () => {
    savingRef.current = true
    setSaving(true)
    try {
      if (await saveScript(true)) {
        toast.success('Saved (the changes on disk were replaced).')
        if (latest.current.dirty === false || blockOf(latest.current.text) !== blockOf(latest.current.base)) await loadAll(true)
      }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const reloadFromDisk = async () => {
    setConflict(null)
    writeDraft(id, null)
    await loadAll(true)
    toast.info('Reloaded from disk.')
  }

  const restore = async (version: string | null) => {
    const name = detail?.script.path.split(/[\\/]/).pop() ?? 'the script'
    const lost = scriptDirty ? ' Your unsaved changes in the editor are replaced.' : ''
    if (!(await confirm({ message: `Put back ${version ? 'this version' : 'the previous version'} of ${name}? What you have now is kept as a backup.${lost}`, confirmLabel: 'Restore' }))) return
    try {
      const r = await api['editor.restore'](version ? { id, version } : { id, previous: true })
      if (!r.ok) return void toast.error(r.error)
      setShowVersions(false)
      writeDraft(id, null)
      await loadAll(true, r.id)
      void run.reload()
      void refreshShell()
      toast.success('Restored.')
      if (r.id !== id) replaceTab(r.id)
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  // ---- parameter-to-line marking
  const showRefs = (terms: string[] | null, scroll: boolean) => {
    const ed = adapter.current
    if (!ed) return
    if (!terms) {
      ed.setLineDecorations('params', [])
      return setRefsLabel('')
    }
    const hits = refLines(latest.current.text, terms)
    ed.setLineDecorations('params', hits.map((line) => ({ line, kind: 'param', hover: `parameter ${terms[0]}` })))
    const first = terms.find((t) => t.length > 1) ?? terms[0]
    setRefsLabel(`${first}: ${hits.length ? `${hits.length} line${hits.length === 1 ? '' : 's'}` : 'not found in the script'}`)
    if (scroll && hits.length) ed.revealLine(hits[0])
  }
  const termsOf = (el: EventTarget | null): string[] | null => {
    const row = (el as HTMLElement | null)?.closest?.('[data-terms]') as HTMLElement | null
    return row ? (row.dataset.terms ?? '').split(/\s+/).filter(Boolean) : null
  }
  const onOver = (e: MouseEvent) => { const t = termsOf(e.target); if (t) showRefs(t, false) }
  const onOut = (e: MouseEvent) => {
    const row = (e.target as HTMLElement).closest?.('[data-terms]')
    if (row && !row.contains(e.relatedTarget as Node | null)) showRefs(sticky.current, false)
  }
  const onFocus = (e: FocusEvent) => { const t = termsOf(e.target); if (t) { sticky.current = t; showRefs(t, true) } }

  // ---- keyboard and commands
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveRef.current()
      } else if (!mod && !e.altKey && !isTyping(e.target)) {
        if (e.key === 'i') setView('overview')
        else if (e.key === 'p') setView('parameters')
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, tab.key])

  useCommand('run.run', (p: { mode?: Mode }) => {
    setView('run')
    void run.start(p?.mode)
  }, active)

  // `params.view` ('overview' | 'parameters' | 'run') picks the right-hand tab, also for a page that is already open
  useEffect(() => {
    const v = tab.params.view
    if (v === 'overview' || v === 'parameters' || v === 'run') setViewState(v)
  }, [tab.params.view, tab.params.nonce])

  // `params.preset` ('@<n>' = n-th recent run, or a preset slug) fills the run form with those values ("Run again")
  const presetParam = typeof tab.params.preset === 'string' ? (tab.params.preset as string) : ''
  const presetDone = useRef<string | null>(null)
  useEffect(() => {
    if (!presetParam || !run.form) return
    const key = `${presetParam}:${tab.params.nonce ?? ''}`
    if (presetDone.current === key) return
    presetDone.current = key
    setView('run')
    void run.load(presetParam)
    openTab({ kind: 'script', id, params: { preset: null } }, { background: true }) // asked once: a reload shows the last values again
  }, [presetParam, tab.params.nonce, run.form])

  // Quick run (Home): params.run = 'normal'|'trace'|'debug' starts a run once the form is ready
  const quick = tab.params.run as Mode | undefined
  const quickNonce = useRef<unknown>(null)
  useEffect(() => {
    if (!quick || !run.form) return
    const key = `${quick}:${tab.params.nonce ?? ''}`
    if (quickNonce.current === key) return
    quickNonce.current = key
    openTab({ kind: 'script', id, params: { run: null, nonce: null } }, { background: true }) // never run again on a reload
    setView('run')
    if (!run.form.blocked) void run.start(quick)
  }, [quick, tab.params.nonce, run.form])

  // ---- render
  const sc = detail?.script
  const ed = doc?.editor ?? null
  const editingOff = !!doc && !ed && !doc.editorError // the engine answers no editor and no error when editing is switched off
  const editingOn = shell.value?.editingEnabled !== false && !editingOff
  const readOnly = !ed || !ed.writable
  const lang = languageFor(sc?.ext ?? 'txt')
  const fileName = sc?.path.split(/[\\/]/).pop() ?? tab.title
  const lines = useMemo(() => (text ? text.split('\n').length : 0), [text])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      toast.info('Copied.')
    } catch {
      toast.error('Could not copy.')
    }
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const reveal = async () => {
    try {
      await api['app.reveal']({ kind: 'script', id })
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  if (error && !detail) {
    return <div class="empty"><Icon name="file" /><h2>This script could not be opened</h2><p class="error-text">{error}</p><button type="button" class="btn" onClick={() => void loadAll(true)}>Try again</button></div>
  }
  if (!detail || !doc || !info) return <div class="empty muted" style="margin:10vh auto">Loading…</div>

  return (
    <div class="split split-wide script-page" data-script={sc!.id} onMouseOver={onOver as any} onMouseOut={onOut as any} onFocusIn={onFocus as any}>
      <div class="split-main">
        <section class="doc" aria-label="Script" data-doc>
          <div class="doc-bar" role="tablist">
            <button type="button" class="doc-tab is-active" role="tab" title={sc!.path}>
              <Lang ext={sc!.ext} /><span class="tab-name">{fileName}</span>{dirty && <span class="dirty-dot is-on" aria-label="Unsaved changes" />}
            </button>
            <span class="spacer" />
            <span class="faint small mono hide-sm doc-refs" aria-live="polite">{refsLabel}</span>
            {ed && <span class="faint small hide-sm" title="Line endings are kept when saving">{ed.newline}{!ed.writable && <> · <span class="error-text">read-only file</span></>}</span>}
            {ed && versions.length > 0 && (
              <span class="restore-form">
                <button type="button" class="btn btn-ghost btn-sm" data-restore-previous title="Restore the previous version" onClick={() => void restore(null)}><Icon name="refresh" /> <span class="hide-sm">Restore previous</span></button>
                <button type="button" class="btn btn-ghost btn-sm" data-versions title="Earlier versions, side by side" onClick={() => setShowVersions(true)}>Versions…</button>
              </span>
            )}
            {hostInfo.value?.desktop && <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Show in folder" aria-label="Show in folder" onClick={() => void reveal()}><Icon name="folder" /></button>}
            <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Copy the script" aria-label="Copy the script" onClick={() => void copy()}><Icon name="copy" /></button>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Download the script" aria-label="Download the script" onClick={download}><Icon name="download" /></button>
            <button type="button" class={`btn btn-sm btn-save ${dirty ? 'is-dirty' : ''}`} data-save-all disabled={saving} title={dirty ? 'Save  (Ctrl+S)' : 'Nothing to save  (Ctrl+S)'} onClick={() => void saveAll()}>
              <Icon name="save" /> Save <span class="dirty-dot" aria-hidden="true" />
            </button>
            {!side2On.value && <button type="button" class="side2-open btn btn-ghost btn-icon btn-sm" title="Show the right panel (Ctrl+Alt+B)" aria-label="Show the right panel" onClick={toggleSide2}><Icon name="panel" /></button>}
          </div>

          {conflict && (
            <div class="doc-msg flash flash-warning" role="alert" data-conflict>
              <span>{conflict}</span>
              <span class="btn-row">
                <button type="button" class="btn btn-sm" onClick={() => void reloadFromDisk()}>Reload from disk</button>
                <button type="button" class="btn btn-sm btn-danger" onClick={() => void overwrite()}>Overwrite with mine</button>
                <button type="button" class="btn btn-sm btn-ghost" onClick={() => setConflict(null)}>Dismiss</button>
              </span>
            </div>
          )}
          {pendingDraft && (
            <div class="doc-msg flash flash-info" data-draft>
              <span>Unsaved changes from your last session were found for this script.</span>
              <span class="btn-row">
                <button type="button" class="btn btn-sm" onClick={() => { setText(pendingDraft.text); adapter.current?.setValue(pendingDraft.text); setPendingDraft(null) }}>Restore them</button>
                <button type="button" class="btn btn-sm btn-ghost" onClick={() => { writeDraft(id, null); setPendingDraft(null) }}>Discard</button>
              </span>
            </div>
          )}
          {warning && <div class="doc-msg flash flash-warning" data-warning><span>{warning}</span></div>}
          {doc.editorError && <div class="doc-msg">{doc.editorError} It is shown read-only.</div>}
          {editingOff && <div class="doc-msg">Editing is switched off (Settings → Features); the script is shown read-only.</div>}

          <div class="doc-panel">
            {doc.source.error && !ed ? <div class="doc-msg">{doc.source.error}</div> : (
              <CodeEditor
                value={base} language={lang} readOnly={readOnly} onChange={setText}
                onReady={(a) => { adapter.current = a; a.onCursorLine(setCursor) }}
              />
            )}
            {doc.source.truncated && !ed && <div class="doc-msg">Only the first 512 KB are shown.</div>}
          </div>
          <div class="ed-status" data-editor-status>
            <span class="ed-pos">Ln {cursor}</span>
            <span class="ed-count">{lines} lines · {text.length} characters</span>
            <span class={`ed-dirty ${dirty ? 'is-dirty' : ''}`}>{dirty ? '● unsaved changes' : ''}</span>
            {ed && <span class="ed-hint"><kbd>Ctrl</kbd><kbd>S</kbd> save</span>}
          </div>
        </section>
      </div>

      <aside class="split-side" aria-label="Script settings">
        <nav class="wb-tabs side-tabs" aria-label="Script">
          <button type="button" class={`tab ${view === 'overview' ? 'is-active' : ''}`} data-view="overview" onClick={() => setView('overview')} title="Overview: settings"><Icon name="gear" />Overview <kbd>I</kbd></button>
          <button type="button" class={`tab ${view === 'parameters' ? 'is-active' : ''}`} data-view="parameters" onClick={() => setView('parameters')} title="Parameters and saved values"><Icon name="sliders" />Parameters <kbd>P</kbd></button>
          <button type="button" class={`tab ${view === 'run' ? 'is-active' : ''}`} data-view="run" onClick={() => setView('run')} title="Run the script"><Icon name="play" />Run <kbd>R</kbd></button>
          <button type="button" class="tab-collapse btn btn-ghost btn-icon btn-sm" title="Hide this panel  (Ctrl+Alt+B)" aria-label="Hide the right panel" onClick={toggleSide2}><Icon class="i-flip" name="panel" /></button>
        </nav>

        {view === 'overview' && (
          <>
            {infoErrors.length > 0 && <div class="flash flash-error notes" role="alert"><div><strong>Not saved.</strong><ul class="err-list">{infoErrors.map((m) => <li key={m}>{m}</li>)}</ul></div></div>}
            <OverviewTab detail={detail} info={info} readOnly={!editingOn} onChange={setInfo} />
          </>
        )}
        {view === 'parameters' && (
          <ParametersTab drafts={drafts} info={typeInfo} readOnly={!editingOn || !!detail.loadError} errors={paramErrors} onChange={setDrafts} />
        )}
        {view === 'run' && <RunTab id={id} run={run} onReset={() => void run.load('-')} />}
      </aside>

      {showVersions && (
        <VersionsDialog id={id} versions={versions} current={text} dirty={scriptDirty} onClose={() => setShowVersions(false)} onRestore={(v) => void restore(v)} />
      )}
    </div>
  )
}

registerPanel('script', ScriptPage, { fill: true, bottom: SavedValues, bottomTitle: 'Saved values' })
