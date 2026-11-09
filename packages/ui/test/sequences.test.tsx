import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/preact'
import type { MockTransport } from '@scripthub/client'
import { describe, expect, it } from 'vitest'
import '../src/panels'
import { confirmState } from '../src/core/confirm'
import { getPanel, type PanelKind } from '../src/core/panels'
import { emitCommand } from '../src/core/bus'
import { activeTab, tabs, type Tab } from '../src/core/tabs'
import { toasts } from '../src/core/toast'
import { groupPasswords } from '../src/panels/sequence'
import { linkState, snap, tidyPositions, valuesOfFields } from '../src/panels/sequence/geometry'
import { UndoStack } from '../src/panels/sequence/undo'
import { transport } from './setup'

// ------------------------------------------------------------------ a tiny fake engine for the sequence calls
type Link = { from: string; to: string; when: 'success' | 'failure' | 'always' }
interface Step { id: string; n: number; script: string; name: string; ext: string; path: string; host: string; source: string; problem: string; x: number; y: number; join: string; incoming: number }

function fakeGraph(steps: Array<Partial<Step> & { id: string }>, links: Link[] = [], passwords: any[] = []) {
  const st = {
    steps: steps.map((s, i) => ({ n: i + 1, script: `aaaaaaaaaa${String(i).padStart(2, '0')}`, name: `Script ${i + 1}`, ext: 'py', path: `C:\\s\\${i}.py`, host: 'local', source: 'values', problem: '', x: 40, y: 40 + i * 120, join: 'all', incoming: 0, ...s })) as Step[],
    links: links.map((l) => ({ ...l })),
    passwords,
  }
  let next = steps.length + 1
  const view = () => ({
    steps: st.steps.map((s, i) => ({ ...s, n: i + 1, incoming: st.links.filter((k) => k.to === s.id).length })),
    links: st.links.map((l) => ({ ...l })),
    passwords: st.passwords,
  })
  const reaches = (a: string, b: string): boolean => a === b || st.links.some((k) => k.from === a && reaches(k.to, b))
  const op = ({ op: o }: any) => {
    const fail = (error: string) => ({ ok: false, error, graph: view() })
    if (o.op === 'add') {
      const id = `s${next++}`
      st.steps.push({ id, n: 0, script: o.script, name: `Added ${o.script}`, ext: 'py', path: '', host: 'local', source: 'values', problem: '', x: o.x ?? 0, y: o.y ?? 0, join: 'all', incoming: 0 })
      return { ok: true, id, graph: view() }
    }
    if (o.op === 'move') {
      for (const [id, [x, y]] of Object.entries(o.positions) as any) { const s = st.steps.find((t) => t.id === id); if (!s) return fail('That step does not exist.'); s.x = x; s.y = y }
      return { ok: true, graph: view() }
    }
    if (o.op === 'remove') {
      st.steps = st.steps.filter((s) => s.id !== o.id)
      st.links = st.links.filter((k) => k.from !== o.id && k.to !== o.id)
      return { ok: true, graph: view() }
    }
    if (o.op === 'link') {
      if (o.from === o.to) return fail('A step cannot lead to itself.')
      const ex = st.links.find((k) => k.from === o.from && k.to === o.to)
      if (ex) ex.when = o.when ?? 'success'
      else {
        if (reaches(o.to, o.from)) return fail('That arrow would make a loop: the steps would never finish.')
        st.links.push({ from: o.from, to: o.to, when: o.when ?? 'success' })
      }
      return { ok: true, graph: view() }
    }
    const before = st.links.length
    st.links = st.links.filter((k) => !(k.from === o.from && k.to === o.to))
    return before === st.links.length ? fail('That arrow does not exist.') : { ok: true, graph: view() }
  }
  return { st, view, op }
}

function install(t: MockTransport, g = fakeGraph([{ id: 's1', name: 'Backup' }, { id: 's2', name: 'Cleanup' }], [{ from: 's1', to: 's2', when: 'success' }]), extra: Record<string, any> = {}) {
  t.on('sequences.get', ({ slug }: any) => ({ seq: { slug, name: 'Nightly' }, graph: g.view(), runs: [], activeRun: extra.activeRun ?? null, token: 'tok1', maxSteps: 3 }))
  t.on('sequences.graph', () => g.view())
  t.on('sequences.graphOp', (a: any) => g.op(a))
  t.on('sequences.runs', () => [])
  t.on('sequences.watchRun', () => ({ ok: true }))
  t.on('sequences.unwatchRun', () => ({ ok: true }))
  t.on('runs.watch', () => ({ ok: true }))
  t.on('runs.unwatch', () => ({ ok: true }))
  for (const [k, v] of Object.entries(extra.handlers ?? {})) t.on(k as any, v as any)
  return g
}

const tabOf = (kind: PanelKind, id: string, title = id): Tab => ({ key: `${kind}:${id}`, kind, id, title, icon: 'sequence', params: {} })
function mount(kind: PanelKind, id = 'nightly') {
  const Panel = getPanel(kind)!.component
  return render(<Panel tab={tabOf(kind, id)} active />)
}
const callsOf = (name: string) => transport.calls.filter((c) => c.name === name)
const nodeEl = (id: string) => document.querySelector(`.seq-node[data-id="${id}"]`) as HTMLElement
const canvas = () => document.querySelector('.seq-canvas') as HTMLElement
async function acceptConfirm(ok = true) {
  await waitFor(() => expect(confirmState.value).toBeTruthy())
  act(() => confirmState.value!.resolve(ok))
}
const toastTexts = () => toasts.value.map((x) => x.text)

/** jsdom has no DragEvent, so the coordinates are put on the event by hand. */
function dropAt(x: number, y: number, script: string) {
  const ev = createEvent.drop(canvas(), { dataTransfer: { types: ['application/x-scripthub-script'], getData: () => script, dropEffect: '' } })
  Object.defineProperty(ev, 'clientX', { value: x })
  Object.defineProperty(ev, 'clientY', { value: y })
  fireEvent(canvas(), ev)
}

function dragNode(id: string, dx: number, dy: number) {
  const n = nodeEl(id)
  fireEvent.pointerDown(n, { button: 0, clientX: 100, clientY: 100, pointerId: 1 })
  fireEvent.pointerMove(canvas(), { clientX: 100 + dx, clientY: 100 + dy, pointerId: 1 })
  fireEvent.pointerUp(canvas(), { clientX: 100 + dx, clientY: 100 + dy, pointerId: 1 })
}
function drawLink(from: string, to: string) {
  ;(document as any).elementFromPoint = () => nodeEl(to)
  fireEvent.pointerDown(nodeEl(from).querySelector('.seq-port')!, { button: 0, clientX: 10, clientY: 10, pointerId: 1 })
  fireEvent.pointerMove(canvas(), { clientX: 50, clientY: 50, pointerId: 1 })
  fireEvent.pointerUp(canvas(), { clientX: 50, clientY: 50, pointerId: 1 })
  delete (document as any).elementFromPoint
}

// ------------------------------------------------------------------------------------------- pure helpers
describe('diagram helpers', () => {
  it('snaps to the 20px grid and never below zero', () => {
    expect([snap(31), snap(29), snap(-50), snap(10)]).toEqual([40, 20, 0, 20])
  })

  it('decides whether an arrow applies from the status of its source step', () => {
    const l = (when: string) => ({ from: 'a', when })
    expect(linkState(l('success'), { a: 'success' })).toBe(true)
    expect(linkState(l('failure'), { a: 'success' })).toBe(false)
    expect(linkState(l('failure'), { a: 'failed' })).toBe(true)
    expect(linkState(l('always'), { a: 'cancelled' })).toBe(true)
    expect(linkState(l('success'), { a: 'skipped' })).toBe(false) // an arrow from a skipped step never applies
    expect(linkState(l('success'), { a: 'running' })).toBeNull()
    expect(linkState(l('success'), {})).toBeNull()
  })

  it('lays steps out in rows that follow the arrows, one row below the lowest step leading to it', () => {
    const steps = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, x: i * 20, y: 500 - i * 20 }))
    const pos = tidyPositions(steps, [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }])
    expect(pos.a[1]).toBeLessThan(pos.b[1])
    expect(pos.b[1]).toBe(pos.c[1])
    expect(pos.d[1]).toBeGreaterThan(pos.b[1])
    expect(pos.b[0]).not.toBe(pos.c[0])
    for (const [x, y] of Object.values(pos)) { expect(x % 20).toBe(0); expect(y % 20).toBe(0) }
  })

  it('collects a step form\'s values without passwords or fixed fields', () => {
    expect(valuesOfFields([
      { name: 'days', input: 'number', value: 30, p: { type: 'number' } },
      { name: 'secret', input: 'password', value: 'x', p: { type: 'password' } },
      { name: 'fixed', input: 'text', value: 'f', locked: true, p: { type: 'text' } },
      { name: 'tags', input: 'multiselect', selected: ['a', 'b'], p: { type: 'multiselect' } },
      { name: 'on', input: 'checkbox', value: true, p: { type: 'boolean' } },
    ])).toEqual({ days: 30, tags: ['a', 'b'], on: true })
  })

  it('groups typed passwords by step', () => {
    expect(groupPasswords({ pw_s1_token: 'a', pw_s1_db_pass: 'b', pw_s12_x: 'c' })).toEqual({ s1: { token: 'a', db_pass: 'b' }, s12: { x: 'c' } })
  })

  it('undo stack: a new edit drops the redo tail, ids are remapped when a step comes back', () => {
    const u = new UndoStack()
    u.push({ label: 'a', undo: [{ t: 'remove', id: 's1' }], redo: [{ t: 'unlink', from: 's1', to: 's2' }] })
    u.push({ label: 'b', undo: [{ t: 'move', positions: { s1: [0, 0] } }], redo: [] })
    expect([u.canUndo, u.canRedo, u.undoLabel]).toEqual([true, false, 'b'])
    u.doneUndo()
    expect([u.canRedo, u.redoLabel]).toEqual([true, 'b'])
    u.push({ label: 'c', undo: [], redo: [] }) // drops "b"
    expect(u.canRedo).toBe(false)
    u.remap('s1', 's9')
    u.doneUndo(); u.doneUndo()
    expect(u.peekRedo()?.undo).toEqual([{ t: 'remove', id: 's9' }])
    expect(u.peekRedo()?.redo).toEqual([{ t: 'unlink', from: 's9', to: 's2' }])
  })
})

// ------------------------------------------------------------------------------------------- the list page
describe('Sequences page', () => {
  const list = [
    { slug: 'nightly', name: 'Nightly', steps: 3, saved_at: '', saved_display: '2026-11-09 21:10', error: '', favorite: true },
    { slug: 'weekly', name: 'Weekly', steps: 1, saved_at: '', saved_display: '', error: '', favorite: false },
    { slug: 'broken', name: 'broken', steps: 0, saved_at: '', saved_display: '', error: 'broken.yaml could not be read (bad); fix or delete it first.', favorite: false },
  ]
  const runs = [{ id: 'SEQ-20261109-001', name: 'Nightly', status: 'success', status_label: 'Succeeded', paused: false, done: 3, steps: [{}, {}, {}], started_display: '2026-11-09 21:10', duration: '4s', active: false }]
  function setup() {
    let data = list.map((s) => ({ ...s }))
    transport.on('sequences.list', () => ({ sequences: data.map((s) => ({ ...s })), runs }))
    transport.on('sequences.create', ({ name }: any) => { data.push({ slug: name.toLowerCase(), name, steps: 0, saved_at: '', saved_display: '', error: '', favorite: false }); return { ok: true, slug: name.toLowerCase() } })
    transport.on('sequences.rename', ({ slug, name }: any) => { data.find((s) => s.slug === slug)!.name = name; return { ok: true } })
    transport.on('sequences.favorite', ({ slug, on }: any) => { data.find((s) => s.slug === slug)!.favorite = on; return { ok: true } })
    transport.on('sequences.delete', ({ slug }: any) => { data = data.filter((s) => s.slug !== slug); return { deleted: true } })
    transport.on('app.shell', () => { throw new Error('no shell in this test') })
  }

  it('lists sequences with favourites first, shows broken files with their error, and recent runs', async () => {
    setup()
    mount('sequences')
    await screen.findByText('Weekly')
    const rows = [...document.querySelectorAll('tr[data-slug]')].map((r) => r.getAttribute('data-slug'))
    expect(rows).toEqual(['nightly', 'broken', 'weekly']) // favourite first, then by name
    expect(screen.getByRole('alert').textContent).toMatch(/could not be read/)
    expect(document.querySelector('.seq-cards')?.textContent).toContain('Nightly') // favourites card
    expect(screen.getByText('SEQ-20261109-001')).toBeTruthy()
  })

  it('creates a sequence and opens it in a tab', async () => {
    setup()
    mount('sequences')
    await screen.findByText('Weekly')
    fireEvent.input(screen.getByLabelText('New sequence name'), { target: { value: 'Fresh' } })
    fireEvent.submit(screen.getByLabelText('New sequence name').closest('form')!)
    await waitFor(() => expect(callsOf('sequences.create')[0]?.args).toEqual({ name: 'Fresh' }))
    await waitFor(() => expect(activeTab.value).toMatchObject({ kind: 'sequence', id: 'fresh' }))
  })

  it('shows the engine\'s refusal when the name is taken', async () => {
    setup()
    transport.on('sequences.create', () => ({ ok: false, error: "A sequence named 'Nightly' already exists." }))
    mount('sequences')
    await screen.findByText('Weekly')
    fireEvent.input(screen.getByLabelText('New sequence name'), { target: { value: 'Nightly' } })
    fireEvent.submit(screen.getByLabelText('New sequence name').closest('form')!)
    await waitFor(() => expect(toastTexts()).toContain("A sequence named 'Nightly' already exists."))
    expect(tabs.value.length).toBe(0)
  })

  it('filters, renames, favourites and deletes', async () => {
    setup()
    mount('sequences')
    await screen.findByText('Weekly')
    fireEvent.input(screen.getByLabelText('Filter sequences'), { target: { value: 'week' } })
    expect([...document.querySelectorAll('tr[data-slug]')].map((r) => r.getAttribute('data-slug'))).toEqual(['weekly'])
    fireEvent.click(screen.getByLabelText('Rename Weekly'))
    const input = await screen.findByLabelText('New name of Weekly')
    fireEvent.keyDown(input, { key: 'Enter', target: { value: 'Biweekly' } })
    await waitFor(() => expect(callsOf('sequences.rename')[0]?.args).toEqual({ slug: 'weekly', name: 'Biweekly' }))
    fireEvent.click(within(document.querySelector('tr[data-slug="weekly"]') as HTMLElement).getByTitle('Add to favourites'))
    await waitFor(() => expect(callsOf('sequences.favorite')[0]?.args).toEqual({ slug: 'weekly', on: true }))
    fireEvent.click(await screen.findByLabelText('Delete Biweekly')) // the list shows the new name
    await acceptConfirm()
    await waitFor(() => expect(callsOf('sequences.delete')[0]?.args).toEqual({ slug: 'weekly' }))
  })

  it('does not delete when the confirmation is declined', async () => {
    setup()
    mount('sequences')
    await screen.findByText('Weekly')
    fireEvent.click(screen.getByLabelText('Delete Weekly'))
    await acceptConfirm(false)
    expect(callsOf('sequences.delete').length).toBe(0)
  })
})

// ------------------------------------------------------------------------------------------- the editor
describe('Sequence editor: editing the graph', () => {
  it('draws the steps and arrows of the stored graph', async () => {
    install(transport)
    mount('sequence')
    await waitFor(() => expect(nodeEl('s1')).toBeTruthy())
    expect(nodeEl('s2').textContent).toContain('Cleanup')
    expect(document.querySelectorAll('.seq-link').length).toBe(1)
    expect(document.querySelector('.seq-label')?.textContent).toContain('✓ succeeded')
    expect(document.getElementById('seq-summary')?.textContent).toMatch(/2 steps, 1 starting at once/)
  })

  it('shows the empty hint and disables Run for a sequence without steps', async () => {
    install(transport, fakeGraph([]))
    mount('sequence')
    await screen.findByText('Drag scripts here')
    expect((document.getElementById('seq-play') as HTMLButtonElement).disabled).toBe(true)
  })

  it('moves a box on the grid with one graphOp, and Undo moves it back', async () => {
    install(transport)
    mount('sequence')
    await waitFor(() => expect(nodeEl('s1')).toBeTruthy())
    dragNode('s1', 53, 27)
    await waitFor(() => expect(callsOf('sequences.graphOp').length).toBe(1))
    expect(callsOf('sequences.graphOp')[0].args).toEqual({ slug: 'nightly', op: { op: 'move', positions: { s1: [100, 60] } } })
    await waitFor(() => expect(nodeEl('s1').style.left).toBe('100px'))
    fireEvent.click(document.getElementById('seq-undo')!)
    await waitFor(() => expect(callsOf('sequences.graphOp')[1]?.args.op).toEqual({ op: 'move', positions: { s1: [40, 40] } }))
    await waitFor(() => expect(nodeEl('s1').style.left).toBe('40px'))
    fireEvent.click(document.getElementById('seq-redo')!)
    await waitFor(() => expect(nodeEl('s1').style.left).toBe('100px'))
  })

  it('a drag that stays under 5px is a click: it selects the step and opens its settings', async () => {
    install(transport, undefined, { handlers: { 'sequences.step': () => ({ seq: {}, step: { id: 's1' }, n: 1, script: null, incoming: 0, fields: [], warnings: [], presets: [], source: 'values', hosts: [], defaultHost: 'local', host: '', join: 'all', hasPassword: false, problem: 'script not found' }) } })
    mount('sequence')
    await waitFor(() => expect(nodeEl('s1')).toBeTruthy())
    dragNode('s1', 2, 2)
    expect(callsOf('sequences.graphOp').length).toBe(0)
    await waitFor(() => expect(document.getElementById('seq-step-title')?.textContent).toBe('Step 1 · Backup'))
    expect(await screen.findByText(/was not found/)).toBeTruthy()
  })

  it('connects two steps by dragging the dot onto the other box', async () => {
    const g = install(transport, fakeGraph([{ id: 's1' }, { id: 's2' }, { id: 's3' }]))
    mount('sequence')
    await waitFor(() => expect(nodeEl('s3')).toBeTruthy())
    drawLink('s1', 's3')
    await waitFor(() => expect(callsOf('sequences.graphOp')[0]?.args.op).toEqual({ op: 'link', from: 's1', to: 's3', when: 'success' }))
    await waitFor(() => expect(document.querySelectorAll('.seq-link').length).toBe(1))
    expect(g.st.links).toEqual([{ from: 's1', to: 's3', when: 'success' }])
  })

  it('refuses a loop with the engine\'s message and leaves the graph as it was', async () => {
    const g = install(transport, fakeGraph([{ id: 's1' }, { id: 's2' }], [{ from: 's1', to: 's2', when: 'success' }]))
    mount('sequence')
    await waitFor(() => expect(nodeEl('s2')).toBeTruthy())
    drawLink('s2', 's1')
    await waitFor(() => expect(toastTexts()).toContain('That arrow would make a loop: the steps would never finish.'))
    expect(g.st.links.length).toBe(1)
    expect(document.querySelectorAll('.seq-link').length).toBe(1)
    expect(document.getElementById('seq-undo')).toHaveProperty('disabled', true) // a refused edit is not undoable
  })

  it('does not send a link that exists already', async () => {
    install(transport)
    mount('sequence')
    await waitFor(() => expect(nodeEl('s2')).toBeTruthy())
    drawLink('s1', 's2')
    await new Promise((r) => setTimeout(r, 30))
    expect(callsOf('sequences.graphOp').length).toBe(0)
  })

  it('clicking an arrow\'s label cycles succeeded → failed → always and Undo restores the previous condition', async () => {
    const g = install(transport)
    mount('sequence')
    await waitFor(() => expect(document.querySelector('.seq-when')).toBeTruthy())
    fireEvent.click(document.querySelector('.seq-when')!)
    await waitFor(() => expect(g.st.links[0].when).toBe('failure'))
    await waitFor(() => expect(document.querySelector('.seq-when')?.textContent).toBe('✗ failed'))
    fireEvent.click(document.querySelector('.seq-when')!)
    await waitFor(() => expect(g.st.links[0].when).toBe('always'))
    fireEvent.click(document.getElementById('seq-undo')!)
    await waitFor(() => expect(g.st.links[0].when).toBe('failure'))
  })

  it('removes an arrow with its × and Undo brings it back', async () => {
    const g = install(transport)
    mount('sequence')
    await waitFor(() => expect(document.querySelector('.seq-unlink')).toBeTruthy())
    fireEvent.click(document.querySelector('.seq-unlink')!)
    await waitFor(() => expect(g.st.links.length).toBe(0))
    fireEvent.click(document.getElementById('seq-undo')!)
    await waitFor(() => expect(g.st.links).toEqual([{ from: 's1', to: 's2', when: 'success' }]))
  })

  it('removes a step after a confirmation, and Undo recreates it with its arrows and values', async () => {
    const g = install(transport, undefined, {
      handlers: {
        'sequences.step': ({ stepId }: any) => ({
          seq: {}, step: { id: stepId }, n: 1, script: { id: 'x', name: 'Backup', relative: 'b.py' }, incoming: 0, warnings: [], presets: [], source: 'values', hosts: ['local'], defaultHost: 'local', host: 'web-1', join: 'all', hasPassword: false, problem: null,
          fields: [{ name: 'days', input: 'number', value: 30, p: { type: 'number', label: 'Days' }, choices: [], selected: [], locked: false, error: null }],
        }),
        'sequences.saveStep': () => ({ ok: true }),
      },
    })
    mount('sequence')
    await waitFor(() => expect(nodeEl('s1')).toBeTruthy())
    fireEvent.click(nodeEl('s1').querySelector('.seq-x')!)
    await acceptConfirm()
    await waitFor(() => expect(g.st.steps.map((s) => s.id)).toEqual(['s2']))
    expect(g.st.links).toEqual([])
    fireEvent.click(document.getElementById('seq-undo')!)
    await waitFor(() => expect(g.st.steps.length).toBe(2))
    const back = g.st.steps.find((s) => s.id !== 's2')!
    expect(back.script).toBe('aaaaaaaaaa00')
    await waitFor(() => expect(g.st.links).toEqual([{ from: back.id, to: 's2', when: 'success' }])) // the arrow follows the new id
    const saved = callsOf('sequences.saveStep')[0]?.args
    expect(saved).toMatchObject({ stepId: back.id, host: 'web-1', source: 'values', values: { days: 30 } })
  })

  it('keeps the step when the removal is declined', async () => {
    const g = install(transport)
    mount('sequence')
    await waitFor(() => expect(nodeEl('s1')).toBeTruthy())
    fireEvent.click(nodeEl('s1').querySelector('.seq-x')!)
    await acceptConfirm(false)
    expect(g.st.steps.length).toBe(2)
  })

  it('removes the selected step with the Delete key', async () => {
    const g = install(transport, undefined, { handlers: { 'sequences.step': () => { throw new Error('x') } } })
    mount('sequence')
    await waitFor(() => expect(nodeEl('s2')).toBeTruthy())
    dragNode('s2', 0, 0) // a click selects it
    canvas().focus()
    fireEvent.keyDown(canvas(), { key: 'Delete' })
    await acceptConfirm()
    await waitFor(() => expect(g.st.steps.map((s) => s.id)).toEqual(['s1']))
  })

  it('adds a step when a script is dropped from the explorer, and refuses beyond the step limit', async () => {
    const g = install(transport, fakeGraph([{ id: 's1' }, { id: 's2' }]))
    transport.on('sequences.step', () => { throw new Error('x') })
    mount('sequence')
    await waitFor(() => expect(nodeEl('s2')).toBeTruthy())
    const drop = (id: string) => dropAt(213, 171, id)
    drop('zzzzzzzzzzzz')
    await waitFor(() => expect(g.st.steps.length).toBe(3))
    expect(callsOf('sequences.graphOp').at(-1)?.args.op).toEqual({ op: 'add', script: 'zzzzzzzzzzzz', x: 120, y: 300 }) // (120,140) would sit on step 2 (and keep no gap to it), so it slides below it
    drop('yyyyyyyyyyyy') // maxSteps is 3 in this fake
    await waitFor(() => expect(toastTexts()).toContain('A sequence has at most 3 steps.'))
    expect(g.st.steps.length).toBe(3)
    // ignores drops that are not scripts
    fireEvent.drop(canvas(), { dataTransfer: { types: ['text/plain'], getData: () => 'x' } })
    expect(g.st.steps.length).toBe(3)
  })

  it('Undo of an added step removes it again; Redo adds it once more', async () => {
    const g = install(transport, fakeGraph([{ id: 's1' }]))
    transport.on('sequences.step', () => { throw new Error('x') })
    mount('sequence')
    await waitFor(() => expect(nodeEl('s1')).toBeTruthy())
    dropAt(300, 200, 'newscript000')
    await waitFor(() => expect(g.st.steps.length).toBe(2))
    fireEvent.click(document.getElementById('seq-undo')!)
    await waitFor(() => expect(g.st.steps.length).toBe(1))
    fireEvent.click(document.getElementById('seq-redo')!)
    await waitFor(() => expect(g.st.steps.length).toBe(2))
  })

  it('Ctrl+Z undoes from the keyboard', async () => {
    const g = install(transport)
    mount('sequence')
    await waitFor(() => expect(nodeEl('s1')).toBeTruthy())
    dragNode('s1', 60, 0)
    await waitFor(() => expect(g.st.steps[0].x).toBe(100))
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(g.st.steps[0].x).toBe(40))
  })

  it('Tidy up lays the steps out and sends one move for all of them', async () => {
    const g = install(transport, fakeGraph([{ id: 's1', x: 300, y: 300 }, { id: 's2', x: 0, y: 0 }], [{ from: 's1', to: 's2', when: 'always' }]))
    mount('sequence')
    await waitFor(() => expect(nodeEl('s1')).toBeTruthy())
    fireEvent.click(screen.getByText('Tidy up'))
    await waitFor(() => expect(callsOf('sequences.graphOp').length).toBe(1))
    const positions = callsOf('sequences.graphOp')[0].args.op.positions
    expect(Object.keys(positions).sort()).toEqual(['s1', 's2'])
    expect(positions.s1[1]).toBeLessThan(positions.s2[1])
    expect(g.st.steps[0].y).toBeLessThan(g.st.steps[1].y)
  })
})

// ------------------------------------------------------------------------------------------- step settings
describe('Sequence editor: step settings', () => {
  const form = (over: any = {}) => ({
    seq: {}, step: { id: 's1', path: 'C:\\s\\0.py' }, n: 1, script: { id: 'aaaaaaaaaa00', name: 'Backup', relative: 'backup.py' }, incoming: 2, warnings: [],
    presets: [{ slug: 'prod', name: 'Production', saved_at: '', host: '' }], source: 'values', hosts: ['local', 'web-1'], defaultHost: 'local', host: '', join: 'all', hasPassword: true, problem: null,
    fields: [
      { name: 'days', input: 'number', value: 30, p: { type: 'number', label: 'Days', min: 1, max: 365 }, choices: [], selected: [], locked: false, error: null },
      { name: 'token', input: 'password', value: '', p: { type: 'password', label: 'Token' }, choices: [], selected: [], locked: false, error: null },
    ],
    ...over,
  })

  it('shows host, preset choice, join (several arrows) and values, never a password field, and saves', async () => {
    install(transport, undefined, { handlers: { 'sequences.step': () => form(), 'sequences.saveStep': () => ({ ok: true }) } })
    mount('sequence')
    await waitFor(() => expect(nodeEl('s1')).toBeTruthy())
    dragNode('s1', 0, 0)
    const f = await screen.findByTestId('step-form')
    expect(within(f).getByText('Backup')).toBeTruthy()
    expect(within(f).getByLabelText('Days')).toBeTruthy()
    expect(within(f).queryByLabelText(/Token/)).toBeNull()
    expect(within(f).getByText(/Passwords are never saved/)).toBeTruthy()
    expect(within(f).getByText('2 arrows lead here')).toBeTruthy()
    fireEvent.input(within(f).getByLabelText('Days'), { target: { value: '45' } })
    fireEvent.change(within(f).getByLabelText('Host'), { target: { value: 'web-1' } })
    fireEvent.click(within(f).getByLabelText('Start after the first'))
    fireEvent.submit(f)
    await waitFor(() => expect(callsOf('sequences.saveStep')[0]?.args).toEqual({ slug: 'nightly', stepId: 's1', source: 'values', host: 'web-1', join: 'any', values: { days: '45' } }))
    await waitFor(() => expect(toastTexts()).toContain('Step saved.'))
  })

  it('a preset replaces the stored values: no values are sent and the fields are hidden', async () => {
    install(transport, undefined, { handlers: { 'sequences.step': () => form(), 'sequences.saveStep': () => ({ ok: true }) } })
    mount('sequence')
    await waitFor(() => expect(nodeEl('s1')).toBeTruthy())
    dragNode('s1', 0, 0)
    const f = await screen.findByTestId('step-form')
    fireEvent.change(within(f).getByLabelText('Values'), { target: { value: 'prod' } })
    expect(within(f).queryByLabelText('Days')).toBeNull()
    fireEvent.submit(f)
    await waitFor(() => expect(callsOf('sequences.saveStep')[0]?.args).toEqual({ slug: 'nightly', stepId: 's1', source: 'prod', host: '', join: 'all' }))
  })

  it('shows field errors from the engine next to the field', async () => {
    install(transport, undefined, { handlers: { 'sequences.step': () => form(), 'sequences.saveStep': () => ({ ok: false, errors: { days: 'Days must be at least 1.' }, error: null }) } })
    mount('sequence')
    await waitFor(() => expect(nodeEl('s1')).toBeTruthy())
    dragNode('s1', 0, 0)
    const f = await screen.findByTestId('step-form')
    fireEvent.submit(f)
    expect(await within(f).findByText('Days must be at least 1.')).toBeTruthy()
    expect(within(f).getByText('Please correct the highlighted fields.')).toBeTruthy()
    expect(toastTexts()).not.toContain('Step saved.')
  })
})

// ------------------------------------------------------------------------------------------- running
describe('Sequence editor: running', () => {
  const status = (over: any = {}) => ({
    id: 'SEQ-20261109-001', status: 'running', status_label: 'Running', active: true, paused: false, error: null, duration: '1s', done: 0, total: 2,
    graph: {
      steps: [
        { id: 's1', n: 1, script: 'a', name: 'Backup', ext: 'py', path: '', host: 'local', x: 40, y: 40, join: 'all', status: 'running', status_label: 'Running', run_id: 'RUN-20261109-001', error: null, hold: false, held: false },
        { id: 's2', n: 2, script: 'b', name: 'Cleanup', ext: 'py', path: '', host: 'local', x: 40, y: 160, join: 'all', status: 'pending', status_label: 'Pending', run_id: null, error: null, hold: false, held: false },
      ],
      links: [{ from: 's1', to: 's2', when: 'success' }],
    },
    ...over,
  })
  const runHandlers = (extra: Record<string, any> = {}) => ({
    handlers: {
      'sequences.start': () => ({ ok: true, run: 'SEQ-20261109-001', token: 'tok2' }),
      'sequences.runStatus': () => status(),
      'runs.status': () => ({ status: 'running', status_label: 'Running', active: true, exit_code: null, duration: '1s', error: null, stdout: 'hello\n', stdout_next: 6, stderr: '', stderr_next: 0 }),
      'runs.stop': () => ({ stopped: true, active: true }),
      ...extra,
    },
  })

  it('starts the sequence, locks the diagram, shows live statuses from events, follows the running step\'s console', async () => {
    install(transport, undefined, runHandlers())
    mount('sequence')
    await waitFor(() => expect(nodeEl('s1')).toBeTruthy())
    fireEvent.click(document.getElementById('seq-play')!)
    await waitFor(() => expect(callsOf('sequences.start')[0]?.args).toEqual({ slug: 'nightly', passwords: {}, token: 'tok1' }))
    await waitFor(() => expect(document.querySelector('.seq-canvas')?.classList.contains('is-locked')).toBe(true))
    await waitFor(() => expect(nodeEl('s1').getAttribute('data-status')).toBe('running'))
    expect(nodeEl('s2').getAttribute('data-status')).toBe('pending')
    expect(document.getElementById('seq-play')?.textContent).toContain('Pause')
    expect(document.getElementById('seq-stop')).toBeTruthy()
    // the console of the running step opens in the right column, seeded and then fed by events
    expect(await screen.findByText(/hello/)).toBeTruthy()
    await waitFor(() => expect(callsOf('runs.watch')[0]?.args).toEqual({ id: 'RUN-20261109-001', out: 6, err: 0 }))
    act(() => transport.emit('run.output', { id: 'RUN-20261109-001', stdout: 'more\n', stdout_next: 11, stderr: 'oops\n', stderr_next: 5 }))
    await waitFor(() => expect(document.querySelector('[data-stream="stdout"]')?.textContent).toBe('hello\nmore\n'))
    expect(document.querySelector('[data-stream="stderr"]')?.textContent).toBe('oops\n')
    // status events move the overlay
    act(() => transport.emit('sequence.status', status({
      graph: { ...status().graph, steps: status().graph.steps.map((s: any) => (s.id === 's1' ? { ...s, status: 'success', status_label: 'Succeeded' } : { ...s, status: 'running', status_label: 'Running', run_id: 'RUN-20261109-002' })) } })))
    await waitFor(() => expect(nodeEl('s1').getAttribute('data-status')).toBe('success'))
    expect(nodeEl('s2').getAttribute('data-status')).toBe('running')
    expect(document.querySelector('.seq-link')?.classList.contains('is-taken')).toBe(true) // the success arrow was taken
    // edits are refused while it runs
    drawLink('s2', 's1')
    expect(callsOf('sequences.graphOp').length).toBe(0)
    // finished: unlocked again, a failure is reported
    act(() => transport.emit('sequence.status', status({ status: 'failed', status_label: 'Failed', active: false, error: 'Step 1 (Backup) did not succeed.' })))
    await waitFor(() => expect(document.querySelector('.seq-canvas')?.classList.contains('is-locked')).toBe(false))
    expect(toastTexts().join()).toMatch(/Failed: Step 1 \(Backup\) did not succeed/)
    expect(document.getElementById('seq-play')?.textContent).toContain('Run')
  })

  it('ignores status events of other runs', async () => {
    install(transport, undefined, runHandlers())
    mount('sequence')
    await waitFor(() => expect(nodeEl('s1')).toBeTruthy())
    fireEvent.click(document.getElementById('seq-play')!)
    await waitFor(() => expect(nodeEl('s1').getAttribute('data-status')).toBe('running'))
    act(() => transport.emit('sequence.status', status({ id: 'SEQ-20261109-999', graph: { ...status().graph, steps: [{ ...status().graph.steps[0], status: 'failed', status_label: 'Failed' }] } })))
    expect(nodeEl('s1').getAttribute('data-status')).toBe('running')
  })

  it('refuses to start with the engine\'s errors, and with missing required passwords', async () => {
    install(transport, fakeGraph([{ id: 's1' }], [], [{ input: 'pw_s1_token', label: 'Token', step: 1, script: 'Backup', required: true }]), runHandlers({
      'sequences.start': () => ({ ok: false, errors: ['Step 1 (Backup): Days: must be a number', 'b', 'c', 'd'] }),
    }))
    mount('sequence')
    await waitFor(() => expect(nodeEl('s1')).toBeTruthy())
    fireEvent.click(document.getElementById('seq-play')!)
    await waitFor(() => expect(toastTexts().join()).toMatch(/Enter the passwords/))
    expect(callsOf('sequences.start').length).toBe(0)
    fireEvent.input(document.querySelector('input[id$="-pw_s1_token"]')!, { target: { value: 'hunter2' } })
    fireEvent.click(document.getElementById('seq-play')!)
    await waitFor(() => expect(callsOf('sequences.start')[0]?.args).toEqual({ slug: 'nightly', passwords: { s1: { token: 'hunter2' } }, token: 'tok1' }))
    await waitFor(() => expect(toastTexts().join(' ')).toMatch(/Days: must be a number · b · c · … and 1 more/))
    expect(document.querySelector('.seq-canvas')?.classList.contains('is-locked')).toBe(false)
  })

  it('a box ▶ runs only that step', async () => {
    install(transport, undefined, runHandlers())
    mount('sequence')
    await waitFor(() => expect(nodeEl('s2')).toBeTruthy())
    fireEvent.click(nodeEl('s2').querySelector('.seq-boxbtn')!)
    await waitFor(() => expect(callsOf('sequences.start')[0]?.args).toMatchObject({ slug: 'nightly', only: 's2' }))
  })

  it('pauses, resumes and stops (after confirming) the run in place', async () => {
    let paused = false
    install(transport, undefined, runHandlers({
      'sequences.runStatus': () => status({ paused }),
      'sequences.pause': () => { paused = true; return { ok: true } },
      'sequences.resume': () => { paused = false; return { ok: true } },
      'sequences.stop': () => ({ ok: true }),
    }))
    mount('sequence')
    await waitFor(() => expect(nodeEl('s1')).toBeTruthy())
    fireEvent.click(document.getElementById('seq-play')!)
    await waitFor(() => expect(document.getElementById('seq-play')?.textContent).toContain('Pause'))
    fireEvent.click(document.getElementById('seq-play')!)
    await waitFor(() => expect(callsOf('sequences.pause')[0]?.args).toEqual({ id: 'SEQ-20261109-001' }))
    await waitFor(() => expect(document.getElementById('seq-play')?.textContent).toContain('Resume'))
    expect(document.getElementById('seq-live')?.textContent).toContain('Paused')
    fireEvent.click(document.getElementById('seq-play')!)
    await waitFor(() => expect(callsOf('sequences.resume').length).toBe(1))
    fireEvent.click(document.getElementById('seq-stop')!)
    await acceptConfirm()
    await waitFor(() => expect(callsOf('sequences.stop')[0]?.args).toEqual({ id: 'SEQ-20261109-001' }))
  })

  it('Ctrl+Enter runs the sequence from the keyboard', async () => {
    install(transport, undefined, runHandlers())
    mount('sequence')
    await waitFor(() => expect(nodeEl('s1')).toBeTruthy())
    act(() => { emitCommand('run.run', { mode: 'normal', tab: null }) }) // what Ctrl+Enter, `r` and Run > Run send
    await waitFor(() => expect(callsOf('sequences.start').length).toBe(1))
  })

  it('⏸ on a step that has not started holds the run before it, and again takes it back', async () => {
    let held = false
    const withHold = () => { const b = status(); b.graph.steps[1].hold = held; return b }
    install(transport, undefined, runHandlers({
      'sequences.hold': ({ on }: any) => { held = on; return { ok: true } },
      'sequences.runStatus': withHold,
    }))
    mount('sequence')
    await waitFor(() => expect(nodeEl('s1')).toBeTruthy())
    fireEvent.click(document.getElementById('seq-play')!)
    await waitFor(() => expect(nodeEl('s2').querySelector('.seq-boxbtn')).toBeTruthy())
    expect(nodeEl('s1').querySelector('.seq-boxbtn')).toBeNull() // a started step has no ⏸
    fireEvent.click(nodeEl('s2').querySelector('.seq-boxbtn')!)
    await waitFor(() => expect(callsOf('sequences.hold')[0]?.args).toEqual({ id: 'SEQ-20261109-001', step: 's2', on: true }))
    await waitFor(() => expect(nodeEl('s2').querySelector('.seq-boxbtn.is-on')).toBeTruthy())
    fireEvent.click(nodeEl('s2').querySelector('.seq-boxbtn')!)
    await waitFor(() => expect(callsOf('sequences.hold')[1]?.args).toEqual({ id: 'SEQ-20261109-001', step: 's2', on: false }))
    await waitFor(() => expect(nodeEl('s2').querySelector('.seq-boxbtn.is-on')).toBeNull())
  })

  it('picks up a run that is still going when the page opens', async () => {
    install(transport, undefined, { activeRun: 'SEQ-20261109-001', ...runHandlers() })
    mount('sequence')
    await waitFor(() => expect(callsOf('sequences.watchRun')[0]?.args).toEqual({ id: 'SEQ-20261109-001' }))
    await waitFor(() => expect(nodeEl('s1').getAttribute('data-status')).toBe('running'))
    expect(document.querySelector('.seq-canvas')?.classList.contains('is-locked')).toBe(true)
    expect(document.getElementById('seq-live')).toBeTruthy() // the chip that links to the run's page
  })

  it('renames the sequence from its panel', async () => {
    install(transport, undefined, { handlers: { 'sequences.rename': () => ({ ok: true }), 'app.shell': () => { throw new Error('no shell') } } })
    mount('sequence')
    await screen.findByText('Nightly')
    fireEvent.click(screen.getByLabelText('Rename sequence'))
    const input = await screen.findByLabelText('Sequence name')
    fireEvent.keyDown(input, { key: 'Enter', target: { value: 'Nightly maintenance' } })
    await waitFor(() => expect(callsOf('sequences.rename')[0]?.args).toEqual({ slug: 'nightly', name: 'Nightly maintenance' }))
  })
})

// ------------------------------------------------------------------------------------------- the run page
describe('Sequence run page', () => {
  const run = (over: any = {}) => ({
    run: { id: 'SEQ-20261109-001', name: 'Nightly', sequence: 'nightly', status: 'success', status_label: 'Succeeded', active: false, paused: false, done: 2, duration: '5s', error: null, steps: [{}, {}], ...over },
    graph: {
      steps: [
        { id: 's1', n: 1, script: 'a', name: 'Backup', ext: 'py', path: '', host: 'local', x: 40, y: 40, join: 'all', status: 'success', status_label: 'Succeeded', run_id: 'RUN-20261109-001', error: null, hold: false, held: false },
        { id: 's2', n: 2, script: 'b', name: 'Cleanup', ext: 'sh', path: '', host: 'web-1', x: 40, y: 160, join: 'all', status: 'failed', status_label: 'Failed', run_id: 'RUN-20261109-002', error: 'exit 3', hold: false, held: false },
      ],
      links: [{ from: 's1', to: 's2', when: 'success' }],
    },
    seqExists: true,
  })
  const consoleHandlers = () => ({
    'runs.status': ({ id }: any) => ({ status: 'success', status_label: 'Succeeded', active: false, exit_code: 0, duration: '1s', error: null, stdout: `output of ${id}\n`, stdout_next: 20, stderr: '', stderr_next: 0 }),
    'runs.watch': () => ({ ok: true }), 'runs.unwatch': () => ({ ok: true }), 'sequences.unwatchRun': () => ({ ok: true }), 'sequences.watchRun': () => ({ ok: true }),
  })

  it('shows a finished run: status, steps, statuses on the boxes, and the console of the last started step', async () => {
    transport.on('sequences.run', () => run())
    for (const [k, v] of Object.entries(consoleHandlers())) transport.on(k as any, v as any)
    mount('sequence-run', 'SEQ-20261109-001')
    await screen.findByText('Nightly')
    expect(document.getElementById('seq-status')?.textContent).toBe('Succeeded')
    expect(document.getElementById('seq-progress')?.textContent).toContain('2/2 steps')
    expect(nodeEl('s2').getAttribute('data-status')).toBe('failed')
    expect(await screen.findByText(/output of RUN-20261109-002/)).toBeTruthy() // follows the last step
    expect(document.getElementById('seq-stop')).toBeNull() // finished: nothing to stop
    expect(document.getElementById('seq-again')).toBeTruthy()
    expect(screen.getByText('exit 3')).toBeTruthy()
  })

  it('a click on a step shows that step\'s console and stops following', async () => {
    transport.on('sequences.run', () => run())
    for (const [k, v] of Object.entries(consoleHandlers())) transport.on(k as any, v as any)
    mount('sequence-run', 'SEQ-20261109-001')
    await screen.findByText(/output of RUN-20261109-002/)
    fireEvent.pointerDown(nodeEl('s1'), { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    fireEvent.pointerUp(canvas(), { clientX: 5, clientY: 5, pointerId: 1 })
    expect(await screen.findByText(/output of RUN-20261109-001/)).toBeTruthy()
  })

  it('a run in progress is live: events update it, it can be paused, resumed and stopped, and ends without controls', async () => {
    const live = run({ status: 'running', status_label: 'Running', active: true, done: 1 })
    live.graph.steps[1] = { ...live.graph.steps[1], status: 'pending', status_label: 'Pending', run_id: null, error: null } as any
    transport.on('sequences.run', () => live)
    for (const [k, v] of Object.entries(consoleHandlers())) transport.on(k as any, v as any)
    transport.on('sequences.pause', () => ({ ok: true }))
    transport.on('sequences.resume', () => ({ ok: true }))
    transport.on('sequences.stop', () => ({ ok: true }))
    const next = (over: any) => ({ id: 'SEQ-20261109-001', status: 'running', status_label: 'Running', active: true, paused: false, error: null, duration: '2s', done: 1, total: 2, graph: live.graph, ...over })
    let current: any = next({})
    transport.on('sequences.runStatus', () => current)
    mount('sequence-run', 'SEQ-20261109-001')
    await waitFor(() => expect(document.getElementById('seq-stop')).toBeTruthy())
    expect(callsOf('sequences.watchRun').length).toBe(1)
    current = next({ paused: true })
    fireEvent.click(document.getElementById('seq-pause')!)
    await waitFor(() => expect(document.getElementById('seq-resume')).toBeTruthy())
    expect(document.getElementById('seq-status')?.textContent).toBe('Paused')
    current = next({})
    fireEvent.click(document.getElementById('seq-resume')!)
    await waitFor(() => expect(document.getElementById('seq-pause')).toBeTruthy())
    fireEvent.click(document.getElementById('seq-stop')!)
    await acceptConfirm()
    await waitFor(() => expect(callsOf('sequences.stop').length).toBe(1))
    act(() => transport.emit('sequence.status', next({ status: 'cancelled', status_label: 'Cancelled', active: false, error: 'Stopped by user.', graph: { ...live.graph, steps: live.graph.steps.map((s: any) => (s.status === 'pending' ? { ...s, status: 'skipped', status_label: 'Skipped' } : s)) } })))
    await waitFor(() => expect(document.getElementById('seq-stop')).toBeNull())
    expect(document.getElementById('seq-error')?.textContent).toBe('Stopped by user.')
    expect(nodeEl('s2').getAttribute('data-status')).toBe('skipped')
  })

  it('opens a step\'s run in its own tab and deletes the record after confirming', async () => {
    transport.on('sequences.run', () => run())
    for (const [k, v] of Object.entries(consoleHandlers())) transport.on(k as any, v as any)
    transport.on('sequences.deleteRun', () => ({ deleted: true }))
    mount('sequence-run', 'SEQ-20261109-001')
    await screen.findByText(/output of RUN-20261109-002/)
    fireEvent.click(screen.getByText('Steps (2)'))
    fireEvent.click(screen.getAllByText('RUN-20261109-001').find((e) => e.tagName === 'A')!)
    expect(activeTab.value).toMatchObject({ kind: 'run', id: 'RUN-20261109-001' })
    fireEvent.click(document.getElementById('seq-delete')!)
    await acceptConfirm()
    await waitFor(() => expect(callsOf('sequences.deleteRun')[0]?.args).toEqual({ id: 'SEQ-20261109-001' }))
  })

  it('says so when the run does not exist', async () => {
    transport.on('sequences.run', () => { throw new Error('Unknown sequence run') })
    mount('sequence-run', 'SEQ-20261109-009')
    expect(await screen.findByText('Unknown sequence run')).toBeTruthy()
  })
})

describe('dropping several scripts (regression: boxes dropped above/left of the origin piled up on each other)', () => {
  it('freeSlot keeps a free place and slides an occupied one down', async () => {
    const { freeSlot } = await import('../src/panels/sequence/geometry')
    expect(freeSlot(40, 0, [])).toEqual({ x: 40, y: 0 })
    expect(freeSlot(40, 0, [{ x: 400, y: 0 }])).toEqual({ x: 40, y: 0 }) // far away: free
    expect(freeSlot(40, 0, [{ x: 40, y: 0 }])).toEqual({ x: 40, y: 80 }) // 20px of air between the boxes
    expect(freeSlot(40, 0, [{ x: 40, y: 0 }, { x: 60, y: 80 }, { x: 0, y: 160 }])).toEqual({ x: 40, y: 240 })
    expect(freeSlot(40, 0, [{ x: 40, y: 40 }])).toEqual({ x: 40, y: 160 }) // a box that merely overlaps counts: 0 and 80 both touch it
  })

  it('two drops on the same spot end up as two separate boxes', async () => {
    const g = install(transport, fakeGraph([{ id: 's1' }]))
    transport.on('sequences.step', () => { throw new Error('x') })
    mount('sequence')
    await waitFor(() => expect(nodeEl('s1')).toBeTruthy())
    dropAt(5, 5, 'aaaaaaaaaaaa') // above/left of everything: clamps to the origin
    await waitFor(() => expect(g.st.steps.length).toBe(2))
    dropAt(5, 5, 'bbbbbbbbbbbb')
    await waitFor(() => expect(g.st.steps.length).toBe(3))
    const spots = g.st.steps.map((s) => `${s.x},${s.y}`)
    expect(new Set(spots).size).toBe(3)
  })
});

describe('the diagram view', () => {
  it('anchors a small diagram at the top left (so a drop above/left of a lone box still has room), and centres a big one', async () => {
    const { fitView, W, H } = await import('../src/panels/sequence/geometry')
    expect(fitView([{ x: 100, y: 60 }], 600, 500)).toEqual({ x: 40 - 100, y: 40 - 60, z: 1 })
    const wide = fitView([{ x: 0, y: 0 }, { x: 4000, y: 0 }], 600, 500)
    expect(wide.z).toBeLessThan(1) // too big at full size: zoomed out and centred
    void W; void H
  })
})
