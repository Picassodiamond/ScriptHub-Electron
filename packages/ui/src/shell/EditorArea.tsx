/**
 * The editor area: one mounted panel per open tab (inactive ones hidden, so their state survives). A run tab (a lower
 * tab) is shown alone, or together with the page it belongs to, side by side or stacked (the run view setting).
 */
import { Component, type ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { Icon } from '../components/Icon'
import { activeKey, activeTab, getPanel, openTab, runSplit, runView, tabs, type Tab } from '../core'

class Boundary extends Component<{ tab: Tab; children?: ComponentChildren }, { error: Error | null }> {
  state = { error: null as Error | null }
  componentDidCatch(error: Error) {
    console.error(`panel ${this.props.tab.kind} crashed:`, error)
    this.setState({ error })
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div class="panel-error" role="alert">
        <h2>This page failed to display</h2>
        <p class="muted">{this.state.error.message}</p>
        <button type="button" class="btn" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    )
  }
}

/** Below this width a side-by-side run is shown stacked: two columns would be too narrow to read. */
const NARROW = 900

export function EditorArea() {
  const list = tabs.value
  const host = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const el = host.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth > 0 && el.clientWidth < NARROW))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const front = activeTab.value
  const ownerKey = front?.owner ?? null
  const mode = runView.value === 'side' && narrow ? 'stack' : runView.value
  const split = !!ownerKey && mode !== 'full'

  const startDrag = (e: PointerEvent) => {
    const el = host.current
    if (!el) return
    e.preventDefault()
    const r = el.getBoundingClientRect()
    const cls = mode === 'side' ? 'is-resizing' : 'is-resizing-v'
    const move = (m: PointerEvent) => {
      const f = mode === 'side' ? (m.clientX - r.left) / r.width : (m.clientY - r.top) / r.height
      runSplit.value = Math.max(20, Math.min(80, f * 100))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.documentElement.classList.remove(cls)
    }
    document.documentElement.classList.add(cls)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      ref={host} class={`main-body tab-host ${split ? `is-split split-${mode}` : ''}`} id="main-body"
      style={split ? { '--split': `${runSplit.value}%` } : undefined}
    >
      {list.map((t) => {
        const entry = getPanel(t.kind)
        const isOwner = split && t.key === ownerKey
        const active = t.key === activeKey.value || isOwner
        const Panel = entry?.component
        return (
          <div
            key={t.key} class={`tab-panel ${entry?.options.fill ? 'is-fill' : ''} ${isOwner ? 'is-owner' : ''} ${split && t.key === activeKey.value ? 'is-child' : ''}`}
            role="tabpanel" hidden={!active} data-kind={t.kind}
          >
            <Boundary tab={t}>
              {Panel ? <Panel tab={t} active={active} /> : <div class="empty"><h2>No panel for "{t.kind}"</h2></div>}
            </Boundary>
          </div>
        )
      })}
      {split && (
        <div
          class="split-divider" role="separator" aria-orientation={mode === 'side' ? 'vertical' : 'horizontal'} aria-label="Resize" tabIndex={0}
          onPointerDown={startDrag as any}
          onKeyDown={(e) => {
            const back = mode === 'side' ? 'ArrowLeft' : 'ArrowUp'
            const fwd = mode === 'side' ? 'ArrowRight' : 'ArrowDown'
            if (e.key === back) runSplit.value = Math.max(20, runSplit.value - 3)
            else if (e.key === fwd) runSplit.value = Math.min(80, runSplit.value + 3)
          }}
        />
      )}
      {!list.length && (
        <div class="empty" style="margin:12vh auto">
          <Icon name="home" />
          <h2>No page is open</h2>
          <p>Open one from the explorer, or press <kbd>Ctrl</kbd> <kbd>K</kbd> to search.</p>
          <button type="button" class="btn btn-primary" onClick={() => openTab({ kind: 'home' })}>Open Home</button>
        </div>
      )}
    </div>
  )
}
