/** Layout state: side panel (visible, width, which view), the optional right column of a page, and the bottom panel. */
import { effect, signal } from '@preact/signals'
import { readStore, writeStore } from './storage'

export type SideView = 'explorer' | 'sequences' | 'runs'

const num = (key: string, dflt: number, lo: number, hi: number): number => {
  const v = parseInt(readStore(key) ?? '', 10)
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt
}

export const sideOn = signal(readStore('sr.side') !== '0')
export const sideW = signal(num('sr.sideW', 280, 180, 640))
export const sideView = signal<SideView>((['explorer', 'sequences', 'runs'] as const).find((v) => v === readStore('sr.sideView')) ?? 'explorer')
/** The right-hand column of script pages (panels read it; Ctrl+Alt+B toggles it). */
export const side2On = signal(readStore('sr.side2') !== '0')
export const bottomOn = signal(readStore('sr.bottom') === '1')
export const bottomH = signal(num('sr.bottomH', 240, 80, 900))
/** How a run tab (lower tab) is shown next to its script or sequence: full width, side by side, or stacked. */
export type RunView = 'full' | 'side' | 'stack'
export const RUN_VIEWS: RunView[] = ['full', 'side', 'stack']
export const runView = signal<RunView>(RUN_VIEWS.find((v) => v === readStore('sr.runView')) ?? 'full')
/** Share of the area (percent) the script or sequence keeps while a run is shown beside or under it. */
export const runSplit = signal(num('sr.runSplit', 50, 20, 80))
/** Set by the shell: true when the native menu replaces the HTML menu bar. */
export const nativeMenu = signal(false)

export const toggleSide = (): void => { sideOn.value = !sideOn.value }
export const toggleSide2 = (): void => { side2On.value = !side2On.value }
export const toggleBottom = (): void => { bottomOn.value = !bottomOn.value }

export function showSideView(v: SideView): void {
  sideView.value = v
  sideOn.value = true
}

/** Mirror the state onto <html> (the old stylesheet is driven by these classes and variables) and persist it. */
export function initLayout(): () => void {
  const root = document.documentElement
  const stops = [
    effect(() => {
      root.classList.toggle('side-off', !sideOn.value)
      writeStore('sr.side', sideOn.value ? '1' : '0')
    }),
    effect(() => {
      root.style.setProperty('--side-w', `${sideW.value}px`)
      writeStore('sr.sideW', String(sideW.value))
    }),
    effect(() => {
      root.classList.toggle('side2-off', !side2On.value)
      writeStore('sr.side2', side2On.value ? '1' : '0')
    }),
    effect(() => {
      root.classList.toggle('bottom-on', bottomOn.value)
      writeStore('sr.bottom', bottomOn.value ? '1' : '0')
    }),
    effect(() => {
      root.style.setProperty('--bp-h', `${bottomH.value}px`)
      writeStore('sr.bottomH', String(bottomH.value))
    }),
    effect(() => {
      writeStore('sr.sideView', sideView.value)
    }),
    effect(() => {
      writeStore('sr.runView', runView.value)
      writeStore('sr.runSplit', String(Math.round(runSplit.value)))
    }),
    effect(() => {
      root.style.setProperty('--mb-h', nativeMenu.value ? '0px' : '30px')
    }),
  ]
  return () => stops.forEach((s) => s())
}
