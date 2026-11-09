import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/preact'
import { describe, expect, it, vi } from 'vitest'
import '../src/panels/history'
import { confirmState } from '../src/core/confirm'
import { getPanel } from '../src/core/panels'
import { activeKey, activeTab, tabs } from '../src/core/tabs'
import { toasts } from '../src/core/toast'
import { counts, hostInfo } from '../src/core/shellState'
import { downloadText, historyCsv, relTime, formatDuration } from '../src/panels/history/format'
import { durationSeconds } from '../src/panels/history/HistoryPanel'
import { transport } from './setup'

const runRow = (id: string, over: Record<string, any> = {}) => ({
  kind: 'script', id, script_id: 'aaaaaaaaaaaa', script_name: 'Hello World', host: 'local', status: 'success', status_label: 'Succeeded', exit_code: 0,
  started_display: '2026-11-09 21:10:00', started_at: '2026-11-09T21:10:00', duration: '4s', active: false, logs_deleted: false, seq: null, initiator: 'local', ...over,
})
const seqRow = (id: string, over: Record<string, any> = {}) => ({
  kind: 'sequence', id, name: 'Nightly', status: 'failed', status_label: 'Failed', done: 2, steps: [{}, {}, {}], started_display: '2026-11-09 22:00', started_at: '2026-11-09T22:00:00', duration: '1m 05s', active: false, paused: false, ...over,
})
const STATUSES = [['queued', 'Queued'], ['running', 'Running'], ['success', 'Succeeded'], ['failed', 'Failed'], ['cancelled', 'Cancelled']]
const none = { active: [], activeSeqs: [], activeTotal: 0 }
const page = (runs: any[], over: Record<string, any> = {}) => ({
  runs, f: { q: '', kind: '', script: '', status: '', date_from: '', date_to: '' }, scripts: [['aaaaaaaaaaaa', 'Hello World']], sequenceChoices: [['seq:nightly', 'Nightly']],
  statuses: STATUSES, total: runs.length, page: 1, pages: 1, first: runs.length ? 1 : 0, last: runs.length, filtered: false, historyDays: 90, logDays: 30, running: none, ...over,
})
const queryCalls = () => transport.calls.filter((c) => c.name === 'runs.query')
const lastQuery = () => queryCalls()[queryCalls().length - 1].args

function mount(active = true) {
  const Panel = getPanel('history')!.component
  const tab = { key: 'history:', kind: 'history' as const, title: 'Runs', icon: 'list', params: {} }
  return render(<Panel tab={tab} active={active} />)
}
const ready = async (text = 'Hello World') => { mount(); await screen.findAllByText(text) }
const readBlob = (b: Blob) => new Promise<string>((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.readAsText(b) })
const rowsText = () => [...document.querySelectorAll('tr[data-hist-row]')].map((r) => (r as HTMLElement).dataset.histRow)

describe('History panel', () => {
  it('lists script and sequence runs with status chips, step links, exit codes and durations', async () => {
    transport.on('runs.query', () => page([
      runRow('RUN-20261109-002', { status: 'failed', status_label: 'Failed', exit_code: 3, seq: { run: 'SEQ-20261109-001', step: 2, name: 'Nightly' } }),
      seqRow('SEQ-20261109-001'), runRow('RUN-20261109-001'),
    ]))
    await ready()
    expect(rowsText()).toEqual(['RUN-20261109-002', 'SEQ-20261109-001', 'RUN-20261109-001'])
    const seq = document.querySelector('tr[data-hist-row="SEQ-20261109-001"]') as HTMLElement
    expect(seq.classList.contains('hist-seq')).toBe(true)
    expect(within(seq).getByText('2/3 steps')).toBeTruthy()
    expect(within(seq).getByText('1m 05s')).toBeTruthy()
    const step = document.querySelector('tr[data-hist-row="RUN-20261109-002"]') as HTMLElement
    expect(within(step).getByText(/↳ Nightly · step 2/)).toBeTruthy()
    expect(within(step).getByText('3')).toBeTruthy() // exit code
    expect(within(step).getByText('Failed').className).toContain('st-failed')
    expect(screen.getByText('Showing 1–3 of 3')).toBeTruthy()
    expect(lastQuery()).toMatchObject({ q: '', kind: '', script: '', status: '', dateFrom: '', dateTo: '', page: 1 })
  })

  it('filters: search (after a pause), status chips, selects, clear, and the filters are remembered', async () => {
    transport.on('runs.query', ({ status }: any) => page([runRow('RUN-20261109-001')], { filtered: !!status }))
    await ready()
    fireEvent.input(screen.getByLabelText('Search'), { target: { value: 'backup' } })
    await waitFor(() => expect(lastQuery().q).toBe('backup'))
    fireEvent.click(screen.getAllByText('Failed').find((e) => e.tagName === 'BUTTON')!)
    await waitFor(() => expect(lastQuery()).toMatchObject({ q: 'backup', status: 'failed', page: 1 }))
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'sequences' } })
    await waitFor(() => expect(lastQuery().kind).toBe('sequences'))
    fireEvent.change(screen.getByLabelText('Script or sequence'), { target: { value: 'seq:nightly' } })
    await waitFor(() => expect(lastQuery().script).toBe('seq:nightly'))
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-01' } })
    await waitFor(() => expect(lastQuery().dateFrom).toBe('2026-11-01'))
    expect(JSON.parse(localStorage.getItem('scripthub.history.filters')!)).toMatchObject({ q: 'backup', status: 'failed', kind: 'sequences', script: 'seq:nightly', dateFrom: '2026-11-01' })

    document.body.innerHTML = '' // a fresh panel starts with the remembered filters
    mount()
    await waitFor(() => expect(lastQuery()).toMatchObject({ q: 'backup', status: 'failed', kind: 'sequences' }))
    fireEvent.click(await screen.findByText('Clear filters'))
    await waitFor(() => expect(lastQuery()).toMatchObject({ q: '', status: '', kind: '', script: '', dateFrom: '' }))
  })

  it('pages with the buttons and the [ ] keys, and a filter change returns to page 1', async () => {
    transport.on('runs.query', ({ page: p }: any) => page([runRow(`RUN-20261109-00${p}`)], { page: p, pages: 3, total: 120, first: (p - 1) * 50 + 1, last: p * 50 }))
    await ready()
    expect(screen.getByText('Page 1 of 3')).toBeTruthy()
    fireEvent.click(screen.getByText('Next ›'))
    await waitFor(() => expect(lastQuery().page).toBe(2))
    fireEvent.keyDown(window, { key: ']' })
    await waitFor(() => expect(lastQuery().page).toBe(3))
    expect((screen.getByText('Next ›') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(window, { key: '[' })
    await waitFor(() => expect(lastQuery().page).toBe(2))
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'failed' } })
    await waitFor(() => expect(lastQuery()).toMatchObject({ page: 1, status: 'failed' }))
  })

  it('deletes one run after a confirmation, and a sequence run through its own call', async () => {
    transport.on('runs.query', () => page([runRow('RUN-20261109-001'), seqRow('SEQ-20261109-001')]))
    transport.on('runs.delete', () => ({ deleted: true }))
    transport.on('sequences.deleteRun', () => ({ deleted: true }))
    await ready()
    fireEvent.click(screen.getByLabelText('Delete RUN-20261109-001'))
    await waitFor(() => expect(confirmState.value?.message).toBe('Delete RUN-20261109-001 and its logs?'))
    act(() => confirmState.value!.resolve(true))
    await waitFor(() => expect(transport.calls.find((c) => c.name === 'runs.delete')?.args).toEqual({ id: 'RUN-20261109-001' }))
    fireEvent.click(screen.getByLabelText('Delete SEQ-20261109-001'))
    await waitFor(() => expect(confirmState.value?.message).toMatch(/step runs stay/))
    act(() => confirmState.value!.resolve(false)) // declined: nothing is deleted
    await new Promise((r) => setTimeout(r, 30))
    expect(transport.count('sequences.deleteRun')).toBe(0)
  })

  it('selects several runs and deletes them together; a running run cannot be selected', async () => {
    transport.on('runs.query', () => page([runRow('RUN-20261109-003', { status: 'running', status_label: 'Running', active: true, duration: '2s' }), runRow('RUN-20261109-002'), runRow('RUN-20261109-001'), seqRow('SEQ-20261109-001')]))
    transport.on('runs.delete', () => ({ deleted: true }))
    transport.on('sequences.deleteRun', () => ({ deleted: true }))
    await ready()
    expect(screen.queryByLabelText('Select RUN-20261109-003')).toBeNull()
    fireEvent.click(screen.getByLabelText('Select all on this page'))
    expect(screen.getByText('3 selected')).toBeTruthy()
    fireEvent.click(screen.getByText('Delete selected'))
    await waitFor(() => expect(confirmState.value?.message).toMatch(/Delete 3 runs/))
    act(() => confirmState.value!.resolve(true))
    await waitFor(() => expect(transport.count('runs.delete') + transport.count('sequences.deleteRun')).toBe(3))
    expect(transport.calls.filter((c) => c.name === 'runs.delete').map((c) => c.args.id).sort()).toEqual(['RUN-20261109-001', 'RUN-20261109-002'])
    await waitFor(() => expect(toasts.value.some((t) => t.text === 'Deleted 3 runs.')).toBe(true))
  })

  it('sorts the page by a column and remembers it', async () => {
    transport.on('runs.query', () => page([runRow('RUN-20261109-001', { duration: '4s' }), runRow('RUN-20261109-002', { duration: '1m 05s' }), runRow('RUN-20261109-003', { duration: '12s' })]))
    await ready()
    fireEvent.click(screen.getByText('Duration'))
    expect(rowsText()).toEqual(['RUN-20261109-001', 'RUN-20261109-003', 'RUN-20261109-002'])
    fireEvent.click(screen.getByText(/Duration/))
    expect(rowsText()).toEqual(['RUN-20261109-002', 'RUN-20261109-003', 'RUN-20261109-001'])
    expect(JSON.parse(localStorage.getItem('scripthub.history.sort')!)).toEqual({ key: 'duration', dir: -1 })
    fireEvent.click(screen.getByText(/Duration/)) // third click: back to the engine's order
    expect(rowsText()).toEqual(['RUN-20261109-001', 'RUN-20261109-002', 'RUN-20261109-003'])
  })

  it('opens runs and sequence runs as tabs, from the id, the button and the keyboard', async () => {
    transport.on('runs.query', () => page([runRow('RUN-20261109-001'), seqRow('SEQ-20261109-001')]))
    await ready()
    fireEvent.click(screen.getByText('RUN-20261109-001'))
    expect(activeTab.value).toMatchObject({ kind: 'run', id: 'RUN-20261109-001', params: { scriptId: 'aaaaaaaaaaaa' } })
    fireEvent.click(screen.getByLabelText('Open the sequence run'))
    expect(activeTab.value).toMatchObject({ kind: 'sequence-run', id: 'SEQ-20261109-001' })
    tabs.value = []; activeKey.value = null
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(activeTab.value).toMatchObject({ kind: 'sequence-run', id: 'SEQ-20261109-001' })
  })

  it('runs a script again with the values of that run, or opens the form when they are gone', async () => {
    transport.on('runs.query', () => page([runRow('RUN-20261109-002'), runRow('RUN-20261109-001')]))
    transport.on('presets.list', () => ({ presets: [], recent: [{ key: '@0', run_id: 'RUN-20261109-001' }] }))
    transport.on('runs.start', () => ({ ok: true, runId: 'RUN-20261109-009' }) as any)
    await ready()
    const again = screen.getAllByLabelText('Run again')
    fireEvent.click(again[1]) // RUN-…-001: its values are still saved
    await waitFor(() => expect(transport.calls.find((c) => c.name === 'runs.start')?.args).toMatchObject({ scriptId: 'aaaaaaaaaaaa', fromPreset: '@0' }))
    await waitFor(() => expect(activeTab.value).toMatchObject({ kind: 'run', id: 'RUN-20261109-009' }))
    fireEvent.click(again[0]) // RUN-…-002: not in the saved list
    await waitFor(() => expect(activeTab.value).toMatchObject({ kind: 'script', id: 'aaaaaaaaaaaa', params: { view: 'run' } }))
    expect(transport.count('runs.start')).toBe(1)
  })

  it('shows what is running and keeps it live from pushed events, reloading the list when a run ends', async () => {
    const active = { id: 'RUN-20261109-005', script_id: 'aaaaaaaaaaaa', script_name: 'Slow Job', host: 'local', status: 'running', status_label: 'Running', duration: '3s', started_at: '2026-11-09T21:10:00', position: 0 }
    const seq = { id: 'SEQ-20261109-002', name: 'Nightly', status: 'running', status_label: 'Running', done: 1, steps: [{}, {}], duration: '9s', paused: false }
    let current: any = { active: [active], activeSeqs: [seq], activeTotal: 2 }
    transport.on('runs.running', () => current)
    transport.on('runs.watch', () => ({ ok: true }))
    transport.on('runs.unwatch', () => ({ ok: true }))
    transport.on('sequences.watchRun', () => ({ ok: true }))
    transport.on('sequences.unwatchRun', () => ({ ok: true }))
    transport.on('runs.query', () => page([runRow('RUN-20261109-001')], { running: current }))
    mount()
    const panel = await screen.findByTestId('running-panel')
    expect(within(panel).getByText('Slow Job')).toBeTruthy()
    expect(within(panel).getByText('1/2 steps')).toBeTruthy()
    await waitFor(() => expect(transport.calls.filter((c) => c.name === 'runs.watch').map((c) => c.args.id)).toEqual(['RUN-20261109-005']))
    expect(transport.calls.filter((c) => c.name === 'sequences.watchRun').map((c) => c.args.id)).toEqual(['SEQ-20261109-002'])

    act(() => transport.emit('run.status', { id: 'RUN-20261109-005', status: 'queued', status_label: 'Queued', active: true, duration: '0s', queue_position: 2 } as any))
    expect(within(panel).getByText('Queued · #2')).toBeTruthy()
    const before = transport.count('runs.query')
    current = none // everything finished meanwhile
    act(() => transport.emit('run.status', { id: 'RUN-20261109-005', status: 'success', status_label: 'Succeeded', active: false, duration: '5s', queue_position: null } as any))
    await waitFor(() => expect(screen.queryByTestId('running-panel')).toBeNull())
    await waitFor(() => expect(transport.count('runs.query')).toBeGreaterThan(before)) // the table shows how it finished
    expect(transport.calls.filter((c) => c.name === 'runs.unwatch').map((c) => c.args.id)).toContain('RUN-20261109-005')
  })

  it('notices a run that started elsewhere through the status bar counts', async () => {
    let current: any = none
    transport.on('runs.running', () => current)
    transport.on('runs.watch', () => ({ ok: true }))
    transport.on('runs.query', () => page([runRow('RUN-20261109-001')], { running: current }))
    mount()
    await screen.findAllByText('Hello World')
    expect(screen.queryByTestId('running-panel')).toBeNull()
    current = { active: [{ id: 'RUN-20261109-007', script_name: 'New Job', host: 'local', status: 'queued', status_label: 'Queued', duration: '0s', position: 1 }], activeSeqs: [], activeTotal: 1 }
    act(() => { counts.value = { running: 0, queued: 1 } })
    const panel = await screen.findByTestId('running-panel')
    expect(within(panel).getByText('New Job')).toBeTruthy()
    expect(within(panel).getByText(/Queued · #1/)).toBeTruthy()
  })

  it('stops a running execution after a confirmation', async () => {
    const active = { id: 'RUN-20261109-005', script_name: 'Slow Job', host: 'local', status: 'running', status_label: 'Running', duration: '3s' }
    transport.on('runs.running', () => ({ active: [active], activeSeqs: [], activeTotal: 1 }))
    transport.on('runs.watch', () => ({ ok: true }))
    transport.on('runs.stop', () => ({ stopped: true, active: true }))
    transport.on('runs.query', () => page([], { running: { active: [active], activeSeqs: [], activeTotal: 1 } }))
    mount()
    fireEvent.click(await screen.findByText('Stop'))
    await waitFor(() => expect(confirmState.value?.message).toBe('Stop Slow Job?'))
    act(() => confirmState.value!.resolve(true))
    await waitFor(() => expect(transport.calls.find((c) => c.name === 'runs.stop')?.args).toEqual({ id: 'RUN-20261109-005' }))
  })

  it('cleans up: delete older than N days and the retention policy', async () => {
    transport.on('runs.query', () => page([runRow('RUN-20261109-001')]))
    transport.on('runs.deleteOlder', () => ({ runs: 4, sequences: 1 }))
    transport.on('runs.applyRetention', () => ({ runs_removed: 2, logs_removed: 5, sequences_removed: 0 }))
    await ready()
    const days = (await screen.findByLabelText('Delete executions older than (days)')) as HTMLInputElement
    await waitFor(() => expect(days.value).toBe('90')) // the retention setting is the default
    fireEvent.input(days, { target: { value: '30' } })
    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(confirmState.value?.message).toBe('Delete all finished executions older than 30 days?'))
    act(() => confirmState.value!.resolve(true))
    await waitFor(() => expect(transport.calls.find((c) => c.name === 'runs.deleteOlder')?.args).toEqual({ days: 30 }))
    await waitFor(() => expect(toasts.value.some((t) => /Deleted 4 runs and 1 sequence run\./.test(t.text))).toBe(true))
    fireEvent.click(screen.getByText('Apply retention policy now'))
    await waitFor(() => expect(transport.count('runs.applyRetention')).toBe(1))
    expect(screen.getByText(/Runs are kept 90 days, their logs 30 days/)).toBeTruthy()
  })

  it('exports every page of the filtered history as CSV', async () => {
    transport.on('runs.query', ({ page: p }: any) => page(p === 1 ? [runRow('RUN-20261109-002', { script_name: 'Has, comma "q"' })] : [seqRow('SEQ-20261109-001')], { page: p, pages: 2, total: 2 }))
    const blobs: Blob[] = []
    const create = vi.fn((b: Blob) => { blobs.push(b); return 'blob:x' })
    ;(URL as any).createObjectURL = create
    ;(URL as any).revokeObjectURL = () => {}
    await ready('Has, comma "q"')
    fireEvent.click(screen.getByText('Export CSV'))
    await waitFor(() => expect(create).toHaveBeenCalled())
    const text = await readBlob(blobs[0])
    expect(text.split('\r\n')[0]).toBe('id,kind,name,host,status,exit_code,started,duration,initiator,sequence_run,step')
    expect(text).toContain('RUN-20261109-002,script,"Has, comma ""q""",local,success,0,')
    expect(text).toContain('SEQ-20261109-001,sequence,Nightly,2/3 steps,failed,')
    expect(transport.calls.filter((c) => c.name === 'runs.query').map((c) => c.args.page)).toEqual(expect.arrayContaining([1, 2]))
  })

  it('downloads a run log by reading it in chunks', async () => {
    transport.on('runs.query', () => page([runRow('RUN-20261109-001')]))
    const parts: any[] = [{ stdout: 'hello ', stdout_next: 6 }, { stdout: 'world', stdout_next: 11 }, { stdout: '', stdout_next: 11 }]
    transport.on('runs.status', () => parts.shift())
    const blobs: Blob[] = []
    ;(URL as any).createObjectURL = (b: Blob) => { blobs.push(b); return 'blob:y' }
    ;(URL as any).revokeObjectURL = () => {}
    await ready()
    fireEvent.click(screen.getByTitle('Download stdout'))
    await waitFor(() => expect(blobs.length).toBe(1))
    expect(await readBlob(blobs[0])).toBe('hello world')
    expect(transport.calls.filter((c) => c.name === 'runs.status').map((c) => c.args)).toEqual([{ id: 'RUN-20261109-001', out: 0, err: 0 }, { id: 'RUN-20261109-001', out: 6, err: 0 }, { id: 'RUN-20261109-001', out: 11, err: 0 }])
  })

  it('has empty states with an action, and hides log buttons for runs whose logs are gone', async () => {
    transport.on('runs.query', () => page([]))
    mount()
    expect(await screen.findByText('No runs yet.')).toBeTruthy()
    expect(screen.getByText('Script Library')).toBeTruthy()
    document.body.innerHTML = ''
    transport.on('runs.query', () => page([], { filtered: true }))
    mount()
    expect(await screen.findByText('No runs match these filters.')).toBeTruthy()
    document.body.innerHTML = ''
    transport.on('runs.query', () => page([runRow('RUN-20261109-001', { logs_deleted: true })]))
    await ready()
    expect(screen.queryByTitle('Download stdout')).toBeNull()
  })

  it('shows the reveal button only in the desktop app', async () => {
    transport.on('runs.query', () => page([runRow('RUN-20261109-001')]))
    await ready()
    expect(screen.queryByLabelText("Show the run's folder")).toBeNull()
    document.body.innerHTML = ''
    hostInfo.value = { desktop: true, nativeMenu: true, platform: 'win32' }
    transport.on('app.reveal', () => ({ ok: true }))
    await ready()
    fireEvent.click(screen.getByLabelText("Show the run's folder"))
    await waitFor(() => expect(transport.calls.find((c) => c.name === 'app.reveal')?.args).toEqual({ kind: 'run', id: 'RUN-20261109-001' }))
  })
})

describe('History helpers', () => {
  it('formats durations like the engine and parses them back', () => {
    expect(formatDuration(4)).toBe('4s')
    expect(formatDuration(125)).toBe('2m 05s')
    expect(formatDuration(3723)).toBe('1h 02m 03s')
    expect(formatDuration(null)).toBe('—')
    expect(durationSeconds('1h 02m 03s')).toBe(3723)
    expect(durationSeconds('2m 05s')).toBe(125)
    expect(durationSeconds('4s')).toBe(4)
    expect(durationSeconds('—')).toBe(-1)
  })

  it('writes relative times that move on', () => {
    const t = new Date('2026-11-09T12:00:00').getTime()
    expect(relTime('2026-11-09T11:59:40', t)).toBe('just now')
    expect(relTime('2026-11-09T11:55:00', t)).toBe('5 min ago')
    expect(relTime('2026-11-09T09:00:00', t)).toBe('3 h ago')
    expect(relTime('2026-11-07T12:00:00', t)).toBe('2 d ago')
    expect(relTime('2026-08-01T12:00:00', t)).toBe('2026-08-01')
    expect(relTime(null, t)).toBe('')
  })

  it('builds CSV with quoting and reports when downloads are unavailable', () => {
    expect(historyCsv([runRow('RUN-1', { script_name: 'a"b' })]).split('\r\n')[1]).toMatch(/^RUN-1,script,"a""b",local,success,0,/)
    const keep = (URL as any).createObjectURL
    ;(URL as any).createObjectURL = undefined
    expect(downloadText('x.csv', 'a')).toBe(false)
    ;(URL as any).createObjectURL = keep
  })
})
