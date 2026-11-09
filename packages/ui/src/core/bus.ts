/**
 * A tiny in-page event bus for commands that concern the page in the active tab, e.g. `run.run` (Ctrl+Enter) or
 * `save` (Ctrl+S). The shell emits them; a panel handles them with `useCommand('run.run', handler)` (only while active).
 */
type Handler = (payload: any) => void

const handlers = new Map<string, Set<Handler>>()

export function onCommand(name: string, h: Handler): () => void {
  let set = handlers.get(name)
  if (!set) handlers.set(name, (set = new Set()))
  set.add(h)
  return () => set!.delete(h)
}

/** Returns true when someone handled it. */
export function emitCommand(name: string, payload?: unknown): boolean {
  const set = handlers.get(name)
  if (!set || !set.size) return false
  for (const h of [...set]) h(payload)
  return true
}
