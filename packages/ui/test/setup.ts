import { afterEach, beforeEach } from 'vitest'
import { cleanup } from '@testing-library/preact'
import { demoTransport, type MockTransport } from '@scripthub/client'
import { setTransport } from '../src/core/api'
import { activeKey, tabs, workspaceKey } from '../src/core/tabs'
import { shell, scan, counts, hostInfo } from '../src/core/shellState'
import { toasts } from '../src/core/toast'
import { confirmState } from '../src/core/confirm'
import { helpOpen, paletteOpen } from '../src/core/overlays'
import { bottomOn, nativeMenu, sideOn, sideView } from '../src/core/layout'

// jsdom lacks these
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as any
}
Element.prototype.scrollIntoView = function () {}
;(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }

export let transport: MockTransport

/** A fresh demo engine and empty UI state for every test. */
beforeEach(() => {
  localStorage.clear()
  transport = demoTransport()
  setTransport(transport)
  tabs.value = []
  activeKey.value = null
  workspaceKey.value = 'none'
  shell.value = null
  scan.value = { scanning: false, version: 0, count: 0 }
  counts.value = { running: 0, queued: 0 }
  hostInfo.value = null
  toasts.value = []
  confirmState.value = null
  paletteOpen.value = false
  helpOpen.value = false
  bottomOn.value = false
  nativeMenu.value = false
  sideOn.value = true
  sideView.value = 'explorer'
})

afterEach(() => cleanup())
