/** A transport for tests and for running the UI in a plain browser: handlers are plain functions, events are pushed by hand. */
import { ApiError, type CallName, type EventName, type Events, type Transport } from '@scripthub/protocol'

type Handler = (args: any) => unknown | Promise<unknown>

export class MockTransport implements Transport {
  /** Every request made, in order. */
  readonly calls: Array<{ name: string; args: any }> = []
  private listeners = new Map<string, Set<(p: any) => void>>()

  constructor(public handlers: Partial<Record<CallName, Handler>> = {}) {}

  on(name: CallName, handler: Handler): this {
    this.handlers[name] = handler
    return this
  }

  async request(name: string, args: unknown): Promise<unknown> {
    this.calls.push({ name, args })
    const h = (this.handlers as Record<string, Handler | undefined>)[name]
    if (!h) throw new ApiError('unavailable', `No mock for ${name}`)
    return h(args)
  }

  subscribe<E extends EventName>(event: E, cb: (payload: Events[E]) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) this.listeners.set(event, (set = new Set()))
    set.add(cb)
    return () => set!.delete(cb)
  }

  emit<E extends EventName>(event: E, payload: Events[E]): void {
    for (const cb of [...(this.listeners.get(event) ?? [])]) cb(payload)
  }

  count(name: string): number {
    return this.calls.filter((c) => c.name === name).length
  }
}
