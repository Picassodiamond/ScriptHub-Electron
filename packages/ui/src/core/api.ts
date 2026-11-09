/**
 * The one way the UI talks to the engine: `api['runs.start']({...})`, `onEvent('run.output', cb)`.
 * In Electron the transport is the preload bridge; in a plain browser (npm run dev:ui) and in tests it is a mock.
 */
import {
  createApi, demoTransport, hasBridge, richDemoTransport, windowTransport, type Client, type EventName, type Events, type Transport,
} from '@scripthub/client'

let transport: Transport | null = null
let client: Client | null = null

export function setTransport(t: Transport): void {
  transport = t
  client = createApi(t)
}

export function getTransport(): Transport {
  // no desktop bridge: `npm run dev:ui` shows every page with the engine's real answers for the samples; tests get the small demo
  if (!transport) setTransport(hasBridge() ? windowTransport() : import.meta.env.DEV && import.meta.env.MODE !== 'test' ? richDemoTransport() : demoTransport())
  return transport!
}

/** The typed client. A Proxy, so it can be imported once and always uses the current transport. */
export const api: Client = new Proxy({} as Client, {
  get(_t, prop: string) {
    getTransport()
    return (client as any)[prop]
  },
})

export function onEvent<E extends EventName>(event: E, cb: (payload: Events[E]) => void): () => void {
  return getTransport().subscribe(event, cb)
}

/** Calls only the desktop host can answer (native dialogs). Rejects with ApiError('unavailable') in a browser. */
export function hostCall<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  return getTransport().request(name, args) as Promise<T>
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
