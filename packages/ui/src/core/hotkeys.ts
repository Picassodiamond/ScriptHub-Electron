/**
 * Keyboard shortcuts, from the `keys` of the commands: single keys (r, ?), combinations (ctrl+k, ctrl+alt+b) and
 * two-key chords (g l). Plain keys are ignored while typing; combinations with Ctrl always work.
 */
import { allCommands, runCommand } from './commands'
import { confirmState } from './confirm'
import { helpOpen, paletteOpen } from './overlays'

const CHORD_MS = 1000

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || !el.tagName) return false
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || !!el.closest?.('.monaco-editor')
}

/** 'ctrl+alt+b', 'ctrl+enter', 'f10', '?', 'g' */
export function specOf(e: KeyboardEvent): string {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase().replace('arrow', '')
  if (['control', 'shift', 'alt', 'meta'].includes(key)) return ''
  const mods = [(e.ctrlKey || e.metaKey) && 'ctrl', e.altKey && 'alt'].filter(Boolean)
  return [...mods, key].join('+')
}

export function startHotkeys(): () => void {
  let pending = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  const clear = () => {
    pending = ''
    if (timer) clearTimeout(timer)
    timer = null
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return
    const spec = specOf(e)
    if (!spec) return
    const modal = paletteOpen.value || helpOpen.value || !!confirmState.value
    if (modal && spec !== 'ctrl+k' && spec !== '?') return
    const typing = isTyping(e.target)
    const combo = spec.startsWith('ctrl+') || spec === 'f10'
    if (typing && !combo) return clear()

    const bindings = new Map<string, string>()
    for (const c of allCommands()) for (const k of c.keys ?? []) bindings.set(k, c.id)

    if (pending) {
      const id = bindings.get(`${pending} ${spec}`)
      clear()
      if (id) {
        e.preventDefault()
        void runCommand(id)
      }
      return
    }
    const direct = bindings.get(spec)
    if (direct && !(e.altKey && !spec.includes('alt'))) {
      e.preventDefault()
      void runCommand(direct)
      return
    }
    if (!combo && [...bindings.keys()].some((k) => k.startsWith(`${spec} `))) {
      pending = spec
      timer = setTimeout(clear, CHORD_MS)
      e.preventDefault()
    }
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}
