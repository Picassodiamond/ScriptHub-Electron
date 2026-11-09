import { Icon } from '../components/Icon'
import { activeTab, counts, getCommand, keyHint, runCommand, sideOn, sideView, type SideView } from '../core'

type Entry = { id: string; icon: string; label: string; cmd: string; title: string; view?: SideView; kinds: string[] }

const ENTRIES: Entry[] = [
  { id: 'home', icon: 'home', label: 'Home', cmd: 'view.home', title: 'Home', kinds: ['home'] },
  { id: 'library', icon: 'files', label: 'Library', cmd: 'view.library', title: 'Script Library', view: 'explorer', kinds: ['library', 'script', 'new-script', 'folder', 'project-open'] },
  { id: 'sequences', icon: 'sequence', label: 'Sequences', cmd: 'view.sequences', title: 'Sequences — scripts connected by arrows', view: 'sequences', kinds: ['sequences', 'sequence', 'sequence-run'] },
  { id: 'runs', icon: 'pulse', label: 'Runs', cmd: 'view.runs', title: 'Runs — running now and history', view: 'runs', kinds: ['history', 'run'] },
]

export function ActivityBar() {
  const kind = activeTab.value?.kind ?? ''
  const active = counts.value.running + counts.value.queued
  const btn = (e: Entry) => {
    const is = e.kinds.includes(kind)
    const k = getCommand(e.cmd)?.keys?.[0]
    return (
      <button
        key={e.id} type="button" class={`act ${is ? 'is-active' : ''}`} title={`${e.title}${k ? `  (${keyHint(k)})` : ''}`} aria-label={e.label}
        aria-current={is ? 'page' : undefined}
        onClick={() => {
          if (e.view && is && sideOn.value && sideView.value === e.view) return void runCommand('view.side') // clicking the shown view hides the panel
          void runCommand(e.cmd)
        }}
      >
        <Icon name={e.icon} />
        <span class="act-label">{e.label}</span>
        {e.id === 'runs' && active > 0 ? <span class="act-badge" title="Running or queued">{active}</span> : null}
      </button>
    )
  }
  return (
    <nav class="activity" aria-label="Main">
      {ENTRIES.map(btn)}
      <span class="act-spacer" />
      <button type="button" class={`act ${kind === 'settings' ? 'is-active' : ''}`} title="Settings  (g s)" aria-label="Settings" onClick={() => void runCommand('file.settings')}>
        <Icon name="gear" />
        <span class="act-label">Settings</span>
      </button>
    </nav>
  )
}
