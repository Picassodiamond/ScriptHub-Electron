import { effect } from '@preact/signals'
import { useEffect } from 'preact/hooks'
import { IconSprite } from '../components/Icon'
import { activeTab, nativeMenu, shell } from '../core'
import { ActivityBar } from './ActivityBar'
import { BottomPanel } from './BottomPanel'
import { EditorArea } from './EditorArea'
import { MenuBar } from './MenuBar'
import { ConfirmDialog, HelpSheet, Toasts } from './Overlays'
import { Palette } from './Palette'
import { RunStrip } from './RunStrip'
import { SidePanel } from './SidePanel'
import { StatusBar } from './StatusBar'
import { TabStrip } from './TabStrip'

/** The workbench: menu bar | activity bar | side panel | editor area (tabs, pages, bottom panel) | status bar. */
export function App() {
  useEffect(() => effect(() => {
    const s = shell.value
    const t = activeTab.value
    const f = s?.folder.folder
    document.title = `${t && t.kind !== 'home' ? `${t.title} — ` : ''}${f ? `${f.name} · ` : ''}ScriptHub`
  }), [])

  return (
    <div class="wb">
      <IconSprite />
      {!nativeMenu.value && <MenuBar />}
      <ActivityBar />
      <SidePanel />
      <main class="main" id="main">
        <TabStrip />
        <RunStrip />
        <EditorArea />
        <BottomPanel />
      </main>
      <StatusBar />
      <Palette />
      <ConfirmDialog />
      <HelpSheet />
      <Toasts />
    </div>
  )
}
