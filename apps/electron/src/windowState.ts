/** Window size, position and maximised state, kept in the Electron user-data folder (not in runtime/). */
import fs from 'node:fs'
import path from 'node:path'
import { app, screen, type BrowserWindow } from 'electron'

interface State { x?: number; y?: number; width: number; height: number; maximized: boolean }

const DEFAULT: State = { width: 1360, height: 860, maximized: false }
const file = () => path.join(app.getPath('userData'), 'window-state.json')

function visible(s: State): boolean {
  if (s.x === undefined || s.y === undefined) return true
  return screen.getAllDisplays().some((d) => {
    const b = d.workArea
    return s.x! < b.x + b.width - 40 && s.x! + s.width > b.x + 40 && s.y! >= b.y - 20 && s.y! < b.y + b.height - 40
  })
}

export function loadWindowState(): State {
  try {
    const s = { ...DEFAULT, ...JSON.parse(fs.readFileSync(file(), 'utf8')) } as State
    if (s.width < 600 || s.height < 400 || !visible(s)) return { ...DEFAULT }
    return s
  } catch {
    return { ...DEFAULT }
  }
}

/** Save on resize/move (debounced) and on close. */
export function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null
  const save = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
    const maximized = win.isMaximized()
    const b = maximized ? undefined : win.getNormalBounds()
    const prev = loadWindowState()
    const state: State = b ? { ...b, maximized } : { ...prev, maximized }
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true })
      fs.writeFileSync(file(), JSON.stringify(state))
    } catch {
      /* not worth failing for */
    }
  }
  const later = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, 400)
  }
  win.on('resize', later)
  win.on('move', later)
  win.on('maximize', later)
  win.on('unmaximize', later)
  win.on('close', save)
}
