/** Start the workbench: theme, layout, commands, hotkeys, the first shell load, and the engine event wiring. */
import {
  counts, errorText, initLayout, initTheme, loadHostInfo, loadWorkspaceTabs, onEvent, openPaths, persistTabs, pollRunning, refreshShell, registerBuiltinCommands, runCommand,
  scan, startHotkeys, toast, workspaceKey,
} from './core'

export async function startApp(): Promise<() => void> {
  initTheme()
  const stops: Array<() => void> = [initLayout()]
  registerBuiltinCommands()
  stops.push(startHotkeys())
  await loadHostInfo()
  await refreshShell()
  if (workspaceKey.value === 'none') loadWorkspaceTabs('empty') // the engine did not answer: still show Home
  stops.push(persistTabs())

  let timer: ReturnType<typeof setTimeout> | null = null
  const later = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void refreshShell(), 120)
  }
  stops.push(
    onEvent('workspace.changed', later),
    // a run (or sequence run) started or finished anywhere: the numbers arrive at once, the recent list a moment later
    onEvent('runs.changed', (p) => {
      counts.value = p.counts
      later()
    }),
    onEvent('scan.progress', (p) => {
      const was = scan.value.scanning
      scan.value = p
      if (was && !p.scanning) later() // the scan finished: the tree changed
    }),
    onEvent('app.command', ({ name, args }) => void runCommand(name, args)),
    onEvent('app.drop', ({ paths }) => void openPaths(paths).catch((e) => toast.error(errorText(e)))),
    onEvent('app.toast', ({ kind, text }) => void toast.show(kind, text)),
  )
  // only a safety net now: the engine pushes `runs.changed`
  const poll = setInterval(() => { if (!document.hidden) void pollRunning() }, 30000)
  stops.push(() => clearInterval(poll))
  return () => stops.forEach((s) => s())
}
