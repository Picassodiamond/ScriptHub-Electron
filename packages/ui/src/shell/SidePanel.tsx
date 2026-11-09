import { useRef } from 'preact/hooks'
import { sideOn, sideView, sideW } from '../core'
// (the old stylesheet hides the panel with the html.side-off class set by core/layout)
import { Explorer } from './Explorer'
import { RunsSide } from './RunsSide'
import { SequencesSide } from './SequencesSide'

/** The side panel with its drag handle (smooth, pointer-captured; width remembered). */
export function SidePanel() {
  const drag = useRef<{ x: number; w: number } | null>(null)
  const down = (e: PointerEvent) => {
    drag.current = { x: e.clientX, w: sideW.value }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    document.documentElement.classList.add('is-resizing')
  }
  const move = (e: PointerEvent) => {
    if (drag.current) sideW.value = Math.round(Math.max(180, Math.min(640, drag.current.w + e.clientX - drag.current.x)))
  }
  const up = () => {
    drag.current = null
    document.documentElement.classList.remove('is-resizing')
  }
  return (
    <aside class="side" id="side" aria-label="Side panel" aria-hidden={!sideOn.value}>
      {sideView.value === 'sequences' ? <SequencesSide /> : sideView.value === 'runs' ? <RunsSide /> : <Explorer />}
      <div class="side-resizer" role="separator" aria-orientation="vertical" aria-label="Resize side panel" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDblClick={() => { sideW.value = 280 }} />
    </aside>
  )
}
