/** The explorer: the open folder as a title and its scripts grouped by category, with a filter. */
import { useEffect, useMemo, useState } from 'preact/hooks'
import { Icon, Lang } from '../components/Icon'
import { activeTab, onCommand, openTab, readJson, runCommand, scan, shell, writeJson } from '../core'

const KEY = 'sr.treeCollapsed'

export function Explorer() {
  const s = shell.value
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => readJson(KEY, {}))
  const tree = s?.tree ?? []

  useEffect(() => onCommand('tree.collapse', () => {
    const all = Object.fromEntries(tree.map((g) => [g.name, true]))
    setCollapsed(all)
    writeJson(KEY, all)
  }), [tree.map((g) => g.name).join('|')])

  const needle = q.trim().toLowerCase()
  const groups = useMemo(() => tree
    .map((g) => ({ ...g, scripts: needle ? g.scripts.filter((x) => `${x.name} ${x.relative} ${x.category}`.toLowerCase().includes(needle)) : g.scripts }))
    .filter((g) => g.scripts.length), [tree, needle])

  const f = s?.folder.folder
  const files = s?.folder.files ?? []
  const t = activeTab.value
  const current = t?.kind === 'script' ? t.id : t?.kind === 'run' ? t.params.scriptId : undefined
  const title = f ? f.name + (files.length ? ` + ${files.length}` : '') : files.length ? 'Open files' : 'No folder open'

  const toggle = (name: string) => {
    const next = { ...collapsed, [name]: !collapsed[name] }
    setCollapsed(next)
    writeJson(KEY, next)
  }

  return (
    <>
      <div class="side-head">
        <div class="side-title-block" title={f?.path ?? ''}>
          <span class="side-title">
            {title}
            {f?.favorite && <Icon name="star" class="i-xs fav-mark" title="favourite" />}
          </span>
        </div>
        <div class="side-actions">
          {s?.editingEnabled && f && (
            <button type="button" class="btn btn-ghost btn-icon btn-sm" title="New script in this folder  (g n)" aria-label="New script" onClick={() => void runCommand('file.newScript')}>
              <Icon name="plus" />
            </button>
          )}
          {(f || files.length > 0) && (
            <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Rescan" aria-label="Rescan" onClick={() => void runCommand('run.rescan')}>
              <Icon name="refresh" />
            </button>
          )}
          <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Collapse all" aria-label="Collapse all" onClick={() => void runCommand('view.collapse')}>
            <Icon name="collapse" />
          </button>
        </div>
      </div>
      <div class="tree-filter">
        <label class="searchbox searchbox-sm">
          <Icon name="search" small />
          <input type="search" placeholder="Filter scripts" autocomplete="off" aria-label="Filter scripts" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </label>
      </div>
      <div class="side-body">
        <div class="tree" id="tree">
          {groups.map((g) => (
            <div class="tree-group" key={g.name} data-group={g.name}>
              <button type="button" class="tree-summary" aria-expanded={!collapsed[g.name] || !!needle} onClick={() => toggle(g.name)}>
                {g.name}
                <span class="tree-count">{g.scripts.length}</span>
              </button>
              {(!collapsed[g.name] || needle) && (
                <div class="tree-items">
                  {g.scripts.map((x) => (
                    <a
                      key={x.id} class={`tree-item ${x.id === current ? 'is-active' : ''}`} data-id={x.id} href="#" title={x.relative}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer?.setData('application/x-scripthub-script', x.id)
                        e.dataTransfer?.setData('text/plain', x.name)
                      }}
                      onClick={(e) => { e.preventDefault(); openTab({ kind: 'script', id: x.id, title: x.name }, { background: e.ctrlKey || e.metaKey }) }}
                      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); openTab({ kind: 'script', id: x.id, title: x.name }, { background: true }) } }}
                    >
                      <Lang ext={x.ext} />
                      <span class="ti-name">{x.name}</span>
                      {x.status && <span class={`dot st-${x.status}`} title={`Last run: ${x.statusLabel}`} />}
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
          {!groups.length && (
            f && needle ? <p class="tree-empty">No match.</p>
            : f && scan.value.scanning ? <p class="tree-empty">Scanning the folder for scripts… progress is shown at the bottom.</p>
            : f ? <p class="tree-empty">No scripts in this folder. Files with an extension listed under Settings → Interpreters are shown.</p>
            : (
              <div class="tree-empty">
                <p>No folder open.</p>
                <button type="button" class="btn btn-primary btn-sm" onClick={() => void runCommand('file.openFolder')}><Icon name="folder" /> Open folder…</button>{' '}
                <button type="button" class="btn btn-sm" onClick={() => void runCommand('file.openFile')}><Icon name="file" /> Open file…</button>
              </div>
            )
          )}
          {groups.length > 0 && scan.value.scanning && scan.value.first && <p class="tree-empty">Still scanning; more scripts may appear.</p>}
        </div>
      </div>
    </>
  )
}
