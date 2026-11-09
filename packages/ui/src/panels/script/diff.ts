/** A small line diff (longest common subsequence) for the side-by-side view of Versions…. */
export type DiffKind = 'same' | 'del' | 'add' | 'change'

export interface DiffRow {
  kind: DiffKind
  /** 1-based line numbers (null where the side has no line). */
  left: number | null
  right: number | null
  leftText: string
  rightText: string
}

const MAX_CELLS = 4_000_000

const splitLines = (t: string): string[] => {
  const lines = t.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Rows aligning `a` (old, left) with `b` (new, right); a deleted line next to an added one becomes one `change` row. */
export function diffLines(a: string, b: string): DiffRow[] {
  const x = splitLines(a)
  const y = splitLines(b)
  const ops: Array<['same' | 'del' | 'add', number, number]> = []
  if (x.length * y.length > MAX_CELLS) {
    // too big for the table: compare by position
    const n = Math.max(x.length, y.length)
    for (let i = 0; i < n; i++) {
      if (i < x.length && i < y.length && x[i] === y[i]) ops.push(['same', i, i])
      else {
        if (i < x.length) ops.push(['del', i, -1])
        if (i < y.length) ops.push(['add', -1, i])
      }
    }
  } else {
    // lcs[i][j] = length of the common subsequence of x[i..] and y[j..]
    const w = y.length + 1
    const lcs = new Uint32Array((x.length + 1) * w)
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--)
        lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
    let i = 0
    let j = 0
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) ops.push(['same', i++, j++])
      else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) ops.push(['del', i++, -1])
      else ops.push(['add', -1, j++])
    }
    while (i < x.length) ops.push(['del', i++, -1])
    while (j < y.length) ops.push(['add', -1, j++])
  }

  const rows: DiffRow[] = []
  for (let k = 0; k < ops.length; k++) {
    const [kind, i, j] = ops[k]
    if (kind === 'same') rows.push({ kind: 'same', left: i + 1, right: j + 1, leftText: x[i], rightText: y[j] })
    else if (kind === 'del') {
      // a run of deletions followed by additions: pair them up as changes
      let dels = 0
      while (k + dels < ops.length && ops[k + dels][0] === 'del') dels++
      let adds = 0
      while (k + dels + adds < ops.length && ops[k + dels + adds][0] === 'add') adds++
      const pairs = Math.min(dels, adds)
      for (let p = 0; p < pairs; p++) {
        const li = ops[k + p][1]
        const ri = ops[k + dels + p][2]
        rows.push({ kind: 'change', left: li + 1, right: ri + 1, leftText: x[li], rightText: y[ri] })
      }
      for (let p = pairs; p < dels; p++) rows.push({ kind: 'del', left: ops[k + p][1] + 1, right: null, leftText: x[ops[k + p][1]], rightText: '' })
      for (let p = pairs; p < adds; p++) rows.push({ kind: 'add', left: null, right: ops[k + dels + p][2] + 1, leftText: '', rightText: y[ops[k + dels + p][2]] })
      k += dels + adds - 1
    } else rows.push({ kind: 'add', left: null, right: j + 1, leftText: '', rightText: y[j] })
  }
  return rows
}

/** How many lines differ. */
export const changeCount = (rows: DiffRow[]): number => rows.filter((r) => r.kind !== 'same').length
