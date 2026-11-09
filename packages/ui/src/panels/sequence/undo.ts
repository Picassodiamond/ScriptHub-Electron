/**
 * Undo / redo for the sequence editor (the Django page had none). Every edit is stored as a pair of symbolic operations;
 * undo runs the first, redo the second, both through the same engine calls (`sequences.graphOp`, `sequences.saveStep`).
 * A removed step is brought back as a new step (the engine never reuses ids), so ids in the other entries are remapped.
 */
import type { Pt, When } from './geometry'

export interface StepSnap {
  /** the id the step had; entries that mention it are remapped to the new id when it is created again */
  id: string
  script: string
  x: number
  y: number
  host: string
  join: string
  /** 'values' or a preset slug */
  source: string
  /** the values saved with the step, or null to keep what the engine chose when adding it */
  values: Record<string, any> | null
  links: Array<{ from: string; to: string; when: When }>
}

export type Op =
  | { t: 'move'; positions: Record<string, Pt> }
  | { t: 'link'; from: string; to: string; when: When }
  | { t: 'unlink'; from: string; to: string }
  | { t: 'remove'; id: string }
  | { t: 'create'; snap: StepSnap }

export interface Entry { label: string; undo: Op[]; redo: Op[] }

const LIMIT = 100

function remapOp(op: Op, from: string, to: string): Op {
  const m = (s: string) => (s === from ? to : s)
  switch (op.t) {
    case 'move': return { t: 'move', positions: Object.fromEntries(Object.entries(op.positions).map(([k, v]) => [m(k), v])) }
    case 'link': return { ...op, from: m(op.from), to: m(op.to) }
    case 'unlink': return { ...op, from: m(op.from), to: m(op.to) }
    case 'remove': return { t: 'remove', id: m(op.id) }
    case 'create': return { t: 'create', snap: { ...op.snap, id: m(op.snap.id), links: op.snap.links.map((l) => ({ ...l, from: m(l.from), to: m(l.to) })) } }
  }
}

export class UndoStack {
  private entries: Entry[] = []
  /** entries[0..cursor) can be undone, entries[cursor..) redone */
  private cursor = 0

  get canUndo(): boolean { return this.cursor > 0 }
  get canRedo(): boolean { return this.cursor < this.entries.length }
  get undoLabel(): string { return this.canUndo ? this.entries[this.cursor - 1].label : '' }
  get redoLabel(): string { return this.canRedo ? this.entries[this.cursor].label : '' }

  push(entry: Entry): void {
    this.entries.length = this.cursor // a new edit drops what could have been redone
    this.entries.push(entry)
    if (this.entries.length > LIMIT) this.entries.shift()
    this.cursor = this.entries.length
  }

  /** The entry to undo (the cursor moves only after `done()`), or null. */
  peekUndo(): Entry | null { return this.canUndo ? this.entries[this.cursor - 1] : null }
  peekRedo(): Entry | null { return this.canRedo ? this.entries[this.cursor] : null }
  doneUndo(): void { if (this.canUndo) this.cursor-- }
  doneRedo(): void { if (this.canRedo) this.cursor++ }

  /** A step that had id `from` now has id `to`: fix every stored operation. */
  remap(from: string, to: string): void {
    if (from === to) return
    this.entries = this.entries.map((e) => ({ ...e, undo: e.undo.map((o) => remapOp(o, from, to)), redo: e.redo.map((o) => remapOp(o, from, to)) }))
  }

  clear(): void {
    this.entries = []
    this.cursor = 0
  }
}
