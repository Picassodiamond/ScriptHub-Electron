/**
 * The Electron transport: talks to the preload bridge `window.scripthub` (see apps/electron/src/preload.ts).
 * The bridge resolves an envelope ({ok:true,value} | {ok:false,error}) because custom Error properties do not
 * survive contextBridge; this module turns it back into a value or an ApiError.
 */
import { ApiError, makeClient, type Client, type EventName, type Events, type Transport } from '@scripthub/protocol'

export type Envelope = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details?: unknown } }

/** What the preload exposes. Nothing else is reachable from the page. */
export interface ScriptHubBridge {
  request(name: string, args: unknown): Promise<Envelope>
  subscribe(event: string, cb: (payload: any) => void): () => void
}

declare global {
  interface Window {
    scripthub?: ScriptHubBridge
  }
}

export function hasBridge(): boolean {
  return typeof window !== 'undefined' && !!window.scripthub
}

export function bridgeTransport(bridge: ScriptHubBridge): Transport {
  return {
    async request(name, args) {
      const r = await bridge.request(name, args ?? {})
      if (r.ok) return r.value
      throw new ApiError(r.error.code, r.error.message, r.error.details)
    },
    subscribe<E extends EventName>(event: E, cb: (p: Events[E]) => void) {
      return bridge.subscribe(event, cb)
    },
  }
}

export const windowTransport = (): Transport => {
  if (!window.scripthub) throw new Error('The ScriptHub bridge is not available in this page.')
  return bridgeTransport(window.scripthub)
}

export const createApi = (transport: Transport): Client => makeClient(transport)
