/**
 * The only bridge between the page and the main process: window.scripthub = { request, subscribe }.
 * The page has no Node, no ipcRenderer and no file access. Dropped files are turned into paths here
 * (the page cannot read them) and sent to the main process, which turns them into an `app.drop` event.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'

type Listener = (payload: unknown) => void

const listeners = new Map<string, Set<Listener>>()
ipcRenderer.on('sh:event', (_e, msg: { event: string; payload: unknown }) => {
  for (const cb of listeners.get(msg.event) ?? []) {
    try {
      cb(msg.payload)
    } catch {
      /* a failing subscriber must not break the others */
    }
  }
})

contextBridge.exposeInMainWorld('scripthub', {
  request: (name: string, args: unknown) => ipcRenderer.invoke('sh:request', name, args ?? {}),
  subscribe: (event: string, cb: Listener) => {
    let set = listeners.get(event)
    if (!set) listeners.set(event, (set = new Set()))
    set.add(cb)
    return () => {
      set!.delete(cb)
    }
  },
})

// Drag a folder or script onto the window to open it.
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => {
  e.preventDefault()
  const files = Array.from(e.dataTransfer?.files ?? [])
  const paths = files.map((f) => webUtils.getPathForFile(f)).filter(Boolean)
  if (paths.length) ipcRenderer.send('sh:drop', paths)
})
