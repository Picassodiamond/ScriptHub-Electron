/** The collapsible bottom panel (Ctrl+J): shown when the active page registered a `bottom` component; drag its top edge to resize. */
import { useRef } from 'preact/hooks'
import { activeTab, bottomH, bottomOn, getPanel, toggleBottom } from '../core'

export function BottomPanel() {
  const tab = activeTab.value
  const entry = tab ? getPanel(tab.kind) : undefined
  const Bottom = entry?.options.bottom
  const drag = useRef<{ y: number; h: number } | null>(null)
  if (!tab || !Bottom) return null

  const down = (e: PointerEvent) => {
    drag.current = { y: e.clientY, h: bottomH.value }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    document.documentElement.classList.add('is-resizing-v')
  }
  const move = (e: PointerEvent) => {
    if (!drag.current) return
    const max = Math.max(120, window.innerHeight - 220)
    bottomH.value = Math.round(Math.max(80, Math.min(max, drag.current.h + (drag.current.y - e.clientY))))
  }
  const up = () => {
    drag.current = null
    document.documentElement.classList.remove('is-resizing-v')
  }

  return (
    <section class="bottom-panel" aria-label={entry?.options.bottomTitle ?? 'Bottom panel'}>
      <div class="bp-resize" role="separator" aria-orientation="horizontal" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      <button type="button" class="bp-head" aria-expanded={bottomOn.value} onClick={toggleBottom}>
        <span class="bp-caret" />
        <span>{entry?.options.bottomTitle ?? 'Panel'}</span>
        <span class="spacer" />
        <kbd>Ctrl J</kbd>
      </button>
      {bottomOn.value && <div class="bp-body"><Bottom tab={tab} active /></div>}
    </section>
  )
}
