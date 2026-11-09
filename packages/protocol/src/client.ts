import type { Api, CallName } from './calls.js'
import type { EventName, Events } from './events.js'

/** An expected failure: a code (e.g. 'not_found', 'invalid', 'forbidden', 'unavailable') and a message for the user. */
export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message)
    this.name = 'ApiError'
  }
  toJSON() {
    return { code: this.code, message: this.message, details: this.details }
  }
}

/** The shape of an error as it crosses a transport. */
export interface WireError { code: string; message: string; details?: unknown }

/** What a host provides: Electron IPC today, a VS Code webview message channel later. */
export interface Transport {
  request(name: string, args: unknown): Promise<unknown>
  subscribe<E extends EventName>(event: E, cb: (payload: Events[E]) => void): () => void
}

export type Client = {
  [K in CallName]: (args: Api[K]['args']) => Promise<Api[K]['result']>
} & { on<E extends EventName>(event: E, cb: (payload: Events[E]) => void): () => void }

/** A typed client: `client['runs.start']({...})`, `client.on('run.output', ...)`. */
export function makeClient(transport: Transport): Client {
  return new Proxy({} as Client, {
    get(_t, prop: string) {
      if (prop === 'on') return (e: EventName, cb: (p: any) => void) => transport.subscribe(e, cb)
      return (args: unknown) => transport.request(prop, args ?? {})
    },
  })
}
