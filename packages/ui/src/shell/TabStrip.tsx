/** The tab strip: click to activate, × or middle-click to close, drag to reorder, right-click for Close / Close others / Close all. */
import { useEffect, useRef, useState } from 'preact/hooks'
import { Icon } from '../components/Icon'
import { activateTab, activeUpperKey, childrenOf, closeAll, closeOthers, closeTab, moveTab, tabStatus, upperTabs } from '../core'

export function TabStrip() {
  const list = upperTabs.value
  const activeKey = { value: activeUpperKey.value }
  const statuses = tabStatus.value
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null)
  const strip = useRef<HTMLDivElement>(null)

  useEffect(() => {
    strip.current?.querySelector('.vtab.is-active')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activeKey.value, list.length])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  return (
    <div class="tabstrip" role="tablist" aria-label="Open pages" ref={strip}>
      {list.map((t, i) => (
        <div
          key={t.key} role="tab" tabIndex={0} aria-selected={t.key === activeKey.value} title={t.title}
          class={`vtab ${t.key === activeKey.value ? 'is-active' : ''} ${drag?.from === i ? 'is-dragging' : ''} ${drag && drag.over === i && drag.from !== i ? 'is-over' : ''}`}
          draggable
          onClick={() => activateTab(t.key)}
          onMouseDown={(e) => { if (e.button === 1) e.preventDefault() }}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.key) } }}
          onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, key: t.key }) }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateTab(t.key) } }}
          onDragStart={(e) => { setDrag({ from: i, over: i }); e.dataTransfer?.setData('text/plain', t.key) }}
          onDragOver={(e) => { if (drag) { e.preventDefault(); if (drag.over !== i) setDrag({ ...drag, over: i }) } }}
          onDrop={(e) => { e.preventDefault(); if (drag) moveTab(drag.from, i); setDrag(null) }}
          onDragEnd={() => setDrag(null)}
        >
          <Icon name={t.icon} small />
          <span class="vtab-title">{t.title}</span>
          {(() => {
            const kids = childrenOf(t.key)
            const running = kids.some((c) => statuses[c.key] === 'running' || statuses[c.key] === 'paused')
            const failed = !running && kids.length > 0 && statuses[kids[kids.length - 1].key] === 'failed'
            return running
              ? <span class="vtab-dot is-running" title="A run is in progress" />
              : failed ? <span class="vtab-dot is-failed" title="The latest run failed" /> : null
          })()}
          <button type="button" class="vtab-x" aria-label={`Close ${t.title}`} title="Close" tabIndex={-1} onClick={(e) => { e.stopPropagation(); closeTab(t.key) }}>
            <Icon name="x" />
          </button>
        </div>
      ))}
      {!list.length && <div class="tabstrip-empty">No page open</div>}
      {menu && (
        <div class="ctxmenu" role="menu" style={{ left: `${menu.x}px`, top: `${menu.y}px` }} onMouseDown={(e) => e.stopPropagation()}>
          <button type="button" class="menu-item" role="menuitem" onClick={() => { closeTab(menu.key); setMenu(null) }}>Close</button>
          <button type="button" class="menu-item" role="menuitem" disabled={list.length < 2} onClick={() => { closeOthers(menu.key); setMenu(null) }}>Close others</button>
          <button type="button" class="menu-item" role="menuitem" onClick={() => { closeAll(); setMenu(null) }}>Close all</button>
        </div>
      )}
    </div>
  )
}
