/** Small helpers for the History panel: ticking relative times, durations, CSV and file downloads. */

const pad = (n: number) => String(n).padStart(2, '0')

/** Same format as the engine's formatDuration (`5s`, `2m 05s`, `1h 02m 03s`). */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—'
  const s0 = Math.trunc(seconds)
  const h = Math.floor(s0 / 3600)
  const m = Math.floor((s0 % 3600) / 60)
  const s = s0 % 60
  if (h) return `${h}h ${pad(m)}m ${pad(s)}s`
  if (m) return `${m}m ${pad(s)}s`
  return `${s}s`
}

/** Epoch ms of an engine timestamp (`2026-11-09T21:10:00`, local time), or null. */
export function parseWhen(iso: unknown): number | null {
  if (typeof iso !== 'string' || !iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/** "just now", "5 min ago", "3 h ago", "2 d ago"; older than a month: the date. */
export function relTime(iso: unknown, now: number): string {
  const t = parseWhen(iso)
  if (t === null) return ''
  const secs = Math.max(0, Math.floor((now - t) / 1000))
  if (secs < 60) return 'just now'
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`
  if (secs < 86400 * 30) return `${Math.floor(secs / 86400)} d ago`
  return String(iso).slice(0, 10)
}

/** The run's duration, ticking while it is active (from its start time), else the engine's text. */
export function liveDuration(r: Record<string, any>, now: number): string {
  if (r.active || r.status === 'running') {
    const t = parseWhen(r.started_at)
    if (t !== null && r.status === 'running') return formatDuration((now - t) / 1000)
  }
  return r.duration ?? '—'
}

export const isSeqRow = (r: Record<string, any>): boolean => r.kind === 'sequence' || String(r.id ?? '').startsWith('SEQ-')

// ---------------------------------------------------------------- CSV ---
const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

export const CSV_HEADER = ['id', 'kind', 'name', 'host', 'status', 'exit_code', 'started', 'duration', 'initiator', 'sequence_run', 'step'] as const

/** The filtered history as CSV text (one line per run, sequence runs included). */
export function historyCsv(rows: Array<Record<string, any>>): string {
  const lines: string[] = [CSV_HEADER.join(',')]
  for (const r of rows) {
    const seq = isSeqRow(r)
    lines.push([
      r.id, seq ? 'sequence' : 'script', seq ? r.name : r.script_name, seq ? `${r.done ?? 0}/${(r.steps ?? []).length} steps` : r.host,
      r.status, seq ? '' : r.exit_code, r.started_display ?? '', r.duration ?? '', r.initiator ?? '', r.seq?.run ?? '', r.seq?.step ?? '',
    ].map(csvCell).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

/** Save `text` through the browser (Electron shows its Save dialog). Returns false when downloads are unavailable. */
export function downloadText(name: string, text: string, type = 'text/plain'): boolean {
  try {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false
    const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return true
  } catch {
    return false
  }
}
