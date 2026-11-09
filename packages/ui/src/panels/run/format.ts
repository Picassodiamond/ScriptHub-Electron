/** Small formatting helpers for the run console. */

/** 75 → "1m 15s" (the same shape as the engine's formatDuration, for the live ticking duration). */
export function fmtDuration(seconds: number): string {
  const sec = Math.max(0, Math.floor(seconds))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  if (h) return `${h}h ${pad(m)}m ${pad(s)}s`
  if (m) return `${m}m ${pad(s)}s`
  return `${s}s`
}

/** "2026-11-09T21:10:00" → "2026-11-09 21:10:00" */
export const shortTime = (iso: string | null | undefined): string => (iso ? iso.replace('T', ' ') : '—')

/** Wall-clock time of a line arrival (HH:MM:SS), '' when unknown. */
export function clock(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** The statuses in which the debugger can still be driven. */
export const isFinalStatus = (status: string | undefined): boolean =>
  ['success', 'failed', 'timed_out', 'cancelled', 'interrupted'].includes(status ?? '')

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;opacity:0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

/** Save text through the browser's download (Electron shows its Save dialog for it). */
export function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
