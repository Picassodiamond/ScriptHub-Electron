/** Cross-panel integration: close guards, the three-way dialog, run on sequences, the sequences side panel, pushed run counts, History params, saveFile. */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/preact'
import { demoShell } from '@scripthub/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../src/panels'
import { startApp } from '../src/bootstrap'
import {
  activeKey, ask, closeAll, closeOthers, closeTab, confirm, confirmState, counts, forceCloseTab, getPanel, hostInfo, openTab,
  registerBuiltinCommands, registerCloseGuard, runCommand, saveFile, shell, tabs, toasts, useCloseGuard, useCommand,
} from '../src/core'
import { App } from '../src/shell/App'
import { ConfirmDialog } from '../src/shell/Overlays'
import { SequencesSide } from '../src/shell/SequencesSide'
import { transport } from './setup'

const keys = () => tabs.value.map((t) => t.key)
const open3 = () => ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc'].forEach((id) => openTab({ kind: 'script', id, title: id }))

let stop: (() => void) | null = null
const offs: Array<() => void> = []
/** registerCloseGuard, undone after the test (the registry lives for the whole file). */
const guard = (key: string, fn: () => boolean | PromiseLike<boolean>) => {
  const off = registerCloseGuard(key, fn)
  offs.push(off)
  return off
}
afterEach(() => { stop?.(); stop = null; offs.splice(0).forEach((f) => f()) })
async function mountApp() {
  const view = render(<App />)
  stop = await startApp()
  await waitFor(() => expect(screen.getAllByText('Hello World').length).toBeGreaterThan(0))
  return view
}

describe('close guards', () => {
  it('a guard that says no keeps the tab, and an answer that comes at once closes it at once', async () => {
    open3()
    const off = guard('script:bbbbbbbbbbbb', () => false)
    expect(await closeTab('script:bbbbbbbbbbbb')).toBe(false)
    expect(keys()).toContain('script:bbbbbbbbbbbb')
    off()
    const ok = guard('script:bbbbbbbbbbbb', () => true)
    closeTab('script:bbbbbbbbbbbb') // no await: a clean page closes synchronously
    expect(keys()).not.toContain('script:bbbbbbbbbbbb')
    ok()
  })

  it('waits for a guard that asks, asks once for a repeated close, and a failing guard keeps the tab', async () => {
    open3()
    let answer!: (v: boolean) => void
    const ask1 = vi.fn(() => new Promise<boolean>((r) => { answer = r }))
    guard('script:aaaaaaaaaaaa', ask1)
    const first = closeTab('script:aaaaaaaaaaaa')
    const second = closeTab('script:aaaaaaaaaaaa') // a second Ctrl+W while the question is open
    expect(ask1).toHaveBeenCalledTimes(1)
    expect(keys()).toContain('script:aaaaaaaaaaaa')
    answer(true)
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(keys()).not.toContain('script:aaaaaaaaaaaa')

    guard('script:cccccccccccc', () => { throw new Error('boom') })
    expect(await closeTab('script:cccccccccccc')).toBe(false)
    expect(keys()).toContain('script:cccccccccccc')
  })

  it('Close others and Close all keep the tabs whose guard refuses', async () => {
    open3()
    guard('script:bbbbbbbbbbbb', () => false)
    await closeOthers('script:aaaaaaaaaaaa')
    expect(keys()).toEqual(['script:aaaaaaaaaaaa', 'script:bbbbbbbbbbbb'])
    expect(activeKey.value).toBe('script:aaaaaaaaaaaa')
    await closeAll()
    expect(keys()).toEqual(['script:bbbbbbbbbbbb'])
    expect(activeKey.value).toBe('script:bbbbbbbbbbbb')
  })

  it('forceCloseTab skips the guard (a page moving to a new id)', () => {
    open3()
    guard('script:aaaaaaaaaaaa', () => false)
    forceCloseTab('script:aaaaaaaaaaaa')
    expect(keys()).not.toContain('script:aaaaaaaaaaaa')
  })

  it('useCloseGuard registers while the page is mounted and reads its latest state', async () => {
    openTab({ kind: 'script', id: 'aaaaaaaaaaaa', title: 'A' })
    let dirty = true
    function Page() {
      useCloseGuard('script:aaaaaaaaaaaa', () => !dirty)
      return <p>page</p>
    }
    const view = render(<Page />)
    expect(await closeTab('script:aaaaaaaaaaaa')).toBe(false)
    dirty = false
    expect(await closeTab('script:aaaaaaaaaaaa')).toBe(true)
    openTab({ kind: 'script', id: 'aaaaaaaaaaaa', title: 'A' })
    dirty = true
    act(() => { view.unmount() }) // the guard goes with the page
    expect(await closeTab('script:aaaaaaaaaaaa')).toBe(true)
  })

  it('× , middle-click, Ctrl+W and the context menu in the tab strip all honour the guard', async () => {
    await mountApp()
    fireEvent.click(screen.getAllByText('Hello World').find((e) => e.closest('#tree'))!)
    const key = 'script:aaaaaaaaaaaa'
    const off = guard(key, () => false)
    fireEvent.click(screen.getByLabelText('Close Hello World'))
    fireEvent(screen.getByRole('tab', { name: /Hello World/ }), new MouseEvent('auxclick', { button: 1, bubbles: true }))
    fireEvent.keyDown(document.body, { key: 'w', ctrlKey: true })
    fireEvent.contextMenu(screen.getByRole('tab', { name: /Hello World/ }))
    fireEvent.click(screen.getByText('Close all'))
    await new Promise((r) => setTimeout(r, 20))
    expect(keys()).toContain(key)
    off()
    fireEvent.click(screen.getByLabelText('Close Hello World'))
    await waitFor(() => expect(keys()).not.toContain(key))
  })
})

describe('the three-way dialog', () => {
  it('answers ok / alt / cancel, with Enter and Escape; confirm() stays a boolean', async () => {
    render(<ConfirmDialog />)
    let p = ask({ title: 'Unsaved', message: 'Save?', confirmLabel: 'Save', altLabel: "Don't save" })
    await screen.findByText('Save?')
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Cancel', "Don't save", 'Save'])
    fireEvent.click(screen.getByText("Don't save"))
    expect(await p).toBe('alt')
    p = ask({ message: 'again', altLabel: 'Alt' })
    await screen.findByText('again')
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(await p).toBe('ok')
    p = ask({ message: 'third' })
    await screen.findByText('third')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(await p).toBe('cancel')
    const c = confirm({ message: 'plain' })
    await screen.findByText('plain')
    expect(screen.queryByText("Don't save")).toBeNull() // no third button unless asked for
    act(() => confirmState.value!.resolve(true))
    expect(await c).toBe(true)
  })
})

describe('run on sequence pages', () => {
  it('`run.run` (Ctrl+Enter, r, Run menu) reaches a sequence page and says so elsewhere', async () => {
    registerBuiltinCommands()
    const cb = vi.fn()
    function Page() {
      useCommand('run.run', cb, true)
      return null
    }
    render(<Page />)
    openTab({ kind: 'sequence', id: 'nightly', title: 'Nightly' })
    await runCommand('run.run')
    expect(cb).toHaveBeenCalledTimes(1)
    openTab({ kind: 'history' })
    await runCommand('run.run')
    expect(cb).toHaveBeenCalledTimes(1)
    expect(toasts.value.map((t) => t.text)).toContain('Open a script or a sequence first.')
  })
})

describe('runs.changed', () => {
  it('updates the running / queued counts at once, without waiting for a poll', async () => {
    await mountApp()
    expect(screen.getByText(/0 running · 0 queued/)).toBeTruthy()
    act(() => transport.emit('runs.changed', { counts: { running: 2, queued: 1 }, started: ['RUN-1'], finished: [], sequences: { started: [], finished: [] } }))
    expect(counts.value).toEqual({ running: 2, queued: 1 })
    await screen.findByText(/2 running · 1 queued/)
  })

  it('the Runs side panel reloads its list when a run starts or finishes', async () => {
    let n = 0
    transport.on('runs.running', () => ({ active: n ? [{ id: 'RUN-1', script_id: 'a', script_name: 'Hello World', status: 'running', ago: '' }] : [], activeSeqs: [], activeTotal: n }))
    await mountApp()
    act(() => { void import('../src/core').then((c) => c.showSideView('runs')) })
    await waitFor(() => expect(screen.getByText('Nothing has run yet.')).toBeTruthy())
    n = 1
    act(() => transport.emit('runs.changed', { counts: { running: 1, queued: 0 }, started: ['RUN-1'], finished: [], sequences: { started: [], finished: [] } }))
    await waitFor(() => expect(screen.getAllByText('Hello World').some((e) => e.closest('.tree-item'))).toBe(true))
  })
})

describe('sequences side panel', () => {
  const seqs = (over: Array<Record<string, any>> = []) => [
    { slug: 'nightly', name: 'Nightly', steps: 3, saved_at: '', saved_display: '2026-11-09 21:10', error: '', favorite: false },
    { slug: 'weekly', name: 'Weekly', steps: 1, saved_at: '', saved_display: '', error: '', favorite: true },
    ...over,
  ]
  const setup = (list = seqs()) => {
    shell.value = demoShell({ sequenceList: list as any })
    return render(<SequencesSide />)
  }
  const names = () => [...document.querySelectorAll('.seq-item .ti-name')].map((e) => e.textContent)

  it('lists favourites first, opens a sequence as a tab, and shows the explorer below for dragging scripts', () => {
    setup()
    expect(names()).toEqual(['Weekly', 'Nightly'])
    expect(screen.getByLabelText('Resize the sequences and scripts sections')).toBeTruthy()
    expect(document.querySelector('.side-pane-scripts [draggable="true"]')).toBeTruthy()
    fireEvent.click(screen.getByText('Nightly'))
    expect(activeKey.value).toBe('sequence:nightly')
  })

  it('creates a sequence inline and opens it', async () => {
    transport.on('sequences.create', ({ name }: any) => ({ ok: true, slug: name.toLowerCase() }))
    setup()
    fireEvent.click(screen.getByLabelText('New sequence'))
    const input = screen.getByLabelText('Name of the new sequence')
    fireEvent.input(input, { target: { value: 'Fresh' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(activeKey.value).toBe('sequence:fresh'))
    expect(transport.calls.find((c) => c.name === 'sequences.create')?.args).toEqual({ name: 'Fresh' })
  })

  it('shows the engine\'s message when the name is taken', async () => {
    transport.on('sequences.create', () => ({ ok: false, error: "A sequence named 'Nightly' already exists." }))
    setup()
    fireEvent.click(screen.getByLabelText('New sequence'))
    const input = screen.getByLabelText('Name of the new sequence')
    fireEvent.input(input, { target: { value: 'Nightly' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(toasts.value.map((t) => t.text)).toContain("A sequence named 'Nightly' already exists."))
  })

  it('renames inline (Enter), cancels with Escape', async () => {
    transport.on('sequences.rename', () => ({ ok: true }))
    setup()
    fireEvent.click(screen.getByLabelText('Rename Nightly'))
    let input = screen.getByLabelText('New name of Nightly') as HTMLInputElement
    expect(input.value).toBe('Nightly')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByLabelText('New name of Nightly')).toBeNull()
    fireEvent.click(screen.getByLabelText('Rename Nightly'))
    input = screen.getByLabelText('New name of Nightly') as HTMLInputElement
    fireEvent.input(input, { target: { value: 'Nightly checks' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(transport.calls.find((c) => c.name === 'sequences.rename')?.args).toEqual({ slug: 'nightly', name: 'Nightly checks' }))
  })

  it('stars, and deletes after a confirmation (closing its open tab)', async () => {
    transport.on('sequences.favorite', () => ({ ok: true }))
    transport.on('sequences.delete', () => ({ deleted: true }))
    setup()
    openTab({ kind: 'sequence', id: 'nightly', title: 'Nightly' })
    fireEvent.click(screen.getByLabelText('Add Nightly to favourites'))
    await waitFor(() => expect(transport.calls.find((c) => c.name === 'sequences.favorite')?.args).toEqual({ slug: 'nightly', on: true }))
    fireEvent.click(screen.getByLabelText('Delete Nightly'))
    await waitFor(() => expect(confirmState.value?.message).toContain('Its past runs stay in History'))
    act(() => confirmState.value!.resolve(true))
    await waitFor(() => expect(transport.calls.some((c) => c.name === 'sequences.delete')).toBe(true))
    await waitFor(() => expect(keys()).not.toContain('sequence:nightly'))
  })

  it('folds the list (remembered), filters only a long list, and marks an unreadable file', () => {
    setup(seqs([{ slug: 'broken', name: 'broken', steps: 0, saved_at: '', saved_display: '', error: 'bad yaml', favorite: false }]))
    expect(screen.queryByLabelText('Filter sequences')).toBeNull() // short list: no filter, like the Django panel
    expect(document.querySelector('.seq-item.has-error')?.textContent).toContain('cannot be read')
    fireEvent.click(screen.getByTitle('Show or hide the sequences'))
    expect(document.querySelector('.side-pane-seq')?.classList.contains('is-folded')).toBe(true)
    expect(localStorage.getItem('sr.seqFold')).toBe('1')
    fireEvent.click(screen.getByTitle('Show or hide the sequences'))
    expect(localStorage.getItem('sr.seqFold')).toBe('0')
  })

  it('filters a long list', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ slug: `s${i}`, name: `Seq ${i}`, steps: 1, saved_at: '', saved_display: '', error: '', favorite: false }))
    setup(many)
    fireEvent.input(screen.getByLabelText('Filter sequences'), { target: { value: 'seq 3' } })
    expect(names()).toEqual(['Seq 3'])
    fireEvent.input(screen.getByLabelText('Filter sequences'), { target: { value: 'zzz' } })
    expect(screen.getByText('No match.')).toBeTruthy()
  })
})

describe('History opened with a filter', () => {
  const page = (over: Record<string, any> = {}) => ({
    runs: [], f: { q: '', kind: '', script: '', status: '', date_from: '', date_to: '' }, scripts: [], sequenceChoices: [], statuses: [],
    total: 0, page: 1, pages: 1, first: 0, last: 0, filtered: false, historyDays: 90, logDays: 30, running: { active: [], activeSeqs: [], activeTotal: 0 }, ...over,
  })
  const queries = () => transport.calls.filter((c) => c.name === 'runs.query').map((c) => c.args as any)

  it('kind / script params become the filter, replacing a remembered one, and a new nonce applies again', async () => {
    localStorage.setItem('scripthub.history.filters', JSON.stringify({ q: 'old', status: 'failed', kind: 'scripts', script: '', dateFrom: '', dateTo: '' }))
    transport.on('runs.query', () => page())
    const Panel = getPanel('history')!.component
    const tab = { key: 'history:', kind: 'history' as const, title: 'Runs', icon: 'list', params: { kind: 'sequences', script: 'seq:nightly' } }
    const view = render(<Panel tab={tab} active />)
    await waitFor(() => expect(queries().some((q) => q.kind === 'sequences' && q.script === 'seq:nightly' && q.q === '' && q.status === '')).toBe(true))
    view.rerender(<Panel tab={{ ...tab, params: { kind: 'scripts', script: 'aaaaaaaaaaaa', nonce: 2 } }} active />)
    await waitFor(() => expect(queries().some((q) => q.kind === 'scripts' && q.script === 'aaaaaaaaaaaa')).toBe(true))
  })

  it('without params it keeps the remembered filters', async () => {
    localStorage.setItem('scripthub.history.filters', JSON.stringify({ q: '', status: 'failed', kind: '', script: '', dateFrom: '', dateTo: '' }))
    transport.on('runs.query', () => page())
    const Panel = getPanel('history')!.component
    render(<Panel tab={{ key: 'history:', kind: 'history', title: 'Runs', icon: 'list', params: {} }} active />)
    await waitFor(() => expect(queries().length).toBeGreaterThan(0))
    expect(queries()[0].status).toBe('failed')
  })
})

describe('saveFile', () => {
  const stubDownload = () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    ;(URL as any).createObjectURL = vi.fn(() => 'blob:x')
    ;(URL as any).revokeObjectURL = vi.fn()
    return click
  }

  it('desktop: the host writes the file and says where; cancelling is not an error', async () => {
    hostInfo.value = { desktop: true, nativeMenu: true, platform: 'win32' }
    transport.on('host.saveFile' as any, ({ suggestedName, text }: any) => (text === 'cancel me' ? null : { path: `C:\\out\\${suggestedName}` }))
    expect(await saveFile('run.log', 'hello')).toEqual({ ok: true, path: 'C:\\out\\run.log' })
    expect(toasts.value.map((t) => t.text)).toContain('Saved C:\\out\\run.log')
    expect(await saveFile('x.log', 'cancel me')).toEqual({ ok: true, cancelled: true })
  })

  it('desktop with an older host (no saveFile) and the browser fall back to a download', async () => {
    const click = stubDownload()
    hostInfo.value = { desktop: true, nativeMenu: true, platform: 'win32' }
    expect((await saveFile('a.txt', 'x')).ok).toBe(true) // no mock for host.saveFile: "unavailable"
    hostInfo.value = null
    expect((await saveFile('b.txt', 'x')).ok).toBe(true)
    expect(click).toHaveBeenCalledTimes(2)
    click.mockRestore()
  })

  it('reports a real host failure instead of silently downloading', async () => {
    const click = stubDownload()
    hostInfo.value = { desktop: true, nativeMenu: true, platform: 'win32' }
    transport.on('host.saveFile' as any, () => { throw Object.assign(new Error('disk full'), { code: 'internal' }) })
    expect(await saveFile('a.txt', 'x')).toEqual({ ok: false })
    expect(toasts.value.map((t) => t.text)).toContain('disk full')
    expect(click).not.toHaveBeenCalled()
    click.mockRestore()
  })
})

// keep the import list honest: `within` is used by neighbours of this file's helpers
void within
