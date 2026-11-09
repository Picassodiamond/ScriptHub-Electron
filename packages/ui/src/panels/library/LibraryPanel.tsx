/**
 * Script Library: every script of the open folder grouped by category, with search, category / platform / language
 * filters, favourites (kept on this machine), table or card layout, scan problems and keyboard navigation.
 */
import type { ScriptDto } from '@scripthub/protocol'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Icon, Lang } from '../../components/Icon'
import {
  api, errorText, openTab, readJson, readStore, runCommand, scan, shell, toast, useApi, writeJson, writeStore, type PanelProps,
} from '../../core'

const FAV_KEY = 'scripthub.library.favorites'
const COLLAPSED_KEY = 'scripthub.library.collapsed'
const VIEW_KEY = 'sr.view'

interface Filter { q: string; category: string; platform: string; language: string; favs: boolean }
const NONE: Filter = { q: '', category: '', platform: '', language: '', favs: false }

function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
}

const haystack = (s: ScriptDto): string =>
  [s.name, s.description, s.relative, s.category, s.interpreter, s.languageLabel, ...s.platformLabels].join(' ').toLowerCase()

export function matches(s: ScriptDto, f: Filter, favs: Set<string>): boolean {
  if (f.category && s.category !== f.category) return false
  if (f.platform && !s.platforms.includes(f.platform)) return false
  if (f.language && s.language !== f.language) return false
  if (f.favs && !favs.has(s.id)) return false
  const q = f.q.trim().toLowerCase()
  return !q || haystack(s).includes(q)
}

/** Categories in name order, each with its scripts (favourites first, then by name). */
export function groupScripts(list: ScriptDto[], favs: Set<string>): Array<{ name: string; scripts: ScriptDto[] }> {
  const by = new Map<string, ScriptDto[]>()
  for (const s of list) by.set(s.category, [...(by.get(s.category) ?? []), s])
  return [...by.entries()]
    .sort((a, b) => a[0].toLowerCase().localeCompare(b[0].toLowerCase()))
    .map(([name, scripts]) => ({
      name,
      scripts: scripts.sort((a, b) => Number(favs.has(b.id)) - Number(favs.has(a.id)) || a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
    }))
}

export function LibraryPanel({ active }: PanelProps) {
  const version = scan.value.version
  const lib = useApi('scripts.list', {}, [version])
  const editing = shell.value?.editingEnabled ?? false
  const folder = shell.value?.folder.folder ?? null

  const [f, setF] = useState<Filter>(NONE)
  const [view, setView] = useState<'table' | 'cards'>(() => (readStore(VIEW_KEY) === 'cards' ? 'cards' : 'table'))
  const [favs, setFavs] = useState<Set<string>>(() => new Set(readJson<string[]>(FAV_KEY, [])))
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(readJson<string[]>(COLLAPSED_KEY, [])))
  const [focusId, setFocusId] = useState<string | null>(null) // by id, so favouriting (which re-sorts) keeps the focus on the same script
  const [rescanning, setRescanning] = useState(false)
  const search = useRef<HTMLInputElement>(null)

  const all = lib.data?.scripts ?? []
  const shown = useMemo(() => all.filter((s) => matches(s, f, favs)), [all, f, favs])
  const groups = useMemo(() => groupScripts(shown, favs), [shown, favs])
  const flat = useMemo(() => groups.flatMap((g) => (collapsed.has(g.name) ? [] : g.scripts)), [groups, collapsed])
  const focus = focusId ? flat.findIndex((s) => s.id === focusId) : -1
  const filtered = !!(f.q.trim() || f.category || f.platform || f.language || f.favs)

  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    if (active) void lib.reload()
  }, [active])
  useEffect(() => { setFocusId(null) }, [f, view])

  const toggleFav = (id: string) => setFavs((cur) => {
    const n = new Set(cur)
    if (n.has(id)) n.delete(id); else n.add(id)
    writeJson(FAV_KEY, [...n])
    return n
  })
  const toggleGroup = (name: string) => setCollapsed((cur) => {
    const n = new Set(cur)
    if (n.has(name)) n.delete(name); else n.add(name)
    writeJson(COLLAPSED_KEY, [...n])
    return n
  })
  const pickView = (v: 'table' | 'cards') => { setView(v); writeStore(VIEW_KEY, v) }

  const open = (s: ScriptDto, params?: Record<string, any>) => openTab({ kind: 'script', id: s.id, title: s.name, params })
  const runForm = (s: ScriptDto) => open(s, { view: 'run' })
  const openLast = (s: ScriptDto) => s.lastRun && openTab({ kind: 'run', id: s.lastRun.id, title: s.name, params: { scriptId: s.id } })

  const rescan = async () => {
    setRescanning(true)
    try {
      const r = await api['workspace.rescan']({})
      toast.info(r.finished ? `Found ${r.count} script${r.count === 1 ? '' : 's'}.` : 'Still scanning…')
      await lib.reload()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setRescanning(false)
    }
  }

  // ----------------------------------------------------------- keyboard ---
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (typing(e.target)) {
      if (e.key === 'Escape' && e.target === search.current) { setF((x) => ({ ...x, q: '' })); search.current?.blur() }
      if (e.key === 'ArrowDown' && e.target === search.current) { e.preventDefault(); search.current?.blur(); setFocusId(flat[0]?.id ?? null) }
      return
    }
    if (e.key === '/') { e.preventDefault(); search.current?.focus(); return }
    if (!flat.length) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setFocusId(flat[Math.min(flat.length - 1, focus + 1)].id) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocusId(flat[Math.max(0, focus - 1)].id) }
    else if (focus >= 0 && focus < flat.length) {
      const s = flat[focus]
      if (e.key === 'Enter') { e.preventDefault(); open(s) }
      else if (e.key === 'f') toggleFav(s.id)
    }
  }
  useEffect(() => {
    if (!active) return
    const h = (e: KeyboardEvent) => keyRef.current(e)
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [active])
  useEffect(() => {
    if (focusId) [...document.querySelectorAll<HTMLElement>('[data-lib-item]')].find((el) => el.dataset.libItem === focusId)?.scrollIntoView?.({ block: 'nearest' })
  }, [focusId])

  const runButton = (s: ScriptDto) => (s.metaValid
    ? <button type="button" class="btn btn-sm play" onClick={() => runForm(s)}><Icon name="play" /> Run</button>
    : <button type="button" class="btn btn-sm" title={s.metaError ?? ''} onClick={() => open(s)}>Fix</button>)
  const star = (s: ScriptDto) => (
    <button type="button" class={`btn btn-ghost btn-icon btn-sm lib-star ${favs.has(s.id) ? 'is-on' : ''}`} aria-pressed={favs.has(s.id)}
      title={favs.has(s.id) ? 'Remove from favourites' : 'Add to favourites'} aria-label={`${favs.has(s.id) ? 'Unfavourite' : 'Favourite'} ${s.name}`} onClick={() => toggleFav(s.id)}>
      <Icon name="star" />
    </button>
  )
  const lastRun = (s: ScriptDto) => (s.lastRun
    ? <a class={`st st-sm st-${s.lastRun.status}`} href="#" title={`Last run ${s.lastRun.ago}`} onClick={(e) => { e.preventDefault(); openLast(s) }}>{s.lastRun.label}</a>
    : <span class="faint small">—</span>)
  const focusCls = (s: ScriptDto) => (focusId === s.id ? 'is-focus' : '')

  const problems = lib.data?.problems ?? []

  return (
    <div class="page lib">
      {problems.map((p) => <div key={p} class="flash flash-warning"><span>{p}</span></div>)}
      {lib.error && <div class="flash flash-error" role="alert"><span>{lib.error}</span></div>}

      {all.length > 0 && (
        <div class="toolbar">
          <label class="searchbox">
            <Icon name="search" />
            <input ref={search} type="search" value={f.q} placeholder="Search name, path, interpreter…" autocomplete="off" aria-label="Search scripts" onInput={(e) => setF({ ...f, q: (e.target as HTMLInputElement).value })} />
            <kbd>/</kbd>
          </label>
          <select class="input input-sm" aria-label="Category" value={f.category} onChange={(e) => setF({ ...f, category: (e.target as HTMLSelectElement).value })}>
            <option value="">All categories</option>
            {(lib.data?.categories ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select class="input input-sm" aria-label="Platform" value={f.platform} onChange={(e) => setF({ ...f, platform: (e.target as HTMLSelectElement).value })}>
            <option value="">All platforms</option>
            {(lib.data?.platforms ?? []).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <select class="input input-sm" aria-label="Language" value={f.language} onChange={(e) => setF({ ...f, language: (e.target as HTMLSelectElement).value })}>
            <option value="">All languages</option>
            {(lib.data?.languages ?? []).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <button type="button" class={`btn btn-sm ${f.favs ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={f.favs} title="Only favourites" onClick={() => setF({ ...f, favs: !f.favs })}><Icon name="star" /> Favourites</button>
          {filtered && <button type="button" class="btn btn-ghost btn-sm" onClick={() => setF(NONE)}>Clear</button>}
          <span class="spacer" />
          <span class="muted small" id="match-count">{filtered ? `${shown.length} of ${all.length} shown` : `${all.length} script${all.length === 1 ? '' : 's'}`}</span>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Rescan the folder" aria-label="Rescan" disabled={rescanning || scan.value.scanning} onClick={() => void rescan()}><Icon name="refresh" /></button>
          <div class="seg" role="group" aria-label="Layout">
            <button type="button" class={`seg-btn ${view === 'table' ? 'is-active' : ''}`} title="Table" aria-label="Table" aria-pressed={view === 'table'} onClick={() => pickView('table')}><Icon name="list" /></button>
            <button type="button" class={`seg-btn ${view === 'cards' ? 'is-active' : ''}`} title="Cards" aria-label="Cards" aria-pressed={view === 'cards'} onClick={() => pickView('cards')}><Icon name="grid" /></button>
          </div>
        </div>
      )}

      {all.length > 0 && shown.length > 0 && view === 'table' && (
        <section class="panel" id="view-table">
          <div class="table-wrap">
            <table class="table lib-table">
              <thead><tr><th>Script</th><th class="hide-sm">Interpreter</th><th class="hide-sm">Platform</th><th class="hide-sm">Params</th><th>Last run</th><th></th></tr></thead>
              {groups.map((g) => (
                <tbody key={g.name} data-group={g.name}>
                  <tr class="lib-group">
                    <td colSpan={6}>
                      <button type="button" class={`tree-summary ${collapsed.has(g.name) ? '' : 'is-open'}`} aria-expanded={!collapsed.has(g.name)} onClick={() => toggleGroup(g.name)}>
                        {g.name} <span class="tree-count">{g.scripts.length}</span>
                      </button>
                    </td>
                  </tr>
                  {!collapsed.has(g.name) && g.scripts.map((s) => (
                    <tr key={s.id} data-lib-item={s.id} class={focusCls(s)}>
                      <td>
                        <div class="row-name">
                          {star(s)}
                          <Lang ext={s.ext} />
                          <div class="row-text">
                            <a class="plain strong" href="#" onClick={(e) => { e.preventDefault(); open(s) }}>{s.name}</a>
                            <div class="faint small mono clamp-1" title={s.path}>{s.relative}</div>
                            {s.metaError && <div class="error-text small clamp-1" title={s.metaError}>⚠ {s.metaError}</div>}
                          </div>
                        </div>
                      </td>
                      <td class="mono small muted hide-sm">{s.interpreter || '—'}</td>
                      <td class="small muted hide-sm">{s.platformLabels.join(', ')}</td>
                      <td class="mono small muted hide-sm">{s.parameterCount}</td>
                      <td>{lastRun(s)}</td>
                      <td class="actions">
                        <div class="btn-row">
                          <button type="button" class="btn btn-ghost btn-icon btn-sm" title="View source" aria-label={`View source of ${s.name}`} onClick={() => open(s)}><Icon name="eye" /></button>
                          {editing && <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Edit the script" aria-label={`Edit ${s.name}`} onClick={() => open(s)}><Icon name="edit" /></button>}
                          {runButton(s)}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        </section>
      )}

      {all.length > 0 && shown.length > 0 && view === 'cards' && (
        <div id="view-cards">
          {groups.map((g) => (
            <section key={g.name} class="lib-cards-group" data-group={g.name}>
              <button type="button" class={`tree-summary ${collapsed.has(g.name) ? '' : 'is-open'}`} aria-expanded={!collapsed.has(g.name)} onClick={() => toggleGroup(g.name)}>
                {g.name} <span class="tree-count">{g.scripts.length}</span>
              </button>
              {!collapsed.has(g.name) && (
                <div class="cards">
                  {g.scripts.map((s) => (
                    <article key={s.id} class={`sc ${focusCls(s)}`} data-lib-item={s.id}>
                      <div class="sc-head">
                        <Lang ext={s.ext} />
                        <div class="sc-title">
                          <h2><a class="plain" href="#" title={s.name} onClick={(e) => { e.preventDefault(); open(s) }}>{s.name}</a></h2>
                          <div class="sc-sub">{s.category}</div>
                        </div>
                        {star(s)}
                      </div>
                      <p class="desc">{s.description || <span class="faint">No description.</span>}</p>
                      {s.metaError && <p class="error-text small clamp-1" title={s.metaError}>⚠ {s.metaError}</p>}
                      <div class="sc-meta">
                        <span class="badge mono" title={s.path}>{s.relative}</span>
                        <span class="badge">{s.parameterCount} param{s.parameterCount === 1 ? '' : 's'}</span>
                        {lastRun(s)}
                      </div>
                      <div class="sc-foot">
                        <button type="button" class="btn btn-ghost btn-icon btn-sm" title="View source" aria-label={`View source of ${s.name}`} onClick={() => open(s)}><Icon name="eye" /></button>
                        {editing && <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Edit the script" aria-label={`Edit ${s.name}`} onClick={() => open(s)}><Icon name="edit" /></button>}
                        <span class="spacer" />
                        {runButton(s)}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      )}

      {all.length > 0 && shown.length === 0 && (
        <div class="empty" id="no-match"><h2>No scripts match</h2><p>Try a different search or <button type="button" class="btn btn-sm" onClick={() => setF(NONE)}>clear the filters</button></p></div>
      )}

      {all.length === 0 && !lib.loading && (
        <section class="panel">
          <div class="empty">
            <Icon name="folder" />
            <h2>No scripts found</h2>
            {folder ? (
              <>
                <p>Nothing with a known extension in <span class="mono">{folder.path}</span>. Drop a <code>.py</code> / <code>.sh</code> / <code>.bat</code> file into it and rescan, or open another folder.</p>
                <div class="btn-row" style="justify-content:center">
                  {editing && <button type="button" class="btn btn-primary" onClick={() => openTab({ kind: 'new-script' })}><Icon name="plus" /> New script</button>}
                  <button type="button" class="btn" disabled={rescanning} onClick={() => void rescan()}><Icon name="refresh" /> Rescan</button>
                  <button type="button" class="btn" onClick={() => void runCommand('file.openFolder')}><Icon name="folder-open" /> Open another folder…</button>
                </div>
              </>
            ) : (
              <>
                <p>No folder is open. Open a script folder to see its scripts.</p>
                <button type="button" class="btn btn-primary" onClick={() => void runCommand('file.openFolder')}><Icon name="folder-open" /> Open folder…</button>
              </>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
