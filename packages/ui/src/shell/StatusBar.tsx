import { Icon } from '../components/Icon'
import { counts, hostInfo, runCommand, scan, shell, theme } from '../core'

export function StatusBar() {
  const c = counts.value
  const sc = scan.value
  const live = c.running > 0
  return (
    <footer class="statusbar">
      <span class="sb-item sb-brand">ScriptHub {shell.value?.version ?? ''}</span>
      {hostInfo.value?.desktop && <span class="sb-item" title="Running as a desktop app: only this window can use it">desktop</span>}
      <button type="button" class={`sb-item sb-btn ${live ? 'sb-live' : ''}`} title="Open Runs" onClick={() => void runCommand('view.runs')}>
        <span class="sb-dot" />
        {c.running} running · {c.queued} queued
      </button>
      {sc.scanning && (
        <span class="sb-item sb-live sb-scan" role="status" aria-live="polite" title={sc.current}>
          <span class="sb-dot" />
          <span>Scanning {sc.folder} · {sc.dirs} folders · {sc.found} scripts</span>
        </span>
      )}
      <span class="sb-spacer" />
      <button type="button" class="sb-item sb-btn" title="Light / dark theme" aria-label="Toggle theme" onClick={() => void runCommand('view.theme')}>
        <Icon name={theme.value === 'dark' ? 'moon' : 'sun'} small />
      </button>
      <button type="button" class="sb-item sb-btn" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={() => void runCommand('help.shortcuts')}>
        <Icon name="keyboard" small />
      </button>
    </footer>
  )
}
