import { describe, expect, it } from 'vitest'
import { ApiError, bridgeTransport, createApi, demoTransport, MockTransport } from '../src/index.js'

describe('client', () => {
  it('calls handlers through the typed api and records the requests', async () => {
    const t = new MockTransport().on('app.info', () => ({ version: '1' }))
    const api = createApi(t)
    expect((await api['app.info']({})).version).toBe('1')
    expect(t.calls).toEqual([{ name: 'app.info', args: {} }])
  })

  it('delivers events to subscribers until they unsubscribe', () => {
    const t = new MockTransport()
    const seen: string[] = []
    const off = createApi(t).on('app.toast', (p) => seen.push(p.text))
    t.emit('app.toast', { kind: 'info', text: 'a' })
    off()
    t.emit('app.toast', { kind: 'info', text: 'b' })
    expect(seen).toEqual(['a'])
  })

  it('unwraps the preload envelope into a value or an ApiError', async () => {
    const bridge = {
      request: async (name: string) => (name === 'ok' ? { ok: true as const, value: 7 } : { ok: false as const, error: { code: 'invalid', message: 'bad', details: { x: 1 } } }),
      subscribe: () => () => {},
    }
    const t = bridgeTransport(bridge)
    expect(await t.request('ok', {})).toBe(7)
    await expect(t.request('nope', {})).rejects.toMatchObject({ code: 'invalid', message: 'bad', details: { x: 1 } })
    await expect(t.request('nope', {})).rejects.toBeInstanceOf(ApiError)
  })

  it('reports an unmocked call as unavailable and ships demo data', async () => {
    const t = demoTransport()
    await expect(t.request('settings.get', {})).rejects.toMatchObject({ code: 'unavailable' })
    expect((await createApi(t)['app.shell']({})).tree.length).toBe(2)
  })
})
