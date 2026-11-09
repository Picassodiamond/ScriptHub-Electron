/** Pure helpers of the sequence diagram: box geometry, arrow curves, layout, and arrow state (port of static/js/sequence.js). */
import type { GraphLink } from '@scripthub/protocol'

export const W = 200
export const H = 60
export const GRID = 20
export const MIME = 'application/x-scripthub-script'
export const WHEN = ['success', 'failure', 'always'] as const
export type When = (typeof WHEN)[number]
export const WHEN_TEXT: Record<When, string> = { success: '✓ succeeded', failure: '✗ failed', always: '↷ always' }
export const WHEN_TITLE: Record<When, string> = {
  success: 'The next step runs if this one succeeded',
  failure: 'The next step runs if this one did not succeed',
  always: 'The next step runs when this one has finished, either way',
}
export const FINAL = ['success', 'failed', 'timed_out', 'cancelled', 'interrupted']
export const MIN_ZOOM = 0.3
export const MAX_ZOOM = 1.6

export type Pt = [number, number]
export interface Box { x: number; y: number }
export interface View { x: number; y: number; z: number }

export const snap = (v: number): number => Math.max(0, Math.round(v / GRID) * GRID)

/**
 * Where a box dropped at (x, y) may go: the same place when it is free, else the first free place below it, so a new
 * box never lands exactly on top of another one (positions cannot be negative, so drops above/left of the diagram's
 * origin all clamp to its edge and would otherwise pile up there).
 */
export function freeSlot(x: number, y: number, boxes: Array<{ x: number; y: number }>): { x: number; y: number } {
  let yy = y
  for (let i = 0; i < 200; i++) {
    if (!boxes.some((b) => Math.abs(b.x - x) < W + GRID && Math.abs(b.y - yy) < H + GRID)) break // keep a gap, so arrows and labels stay readable
    yy += H + GRID
  }
  return { x, y: snap(yy) }
}
export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))

/** Does an arrow apply, given the status of the step it starts from? true / false / null (not finished yet). */
export function linkState(link: { from: string; when: string }, statusOf: Record<string, string | undefined>): boolean | null {
  const s = statusOf[link.from]
  if (s === 'skipped') return false
  if (s === 'success') return link.when === 'success' || link.when === 'always'
  if (s && FINAL.includes(s)) return link.when === 'failure' || link.when === 'always'
  return null
}

export function curve(p1: Pt, n1: Pt, p2: Pt, n2: Pt): { d: string; mid: Pt } {
  const d = Math.hypot(p2[0] - p1[0], p2[1] - p1[1])
  const c = clamp(d * 0.45, 24, 120)
  const c1: Pt = [p1[0] + n1[0] * c, p1[1] + n1[1] * c]
  const c2: Pt = [p2[0] + n2[0] * c, p2[1] + n2[1] * c]
  return {
    d: `M${p1.join(',')} C${c1.join(',')} ${c2.join(',')} ${p2.join(',')}`,
    mid: [(p1[0] + 3 * c1[0] + 3 * c2[0] + p2[0]) / 8, (p1[1] + 3 * c1[1] + 3 * c2[1] + p2[1]) / 8],
  }
}

/** Where an arrow from box a to box b runs: rows apart -> bottom to top, same row -> side to side. */
export function geometry(a: Box, b: Box): { d: string; mid: Pt } {
  const ax = a.x + W / 2
  const ay = a.y + H / 2
  const bx = b.x + W / 2
  const by = b.y + H / 2
  let p1: Pt, p2: Pt, n1: Pt, n2: Pt
  if (Math.abs(by - ay) >= H + GRID) {
    if (by >= ay) { p1 = [ax, a.y + H]; n1 = [0, 1]; p2 = [bx, b.y]; n2 = [0, -1] }
    else { p1 = [ax, a.y]; n1 = [0, -1]; p2 = [bx, b.y + H]; n2 = [0, 1] }
  } else if (bx >= ax) { p1 = [a.x + W, ay]; n1 = [1, 0]; p2 = [b.x, by]; n2 = [-1, 0] }
  else { p1 = [a.x, ay]; n1 = [-1, 0]; p2 = [b.x + W, by]; n2 = [1, 0] }
  return curve(p1, n1, p2, n2)
}

/**
 * Rows that follow the arrows: a step sits one row below the lowest step leading to it; in a row, steps are ordered
 * by where the steps leading to them are. Returns {step id: [x, y]} on the grid.
 */
export function tidyPositions(steps: Array<{ id: string; x: number; y: number }>, links: Array<{ from: string; to: string }>): Record<string, Pt> {
  const byId = Object.fromEntries(steps.map((s) => [s.id, s]))
  const ins: Record<string, string[]> = {}
  const outs: Record<string, string[]> = {}
  const indeg: Record<string, number> = {}
  const layer: Record<string, number> = {}
  const order: string[] = []
  for (const s of steps) { ins[s.id] = []; outs[s.id] = [] }
  for (const k of links) if (ins[k.to] && outs[k.from]) { outs[k.from].push(k.to); ins[k.to].push(k.from) }
  for (const s of steps) indeg[s.id] = ins[s.id].length
  const ready = steps.filter((s) => !indeg[s.id]).map((s) => s.id)
  const byPlace = (a: string, b: string) => byId[a].y - byId[b].y || byId[a].x - byId[b].x
  while (ready.length) {
    ready.sort(byPlace)
    const cur = ready.shift()!
    order.push(cur)
    layer[cur] = ins[cur].reduce((m, p) => Math.max(m, layer[p] + 1), 0)
    for (const n of outs[cur]) if (--indeg[n] === 0) ready.push(n)
  }
  // a step with no arrow into it sits just above the first step it leads to (its arrow then never crosses a row of boxes)
  for (const id of [...order].reverse()) {
    if (!ins[id].length && outs[id].length) layer[id] = Math.min(...outs[id].map((n) => layer[n])) - 1
  }
  const rows: string[][] = []
  const col: Record<string, number> = {}
  let widest = 0
  const floor = Math.min(0, ...Object.values(layer))
  for (const id of order) (rows[layer[id] - floor] ??= []).push(id)
  for (const row of rows.filter(Boolean)) {
    const key: Record<string, number> = {}
    for (const id of row) {
      const ps = ins[id]
      key[id] = ps.length ? ps.reduce((t, p) => t + (col[p] ?? 0), 0) / ps.length : byId[id].x / (W + 2 * GRID)
    }
    row.sort((a, b) => key[a] - key[b] || byPlace(a, b))
    row.forEach((id, i) => { col[id] = i })
    widest = Math.max(widest, row.length)
  }
  const out: Record<string, Pt> = {}
  rows.forEach((row, r) => {
    if (!row) return
    const shift = (widest - row.length) / 2
    row.forEach((id, i) => { out[id] = [snap(2 * GRID + (i + shift) * (W + 2 * GRID)), 2 * GRID + r * (H + 3 * GRID)] })
  })
  return out
}

/** A view that shows every box (zoom at most 1), with some padding. */
export function fitView(steps: Box[], width: number, height: number): View {
  if (!steps.length || !width) return { x: 0, y: 0, z: 1 }
  const pad = 40
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const s of steps) { x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y); x1 = Math.max(x1, s.x + W); y1 = Math.max(y1, s.y + H) }
  const z = clamp(Math.min((width - 2 * pad) / (x1 - x0), (height - 2 * pad) / (y1 - y0)), MIN_ZOOM, 1)
  // Content that fits at full size is anchored at the top left: centring a single box would shift the origin so that
  // the next drop above or left of it could not be placed (positions are never negative).
  if (z === 1) return { x: pad - x0, y: pad - y0, z }
  return { x: (width - (x1 - x0) * z) / 2 - x0 * z, y: Math.max(pad, (height - (y1 - y0) * z) / 2) - y0 * z, z }
}

/** Raw values of a step form's fields (what `sequences.saveStep` takes). Passwords and fixed fields are left out. */
export function valuesOfFields(fields: Array<Record<string, any>>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const f of fields) {
    if (f.p?.type === 'password' || f.locked) continue
    out[f.name] = f.input === 'multiselect' ? [...(f.selected ?? [])] : f.input === 'checkbox' ? !!f.value : f.value ?? ''
  }
  return out
}

export const linkKey = (l: { from: string; to: string }): string => `${l.from}\0${l.to}`
export type { GraphLink }
