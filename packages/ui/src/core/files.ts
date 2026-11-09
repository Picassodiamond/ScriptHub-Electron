/**
 * Saving a text file for the user. In the desktop app the main process shows the native Save dialog and writes the
 * file (`host.saveFile`); in a browser (and when the host cannot do it) the browser's own download is used.
 */
import { hostCall } from './api'
import { hostInfo } from './shellState'
import { toast } from './toast'

export interface SaveResult {
  /** The file was written, or the download started. */
  ok: boolean
  /** The user closed the Save dialog. */
  cancelled?: boolean
  /** Where the desktop app wrote it. */
  path?: string
}

function browserDownload(name: string, text: string, type: string): boolean {
  try {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false
    const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return true
  } catch {
    return false
  }
}

const HOST_MISSING = new Set(['unavailable', 'unknown_call'])

/** Offer `text` as a file named `name`. Never throws. */
export async function saveFile(name: string, text: string, type = 'text/plain'): Promise<SaveResult> {
  if (hostInfo.value?.desktop) {
    try {
      const r = await hostCall<{ path: string } | null>('host.saveFile', { suggestedName: name, text })
      if (!r) return { ok: true, cancelled: true }
      toast.success(`Saved ${r.path}`)
      return { ok: true, path: r.path }
    } catch (e: any) {
      if (!HOST_MISSING.has(e?.code)) {
        toast.error(e?.message ?? String(e))
        return { ok: false }
      }
      // an older host without saveFile: fall through to the browser
    }
  }
  return { ok: browserDownload(name, text, type) }
}
