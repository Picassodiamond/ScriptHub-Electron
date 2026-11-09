/** The browser demo (npm run dev:ui) answers every protocol call, from the engine's real answers for the samples. */
import { describe, expect, it } from 'vitest'
import { ApiError, callNames } from '@scripthub/protocol'
import { richDemoTransport } from '../../client/src/demoRich.js'

describe('rich demo transport', () => {
  it('answers every protocol call (no "No mock" gaps)', async () => {
    const t = richDemoTransport()
    const missing: string[] = []
    for (const name of callNames) {
      try {
        await t.request(name, {})
      } catch (e) {
        if (e instanceof ApiError && e.code === 'unavailable') missing.push(name)
      }
    }
    expect(missing).toEqual([])
  })

  it('shows a populated workbench: scripts, a finished run, a sequence and its run', async () => {
    const t = richDemoTransport()
    const shell: any = await t.request('app.shell', {})
    expect(shell.tree.flatMap((g: any) => g.scripts).length).toBeGreaterThan(10)
    expect(shell.sequenceList.map((s: any) => s.name)).toContain('Nightly checks')
    const hist: any = await t.request('runs.query', {})
    expect(hist.total).toBeGreaterThan(0)
    const id = shell.tree[0].scripts.find((s: any) => s.relative.replaceAll('\\', '/') === 'basics/hello.py')?.id
    const form: any = await t.request('runs.form', { scriptId: id })
    expect(form.script?.name ?? form.name).toBeTruthy()
    const seq: any = await t.request('sequences.graph', { slug: 'nightly-checks' })
    expect(seq.steps.length).toBe(3)
    expect(seq.links.length).toBe(2)
  })

  it('keeps sequence edits in memory: create, rename, star, delete', async () => {
    const t = richDemoTransport()
    const created: any = await t.request('sequences.create', { name: 'Weekly' })
    expect(created.ok).toBe(true)
    expect(((await t.request('sequences.create', { name: 'weekly' })) as any).ok).toBe(false)
    await t.request('sequences.rename', { slug: created.slug, name: 'Weekly run' })
    await t.request('sequences.favorite', { slug: created.slug, on: true })
    const list: any = await t.request('sequences.list', {})
    expect(list.sequences.find((s: any) => s.slug === created.slug)).toMatchObject({ name: 'Weekly run', favorite: true })
    expect(((await t.request('app.shell', {})) as any).sequenceList.length).toBe(list.sequences.length)
    expect((await t.request('sequences.delete', { slug: created.slug })) as any).toEqual({ deleted: true })
    expect(((await t.request('sequences.graph', { slug: 'unknown-new' })) as any).steps).toEqual([])
  })

  it('saves settings in memory', async () => {
    const t = richDemoTransport()
    const s: any = await t.request('settings.get', {})
    const r: any = await t.request('settings.save', { form: { ...s.form, max_concurrent_executions: 7 } })
    expect(r.ok).toBe(true)
    expect(((await t.request('settings.get', {})) as any).form.max_concurrent_executions).toBe(7)
  })
})
