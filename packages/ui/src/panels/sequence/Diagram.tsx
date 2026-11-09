/**
 * The sequence diagram: boxes = steps, arrows = when the next step runs. Shared by the editor and the run page.
 * Port of the Diagram class in static/js/sequence.js (plain DOM + SVG, no library): drag boxes (20px grid), drag the dot under
 * a box onto another to connect, click an arrow's label to change when it applies, drop scripts from the explorer, pan,
 * zoom (Ctrl+wheel), Fit, a small mini-map, Delete removes the selected box. All edits are reported through callbacks; the
 * owner stores them and passes the stored graph back in (the engine decides).
 */
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { Ref } from 'preact'
import { Icon, Lang } from '../../components/Icon'
import { readJson, writeJson } from '../../core'
import {
  clamp, curve, fitView, freeSlot, geometry, GRID, H, linkState, MAX_ZOOM, MIME, MIN_ZOOM, snap, W, WHEN, WHEN_TEXT, WHEN_TITLE,
  type Pt, type View, type When,
} from './geometry'
import './sequence.css'

export interface DiagramStep {
  id: string
  n: number
  name: string
  ext?: string
  path?: string
  script?: string
  host?: string
  source?: string
  problem?: string
  join?: string
  incoming?: number
  x: number
  y: number
  // run overlay
  status?: string
  status_label?: string
  run_id?: string | null
  hold?: boolean
  held?: boolean
}
export interface DiagramLink { from: string; to: string; when: When }
export interface BoxAction { icon: string; title: string; on?: boolean }

export interface DiagramHandle {
  zoom(factor: number): void
  fit(): void
  /** The size of the canvas (tests and callers that lay out against it). */
  size(): { width: number; height: number }
}

export interface DiagramProps {
  steps: DiagramStep[]
  links: DiagramLink[]
  editable?: boolean
  /** A run is going: no edits (box actions and selecting still work). */
  locked?: boolean
  selected?: string | null
  viewKey?: string
  emptyTitle?: string
  emptyText?: string
  handle?: Ref<DiagramHandle>
  boxAction?: (s: DiagramStep) => BoxAction | null
  onBoxAction?: (id: string) => void
  onSelect?: (id: string | null) => void
  onOpen?: (id: string) => void
  onMove?: (id: string, x: number, y: number) => void
  onLink?: (from: string, to: string, when: When) => void
  onUnlink?: (from: string, to: string) => void
  onRemove?: (id: string) => void
  onAdd?: (script: string, x: number, y: number) => void
}

type Drag =
  | { type: 'pan'; sx: number; sy: number; vx: number; vy: number; moved: boolean }
  | { type: 'node'; id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean }
  | { type: 'link'; from: string }

const noHandle: { current: DiagramHandle | null } = { current: null }
const MINI_W = 150
const MINI_H = 96

function nodeAt(clientX: number, clientY: number, canvas: HTMLElement | null): HTMLElement | null {
  const hit = (document.elementFromPoint?.(clientX, clientY) ?? null) as HTMLElement | null
  const n = hit?.closest?.('.seq-node') as HTMLElement | null
  return n && canvas?.contains(n) ? n : null
}

export function Diagram(props: DiagramProps) {
  const { steps, links, editable = false, locked = false, selected = null } = props
  const canvas = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const [view, setView] = useState<View>(() => ({ x: 0, y: 0, z: 1 }))
  const viewRef = useRef(view)
  viewRef.current = view
  const [dragPos, setDragPos] = useState<Record<string, Pt>>({})
  const [temp, setTemp] = useState<string | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const [mode, setMode] = useState<'' | 'panning' | 'linking' | 'drop'>('')
  const stepsRef = useRef(steps)
  stepsRef.current = steps
  const props_ = useRef(props)
  props_.current = props

  const pos = useMemo(() => {
    const m: Record<string, { x: number; y: number }> = {}
    for (const s of steps) m[s.id] = dragPos[s.id] ? { x: dragPos[s.id][0], y: dragPos[s.id][1] } : { x: s.x, y: s.y }
    return m
  }, [steps, dragPos])
  const byId = useMemo(() => Object.fromEntries(steps.map((s) => [s.id, s])), [steps])
  const runMode = steps.some((s) => s.status)
  const statusOf = useMemo(() => Object.fromEntries(steps.map((s) => [s.id, s.status])), [steps])
  const canEdit = editable && !locked

  // ---- the view: remembered per sequence, else fitted once the boxes are there
  const rect = () => canvas.current?.getBoundingClientRect() ?? ({ width: 0, height: 0, left: 0, top: 0 } as DOMRect)
  const fit = useCallback(() => {
    const r = rect()
    setView(fitView(stepsRef.current, r.width, r.height))
  }, [])
  const restored = useRef(false)
  useLayoutEffect(() => {
    if (restored.current || !steps.length) return
    restored.current = true
    const saved = props.viewKey ? readJson<Partial<View> | null>(props.viewKey, null) : null
    if (saved && [saved.x, saved.y, saved.z].every((n) => typeof n === 'number' && isFinite(n))) setView({ x: saved.x!, y: saved.y!, z: clamp(saved.z!, MIN_ZOOM, MAX_ZOOM) })
    else fit()
  }, [steps.length, fit, props.viewKey])
  useEffect(() => {
    if (!props.viewKey || !restored.current) return
    const t = setTimeout(() => writeJson(props.viewKey!, view), 300)
    return () => clearTimeout(t)
  }, [view, props.viewKey])

  const zoomAt = useCallback((f: number, cx: number, cy: number) => {
    setView((v) => {
      const z = clamp(v.z * f, MIN_ZOOM, MAX_ZOOM)
      return { x: cx - (cx - v.x) * (z / v.z), y: cy - (cy - v.y) * (z / v.z), z }
    })
  }, [])
  useImperativeHandle(props.handle ?? noHandle, () => ({
    zoom: (f: number) => { const r = rect(); zoomAt(f, r.width / 2, r.height / 2) },
    fit,
    size: () => { const r = rect(); return { width: r.width, height: r.height } },
  }), [fit, zoomAt])

  // wheel must be non-passive to stop the page scrolling
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top)
      else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const toWorld = (cx: number, cy: number) => {
    const r = rect()
    const v = viewRef.current
    return { x: (cx - r.left - v.x) / v.z, y: (cy - r.top - v.y) / v.z }
  }

  // ---- pointer: pan, move a box, draw an arrow
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || drag.current) return
    const t = e.target as HTMLElement
    if (t.closest('.seq-x, .seq-open, .seq-boxbtn, .seq-label')) return // their own click handlers
    const node = t.closest('.seq-node') as HTMLElement | null
    const p = props_.current
    if (p.editable && !p.locked && t.closest('.seq-port') && node) {
      drag.current = { type: 'link', from: node.dataset.id! }
      setMode('linking')
    } else if (node) {
      const s = stepsRef.current.find((x) => x.id === node.dataset.id)
      if (!s) return
      drag.current = { type: 'node', id: s.id, sx: e.clientX, sy: e.clientY, ox: s.x, oy: s.y, moved: false }
    } else {
      drag.current = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y, moved: false }
      setMode('panning')
    }
    canvas.current?.focus({ preventScroll: true })
    try { canvas.current?.setPointerCapture(e.pointerId) } catch { /* not supported here */ }
    e.preventDefault()
  }

  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current
    if (!d) return
    if (d.type === 'pan') {
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
      setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }))
    } else if (d.type === 'node') {
      const p = props_.current
      if (!p.editable || p.locked) return
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy
      if (!d.moved && Math.abs(dx) + Math.abs(dy) < 5) return
      d.moved = true
      const z = viewRef.current.z
      setDragPos({ [d.id]: [snap(d.ox + dx / z), snap(d.oy + dy / z)] })
    } else {
      const a = stepsRef.current.find((s) => s.id === d.from)
      if (!a) return
      const w = toWorld(e.clientX, e.clientY)
      const n = nodeAt(e.clientX, e.clientY, canvas.current)
      setTarget(n && n.dataset.id !== d.from ? n.dataset.id! : null)
      setTemp(curve([a.x + W / 2, a.y + H], [0, 1], [w.x, w.y], [0, w.y >= a.y + H ? -1 : 1]).d)
    }
  }

  const endDrag = (e: PointerEvent, cancelled: boolean) => {
    const d = drag.current
    if (!d) return
    drag.current = null
    setMode('')
    setTemp(null)
    setTarget(null)
    const p = props_.current
    const moved = d.type === 'node' && d.moved
    if (d.type === 'node') {
      const np = dragPosRef.current[d.id]
      setDragPos({})
      if (cancelled) return
      if (moved && np) { if (np[0] !== d.ox || np[1] !== d.oy) p.onMove?.(d.id, np[0], np[1]) }
      else if (!moved) p.onSelect?.(d.id)
      return
    }
    if (cancelled) return
    if (d.type === 'pan') { if (!d.moved) p.onSelect?.(null) }
    else {
      const n = nodeAt(e.clientX, e.clientY, canvas.current)
      const to = n?.dataset.id
      if (to && to !== d.from && !linksRef.current.some((k) => k.from === d.from && k.to === to)) p.onLink?.(d.from, to, 'success')
    }
  }
  const dragPosRef = useRef(dragPos)
  dragPosRef.current = dragPos
  const linksRef = useRef(links)
  linksRef.current = links

  const onClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement
    const p = props_.current
    const box = t.closest('.seq-boxbtn')
    if (box) return void p.onBoxAction?.((box.closest('.seq-node') as HTMLElement).dataset.id!)
    const open = t.closest('.seq-open')
    if (open) return void p.onOpen?.((open.closest('.seq-node') as HTMLElement).dataset.id!)
    if (!p.editable || p.locked) return
    const x = t.closest('.seq-x')
    if (x) return void p.onRemove?.((x.closest('.seq-node') as HTMLElement).dataset.id!)
    const label = t.closest('.seq-label') as HTMLElement | null
    if (!label) return
    const { from, to } = label.dataset as { from: string; to: string }
    if (t.closest('.seq-unlink')) return void p.onUnlink?.(from, to)
    if (t.closest('.seq-when')) {
      const link = linksRef.current.find((k) => k.from === from && k.to === to)
      if (link) p.onLink?.(from, to, WHEN[(WHEN.indexOf(link.when) + 1) % WHEN.length])
    }
  }

  const onDblClick = (e: MouseEvent) => {
    const p = props_.current
    if (!p.onOpen) return
    // the canvas holds the pointer while a box is pressed, so look for the box under the pointer
    const hit = (document.elementFromPoint?.(e.clientX, e.clientY) ?? e.target) as HTMLElement
    const n = nodeAt(e.clientX, e.clientY, canvas.current) ?? (hit.closest?.('.seq-node') as HTMLElement | null)
    if (n && !hit.closest?.('.seq-x, .seq-port, .seq-open, .seq-boxbtn')) p.onOpen(n.dataset.id!)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== canvas.current) return
    const p = props_.current
    if ((e.key === 'Delete' || e.key === 'Backspace') && p.selected && p.editable && !p.locked) {
      e.preventDefault()
      p.onRemove?.(p.selected)
    } else if (e.key === 'Escape') p.onSelect?.(null)
    else if (p.selected && p.editable && !p.locked && e.key.startsWith('Arrow')) {
      // nudge the selected box by one grid cell
      const s = stepsRef.current.find((x) => x.id === p.selected)
      if (!s) return
      e.preventDefault()
      const dx = e.key === 'ArrowLeft' ? -GRID : e.key === 'ArrowRight' ? GRID : 0
      const dy = e.key === 'ArrowUp' ? -GRID : e.key === 'ArrowDown' ? GRID : 0
      p.onMove?.(s.id, snap(s.x + dx), snap(s.y + dy))
    }
  }

  // ---- scripts dragged in from the explorer
  const ours = (e: DragEvent) => !!e.dataTransfer && [...(e.dataTransfer.types ?? [])].includes(MIME)
  const onDragOver = (e: DragEvent) => {
    if (!ours(e) || !canEdit) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    setMode('drop')
  }
  const onDragLeave = (e: DragEvent) => {
    if (!e.relatedTarget || !canvas.current?.contains(e.relatedTarget as Node)) setMode((m) => (m === 'drop' ? '' : m))
  }
  const onDrop = (e: DragEvent) => {
    setMode((m) => (m === 'drop' ? '' : m))
    if (!ours(e) || !canEdit) return
    e.preventDefault()
    const w = toWorld(e.clientX || 0, e.clientY || 0) // a drop without coordinates (some hosts) lands at the top left
    const id = e.dataTransfer!.getData(MIME)
    if (id) {
      const at = freeSlot(snap(w.x - W / 2), snap(w.y - H / 2), steps.map((s) => pos[s.id]))
      props_.current.onAdd?.(id, at.x, at.y)
    }
  }

  // ---- drawing
  const arrows = links.map((k) => {
    const a = pos[k.from], b = pos[k.to]
    if (!a || !b) return null
    const g = geometry(a, b)
    const state = runMode ? linkState(k, statusOf) : null
    return { k, g, state }
  }).filter(Boolean) as Array<{ k: DiagramLink; g: ReturnType<typeof geometry>; state: boolean | null }>

  const bounds = useMemo(() => {
    if (!steps.length) return null
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const s of steps) { x0 = Math.min(x0, pos[s.id].x); y0 = Math.min(y0, pos[s.id].y); x1 = Math.max(x1, pos[s.id].x + W); y1 = Math.max(y1, pos[s.id].y + H) }
    return { x0, y0, x1, y1 }
  }, [steps, pos])

  const canvasClass = ['seq-canvas', !editable && 'seq-readonly', locked && 'is-locked', mode === 'panning' && 'is-panning', mode === 'linking' && 'is-linking', mode === 'drop' && 'is-drop']
    .filter(Boolean).join(' ')

  return (
    <div
      ref={canvas} class={canvasClass} tabIndex={0} role="application" aria-label="Sequence diagram" data-testid="seq-canvas"
      style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${GRID * view.z}px ${GRID * view.z}px` }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={(e) => endDrag(e, false)} onPointerCancel={(e) => endDrag(e, true)}
      onClick={onClick} onDblClick={onDblClick} onKeyDown={onKeyDown}
      onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
    >
      <div class="seq-world" style={{ transform: `translate(${view.x}px,${view.y}px) scale(${view.z})` }}>
        <svg class="seq-links" width="1" height="1" aria-hidden="true">
          <defs>
            {[...WHEN, 'temp'].map((w) => (
              <marker key={w} id={`seq-arrow-${w}`} class={`seq-arrow-${w}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto">
                <path d="M0,0 L10,5 L0,10 z" />
              </marker>
            ))}
          </defs>
          <g>
            {arrows.map(({ k, g, state }) => (
              <path
                key={`${k.from}>${k.to}`} d={g.d} class={`seq-link seq-link-${k.when} ${state === true ? 'is-taken' : ''} ${state === false ? 'is-dead' : ''}`}
                marker-end={`url(#seq-arrow-${k.when})`} data-from={k.from} data-to={k.to}
              />
            ))}
          </g>
          {temp && <path class="seq-temp" d={temp} marker-end="url(#seq-arrow-temp)" />}
        </svg>
        <div class="seq-nodes">
          {steps.map((s) => {
            const act = props.boxAction?.(s) ?? null
            const bits = s.problem ? [s.problem] : [s.source, s.host]
            if (!s.problem && s.join === 'any' && (s.incoming ?? 0) > 1) bits.push('starts after the first arrow')
            const sub = bits.filter(Boolean).join(' · ')
            return (
              <div
                key={s.id} data-id={s.id} title={s.path || ''}
                class={['seq-node', s.problem && 'has-problem', s.run_id && 'has-run', s.held && 'is-held', s.id === selected && 'is-selected', s.id === target && 'is-target', dragPos[s.id] && 'is-dragging'].filter(Boolean).join(' ')}
                data-status={s.status || undefined}
                style={{ left: `${pos[s.id].x}px`, top: `${pos[s.id].y}px` }}
              >
                <div class="seq-node-top">
                  <span class="seq-n">{s.n}</span>
                  {s.ext && <Lang ext={s.ext} />}
                  <span class="seq-node-name">{s.name}</span>
                  {act && (
                    <button type="button" class={`seq-boxbtn ${act.on ? 'is-on' : ''}`} title={act.title} aria-label={`${act.title} (step ${s.n})`} aria-pressed={act.on ? 'true' : undefined}>
                      <Icon name={act.icon} />
                    </button>
                  )}
                  {props.onOpen && (
                    <button type="button" class="seq-open" title="Open the script (double-click the step)" aria-label={`Open the script of step ${s.n}`}><Icon name="file" /></button>
                  )}
                  {editable && <button type="button" class="seq-x" title="Remove step" aria-label={`Remove step ${s.n}`}>×</button>}
                </div>
                <div class="seq-node-sub">
                  {s.status ? (
                    <>
                      <span class={`st st-sm st-${s.held ? 'paused' : s.status}`}>{s.held ? 'Paused here' : s.status_label || s.status}</span>
                      <span>{s.host || ''}</span>
                    </>
                  ) : <span title={sub}>{sub}</span>}
                </div>
                {editable && <span class="seq-port" title="Drag onto another step to connect" />}
              </div>
            )
          })}
        </div>
        <div class="seq-labels">
          {arrows.map(({ k, g, state }) => (
            <div
              key={`${k.from}>${k.to}`} class={`seq-label seq-when-${k.when} ${state === false ? 'is-dead' : ''}`} data-from={k.from} data-to={k.to}
              style={{ left: `${g.mid[0]}px`, top: `${g.mid[1]}px` }}
            >
              {editable ? (
                <>
                  <button type="button" class="seq-when" title={`${WHEN_TITLE[k.when]} — click to change`}>{WHEN_TEXT[k.when]}</button>
                  <button type="button" class="seq-unlink" title="Remove this arrow" aria-label="Remove arrow">×</button>
                </>
              ) : <span title={WHEN_TITLE[k.when]}>{WHEN_TEXT[k.when]}</span>}
            </div>
          ))}
        </div>
      </div>
      {!steps.length && (
        <div class="seq-empty">
          <Icon name="sequence" />
          {props.emptyTitle && <h2>{props.emptyTitle}</h2>}
          {props.emptyText && <p class="small">{props.emptyText}</p>}
        </div>
      )}
      {bounds && steps.length > 1 && <MiniMap steps={steps} pos={pos} bounds={bounds} view={view} canvas={canvas} setView={setView} />}
    </div>
  )
}

/** A small overview of the whole diagram; a click centres the view there. */
function MiniMap({ steps, pos, bounds, view, canvas, setView }: {
  steps: DiagramStep[]
  pos: Record<string, { x: number; y: number }>
  bounds: { x0: number; y0: number; x1: number; y1: number }
  view: View
  canvas: { current: HTMLDivElement | null }
  setView: (f: (v: View) => View) => void
}) {
  const pad = 20
  const bw = bounds.x1 - bounds.x0 + 2 * pad, bh = bounds.y1 - bounds.y0 + 2 * pad
  const k = Math.min(MINI_W / bw, MINI_H / bh)
  const r = canvas.current?.getBoundingClientRect()
  const vx = -view.x / view.z, vy = -view.y / view.z, vw = (r?.width ?? 0) / view.z, vh = (r?.height ?? 0) / view.z
  const go = (e: MouseEvent) => {
    e.stopPropagation()
    const box = (e.currentTarget as SVGElement).getBoundingClientRect()
    const wx = bounds.x0 - pad + (e.clientX - box.left) / k, wy = bounds.y0 - pad + (e.clientY - box.top) / k
    const rr = canvas.current?.getBoundingClientRect()
    if (rr) setView((v) => ({ ...v, x: rr.width / 2 - wx * v.z, y: rr.height / 2 - wy * v.z }))
  }
  return (
    <svg
      class="seq-minimap" width={Math.ceil(bw * k)} height={Math.ceil(bh * k)} viewBox={`${bounds.x0 - pad} ${bounds.y0 - pad} ${bw} ${bh}`} aria-label="Overview"
      onPointerDown={(e) => e.stopPropagation()} onClick={go}
    >
      {steps.map((s) => <rect key={s.id} x={pos[s.id].x} y={pos[s.id].y} width={W} height={H} rx="8" class={`mm-box ${s.status ? `mm-${s.status}` : ''}`} />)}
      {r && r.width > 0 && <rect class="mm-view" x={vx} y={vy} width={vw} height={vh} />}
    </svg>
  )
}
