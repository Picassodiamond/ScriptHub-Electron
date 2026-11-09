/** Open folder or file: type a path, pick with the native dialog (desktop), or browse; favourites and recent folders. */
import { useState } from 'preact/hooks'
import { Icon } from '../../components/Icon'
import { api, closeTab, errorText, hostInfo, openPaths, registerPanel, refreshShell, shell, toast, useApi, type PanelProps } from '../../core'
import type { WorkspaceItem } from '@scripthub/protocol'

function FolderRow({ x, recent, onOpen }: { x: WorkspaceItem; recent?: boolean; onOpen(path: string): void }) {
  const star = async () => {
    await api['workspace.favorite']({ path: x.path, on: !x.favorite })
    await refreshShell()
  }
  const forget = async () => {
    await api['workspace.forget']({ path: x.path })
    await refreshShell()
  }
  return (
    <li class={`${x.is_open ? 'is-open' : ''}${!x.exists ? ' is-missing' : ''}`}>
      <button type="button" class={`btn btn-ghost btn-icon btn-sm star ${x.favorite ? 'is-on' : ''}`} aria-pressed={x.favorite} title={x.favorite ? 'Remove from favourites' : 'Add to favourites'} onClick={() => void star()}>
        <Icon name="star" />
      </button>
      <div class="fl-text">
        <div class="strong clamp-1">{x.name}{x.is_open && <> <span class="badge badge-accent">open</span></>}</div>
        <div class="mono small faint clamp-1" title={x.path}>{x.path}{!x.exists && <> · <span class="error-text">not found</span></>}</div>
      </div>
      {x.exists && !x.is_open && <button type="button" class="btn btn-sm" onClick={() => onOpen(x.path)}>Open</button>}
      {recent && <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Remove from the recent list" onClick={() => void forget()}><Icon name="x" /></button>}
    </li>
  )
}

function FolderPanel({ tab }: PanelProps) {
  const ws = shell.value?.folder
  const [path, setPath] = useState('')
  const [browsePath, setBrowsePath] = useState('')
  const browse = useApi('workspace.browse', { path: browsePath }, [browsePath])
  const b = browse.data
  const desktop = !!hostInfo.value?.desktop

  const open = async (p: string) => {
    const target = p.trim()
    if (!target) return
    try {
      const r = await openPaths([target])
      if (r.opened.length) closeTab(tab.key) // on an error the page stays, with what was typed
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  const pick = async () => {
    const p = await api['workspace.pickFolder']({})
    if (p) {
      setPath(p)
      await open(p)
    }
  }

  return (
    <div class="page page-narrow">
      <section class="panel">
        <div class="panel-head">
          <h2>Open a folder or a script</h2>
          {ws?.folder && <><span class="spacer" /><span class="faint small">Open now: <span class="mono" title={ws.folder.path}>{ws.folder.name}</span></span></>}
        </div>
        <div class="panel-body">
          <form class="inline-form" onSubmit={(e) => { e.preventDefault(); void open(path || browsePath) }}>
            <input class="input mono" type="text" name="path" value={path} onInput={(e) => setPath((e.target as HTMLInputElement).value)}
              placeholder="C:\scripts   or   /home/me/scripts/backup.sh" aria-label="Folder path" autofocus />
            {desktop && <button type="button" class="btn" onClick={() => void pick()}><Icon name="folder" /> Browse…</button>}
            <button class="btn btn-primary" type="submit">Open</button>
          </form>
          <p class="help" style="margin:8px 0 0">The folder is scanned recursively for scripts; nothing runs during the scan. It is reopened the next time ScriptHub starts. You can also drag a folder onto the window.</p>
        </div>

        <div class="fb">
          <div class="fb-bar">
            {(b?.places ?? []).map((p) => <a key={p.path} class="chip" href="#" onClick={(e) => { e.preventDefault(); setBrowsePath(p.path) }}>{p.name}</a>)}
          </div>
          {b?.path ? (
            <>
              <div class="fb-crumbs mono small">
                {b.crumbs.map((c, i) => (
                  <>
                    <a key={c.path} href="#" onClick={(e) => { e.preventDefault(); setBrowsePath(c.path) }}>{c.name}</a>
                    {i < b.crumbs.length - 1 && <span class="sep">›</span>}
                  </>
                ))}
              </div>
              {b.error && <div class="fb-msg error-text small">{b.error}</div>}
              <ul class="fb-list">
                {b.parent && <li><a class="fb-dir" href="#" onClick={(e) => { e.preventDefault(); setBrowsePath(b.parent) }}><Icon name="back" small /> ..</a></li>}
                {b.dirs.map((d) => (
                  <li key={d.path}>
                    <a class="fb-dir" href="#" onClick={(e) => { e.preventDefault(); setBrowsePath(d.path) }}><Icon name="folder" small /> <span class="clamp-1">{d.name}</span></a>
                    <button type="button" class="btn btn-ghost btn-sm" onClick={() => void open(d.path)}>Open</button>
                  </li>
                ))}
                {b.files.map((f) => (
                  <li key={f.path}>
                    <span class="fb-dir fb-file"><Icon name="files" small /> <span class="clamp-1 mono">{f.name}</span></span>
                    <button type="button" class="btn btn-ghost btn-sm" title="Open just this script" onClick={() => void open(f.path)}>Open</button>
                  </li>
                ))}
                {!b.dirs.length && !b.files.length && !b.error && <li class="fb-msg faint small">No sub-folders or scripts.</li>}
                {b.more && <li class="fb-msg faint small">Only the first 500 sub-folders are listed; type the path above.</li>}
              </ul>
            </>
          ) : (
            <div class="fb-msg faint small">{browse.error ?? 'Pick a drive or your home folder above, or type a path.'}</div>
          )}
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2>Favourites <span class="count-pill">{ws?.favorites.length ?? 0}</span></h2></div>
        {ws?.favorites.length ? <ul class="folder-list">{ws.favorites.map((x) => <FolderRow key={x.path} x={x} onOpen={(p) => void open(p)} />)}</ul>
          : <div class="panel-body muted small">Star a folder to keep it here.</div>}
      </section>

      <section class="panel">
        <div class="panel-head"><h2>Recent <span class="count-pill">{ws?.recent.length ?? 0}</span></h2></div>
        {ws?.recent.length ? <ul class="folder-list">{ws.recent.map((x) => <FolderRow key={x.path} x={x} recent onOpen={(p) => void open(p)} />)}</ul>
          : <div class="panel-body muted small">Folders you open are listed here.</div>}
      </section>
    </div>
  )
}

registerPanel('folder', FolderPanel)
