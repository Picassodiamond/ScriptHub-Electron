/**
 * The menu bar (File / View / Run / Help): same menus and behaviour as the old app: a click opens a menu, hovering another
 * menu while one is open switches, Esc or a click outside closes. In the Electron app the native menu is used instead and
 * this bar is not rendered; both run the same commands.
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import { Icon } from '../components/Icon'
import { activeTab, counts, getCommand, hostInfo, keyHint, menuFocus, runCommand, shell, workspaceKey } from '../core'

interface Item {
  label?: string
  icon?: string
  cmd?: string
  args?: Record<string, unknown>
  disabled?: boolean
  title?: string
  sep?: boolean
  heading?: string
  sub?: Item[]
  count?: number
}

const hint = (cmd?: string): string => {
  const k = cmd ? getCommand(cmd)?.keys?.[0] : undefined
  return k ? keyHint(k) : ''
}

function buildMenus(): Array<{ label: string; items: Item[] }> {
  const s = shell.value
  const f = s?.folder.folder ?? null
  const files = s?.folder.files ?? []
  const editing = !!s?.editingEnabled
  const recentItems = (xs: NonNullable<typeof s>['folder']['recent']): Item[] =>
    xs.map((x) => ({ label: x.name + (x.exists ? '' : ' (not found)'), icon: x.is_file ? 'file' : 'folder', cmd: 'file.openPath', args: { path: x.path }, disabled: !x.exists || x.is_open, title: x.path }))
  const recent: Item[] = []
  if (s?.folder.favorites.length) recent.push({ heading: 'Favourites' }, ...recentItems(s.folder.favorites))
  if (s?.folder.recent.length) recent.push({ heading: 'Recent' }, ...recentItems(s.folder.recent))
  if (recent.length) recent.push({ sep: true })
  recent.push({ label: 'Manage folders…', icon: 'list', cmd: 'file.manageFolders' })

  const t = activeTab.value
  const script = t?.kind === 'script'
  const file: Item[] = [
    { label: 'New script', icon: 'plus', cmd: 'file.newScript', disabled: !editing || !f, title: !editing ? 'Script editing is off in Settings' : !f ? 'Open a folder to create scripts in it' : '' },
    { sep: true },
    { label: 'Open file…', icon: 'file', cmd: 'file.openFile' },
    { label: 'Open folder…', icon: 'folder-open', cmd: 'file.openFolder' },
    ...(s?.folder.favorites.length || s?.folder.recent.length ? [{ label: 'Open recent', icon: 'clock', sub: recent }] : []),
  ]
  if (f) {
    file.push({ sep: true },
      { label: f.favorite ? 'Remove from favourites' : 'Add to favourites', icon: 'star', cmd: 'file.favorite' },
      { label: 'Close folder', icon: 'x', cmd: 'file.closeFolder' })
  }
  if (files.length) file.push(...(f ? [] : [{ sep: true } as Item]), { label: 'Close opened files', icon: 'x', cmd: 'file.closeFiles', count: files.length })
  file.push({ sep: true },
    { label: 'Open project…', icon: 'download', cmd: 'file.openProject', title: 'Open a ScriptHub project file (.scripthub): its scripts, sequences and presets' },
    { label: 'Save project as…', icon: 'save', cmd: 'file.saveProject', disabled: !f, title: f ? 'Save this folder with its sequences and presets as one project file' : 'Open a folder first' },
    { label: 'Close project', icon: 'x', cmd: 'file.closeProject', disabled: !f && !files.length },
    { sep: true },
    { label: 'Settings', icon: 'gear', cmd: 'file.settings' })

  const view: Item[] = [
    { label: 'Command palette', icon: 'command', cmd: 'view.palette' },
    { sep: true },
    { label: 'Home', icon: 'home', cmd: 'view.home' },
    { label: 'Library', icon: 'files', cmd: 'view.library' },
    { label: 'Sequences', icon: 'sequence', cmd: 'view.sequences' },
    { label: 'Runs', icon: 'pulse', cmd: 'view.runs' },
    { sep: true },
    { label: 'Side panel', icon: 'panel', cmd: 'view.side' },
    { label: 'Right panel', icon: 'panel', cmd: 'view.side2' },
    { label: 'Bottom panel', icon: 'layout-rows', cmd: 'view.bottom' },
    { label: 'Collapse explorer', icon: 'collapse', cmd: 'view.collapse' },
    { sep: true },
    { label: 'Light / dark theme', icon: 'moon', cmd: 'view.theme' },
  ]
  const run: Item[] = [
    { label: script ? `Run ${t!.title}` : 'Run script', icon: 'play', cmd: 'run.run', args: { mode: 'normal' }, disabled: !script },
    { label: 'Run with Trace', icon: 'eye', cmd: 'run.run', args: { mode: 'trace' }, disabled: !script },
    { label: 'Run with Debug', icon: 'bug', cmd: 'run.run', args: { mode: 'debug' }, disabled: !script },
    { sep: true },
    { label: 'Rescan folder', icon: 'refresh', cmd: 'run.rescan', disabled: !f && !files.length },
    { label: 'Runs', icon: 'pulse', cmd: 'view.runs', count: counts.value.running + counts.value.queued || undefined },
  ]
  const help: Item[] = [
    { label: 'Keyboard shortcuts', icon: 'keyboard', cmd: 'help.shortcuts' },
    { label: 'Show data folder', icon: 'folder', cmd: 'help.dataFolder' },
    { sep: true },
    { label: `ScriptHub ${s?.version ?? ''}${hostInfo.value?.desktop ? ' · desktop' : ''}`, icon: 'play', disabled: true },
  ]
  return [{ label: 'File', items: file }, { label: 'View', items: view }, { label: 'Run', items: run }, { label: 'Help', items: help }]
}

function MenuItem({ item, close }: { item: Item; close(): void }) {
  if (item.sep) return <div class="menu-sep" />
  if (item.heading) return <div class="menu-label">{item.heading}</div>
  const body = (
    <>
      {item.icon && <Icon name={item.icon} small />}
      <span>{item.label}</span>
      {item.count ? <span class="count-pill">{item.count}</span> : null}
      {item.sub ? <span class="sub-caret" aria-hidden="true" /> : <kbd>{hint(item.cmd)}</kbd>}
    </>
  )
  if (item.sub) {
    return (
      <div class="menu-sub">
        <span class="menu-item" role="menuitem" aria-haspopup="true">{body}</span>
        <div class="menu submenu" role="menu">{item.sub.map((x, i) => <MenuItem key={i} item={x} close={close} />)}</div>
      </div>
    )
  }
  if (item.disabled || !item.cmd) return <span class="menu-item is-disabled" role="menuitem" aria-disabled="true" title={item.title}>{body}</span>
  return (
    <button type="button" class="menu-item" role="menuitem" title={item.title} onClick={() => { close(); void runCommand(item.cmd!, item.args) }}>
      {body}
    </button>
  )
}

export function MenuBar() {
  const [open, setOpen] = useState<number | null>(null)
  const ref = useRef<HTMLElement>(null)
  const menus = buildMenus()
  const s = shell.value

  useEffect(() => {
    if (open === null) return
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(null) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null) }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
    }
  }, [open])

  const first = useRef(menuFocus.value)
  useEffect(() => {
    if (menuFocus.value !== first.current) setOpen(0)
  }, [menuFocus.value])

  const f = s?.folder.folder
  const files = s?.folder.files.length ?? 0
  const title = `${activeTab.value?.kind === 'script' ? activeTab.value.title + ' — ' : ''}${f ? f.name + (files ? ` + ${files} file${files > 1 ? 's' : ''}` : '') : files ? `${files} open file${files > 1 ? 's' : ''}` : 'No folder open'}`

  return (
    <header class="menubar" role={'menubar' as any} ref={ref}>
      <img class="mb-logo" src="./scripthub.png" alt="" width="22" height="22" />
      {menus.map((m, i) => (
        <div class="mb-menu" key={m.label} {...({ open: open === i } as any)}>
          <button
            type="button" class="mb-label" role="menuitem" aria-haspopup="true" aria-expanded={open === i}
            onClick={() => setOpen(open === i ? null : i)} onMouseEnter={() => open !== null && setOpen(i)}
          >
            {m.label}
          </button>
          {open === i && <div class="menu" role="menu">{m.items.map((x, j) => <MenuItem key={j} item={x} close={() => setOpen(null)} />)}</div>}
        </div>
      ))}
      <span class="mb-title" title={f?.path ?? ''} data-ws={workspaceKey.value}>{title}</span>
    </header>
  )
}
