/** The run console panel (packages/ui/src/panels/run): output streaming and replay, ANSI, search, stop, trace and debug. */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { confirmState } from '../src/core/confirm'
import { activeTab, openTab, tabs } from '../src/core/tabs'
import { editorFactory, type Disposable, type EditorAdapter, type LineDecoration } from '../src/editor'
import { RunConsole } from '../src/panels/run'
import { parseLine, stripAnsi } from '../src/panels/run/ansi'
import { MAX_LINES, OutputBuffer } from '../src/panels/run/outputBuffer'
import { transport } from './setup'

const ID = 'RUN-20261109-001'
const tab = { key: `run:${ID}`, kind: 'run' as const, id: ID, title: 'Hello', icon: 'terminal', params: { scriptId: 'aaaaaaaaaaaa' } }

const runRecord = (over: Record<string, any> = {}) => ({
  id: ID, status: 'running', script_id: 'aaaaaaaaaaaa', script_name: 'Hello World', script_path: 'C:\\s\\hello.py', host: 'local',
  initiator: '127.0.0.1', command: 'python hello.py --who me', ...over,
})
const consoleOf = (over: Record<string, any> = {}, run: Record<string, any> = {}) => ({
  run: runRecord(run), statusLabel: 'Running', active: true, paramRows: [['who', 'me']] as Array<[string, string]>,
  trace: null, debug: false, traceLines: null, traceLang: '', ...over,
})
const statusOf = (over: Record<string, any> = {}) => ({
  status: 'running', status_label: 'Running', active: true, exit_code: null, started_at: '2026-11-09T10:00:00', finished_at: null,
  queued_at: '2026-11-09T10:00:00', duration: '2s', duration_seconds: 2, queue_position: null, error: null, pid: 4242,
  stdout: '', stdout_next: 0, stderr: '', stderr_next: 0, trace: null, debug: null, ...over,
})
const events = (over: Record<string, any> = {}) => {
  const { stdout, stdout_next, stderr, stderr_next, debug, ...rest } = statusOf(over)
  void stdout; void stdout_next; void stderr; void stderr_next; void debug
  return { id: ID, ...rest }
}

/** Serve a run: `chunks` = what runs.status returns for the given offsets. */
function serve(opts: { console?: any; status?: (a: { out: number; err: number }) => any } = {}) {
  transport.on('runs.console', () => opts.console ?? consoleOf())
  transport.on('runs.status', (a: any) => (opts.status ? opts.status(a) : statusOf()))
  transport.on('runs.watch', () => ({ ok: true }))
  transport.on('runs.unwatch', () => ({ ok: true }))
}

const mount = (active = true) => render(<RunConsole tab={tab} active={active} />)
const text = (sel: string) => document.querySelector(sel)?.textContent ?? ''
const rows = (pane = 0) => [...document.querySelectorAll('.pane')[pane].querySelectorAll('.vrow .vtext')].map((e) => e.textContent)
const calls = (name: string) => transport.calls.filter((c) => c.name === name)

describe('ANSI and the output buffer', () => {
  it('turns SGR codes into styled spans, carries the state across lines and drops other escapes', () => {
    const a = parseLine('\x1b[1;31mfail\x1b[0m ok \x1b[38;5;82mgreen\x1b[39m \x1b[2Kx\x1b]0;title\x07y')
    expect(a.spans.map((s) => s.text)).toEqual(['fail', ' ok ', 'green', ' ', 'x', 'y'])
    expect(a.spans[0].state).toEqual({ fg: 1, bold: true })
    expect(a.spans[2].state.fg).toBe('#5fff00')
    const b = new OutputBuffer()
    b.append('\x1b[33mwarn\nstill yellow\x1b[0m\nplain\n')
    expect(parseLine(b.lines[1], b.starts[1]).spans[0].state.fg).toBe(3)
    expect(b.starts[2]).toEqual({})
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
  })

  it('assembles lines from chunks cut anywhere, handles \\r\\n and carriage-return progress bars', () => {
    const b = new OutputBuffer()
    b.append('one\ntw')
    b.append('o\r')
    b.append('\nthree\n10%\r50%\r100%\nlast')
    expect(b.count).toBe(5)
    expect(b.text()).toBe('one\ntwo\nthree\n100%\nlast\n')
    expect(b.search('THR')).toEqual([2])
    expect(b.firstErrorLine()).toBe(0) // no error-looking line: the first line
    b.append(' Error: boom\n')
    expect(b.firstErrorLine()).toBe(4)
  })

  it('keeps memory bounded and says how much was dropped', () => {
    const b = new OutputBuffer()
    b.append('x\n'.repeat(MAX_LINES + 5))
    expect(b.dropped).toBeGreaterThan(0)
    expect(b.lines.length).toBeLessThanOrEqual(MAX_LINES + 1)
  })
})

describe('Run console: live output', () => {
  it('shows the status, then appends pushed output and the final status without polling', async () => {
    serve({ status: () => statusOf({ stdout: 'hello\n', stdout_next: 6 }) })
    mount()
    await waitFor(() => expect(rows()).toEqual(['hello']))
    expect(calls('runs.watch')[0].args).toEqual({ id: ID, out: 6, err: 0 }) // resumes where the replay ended
    expect(text('[data-testid="status-chip"]')).toBe('Running')
    expect(text('[data-testid="live"]')).toContain('Live')
    expect(document.querySelector('#stop-btn')).toBeTruthy()
    expect(document.body.textContent).toContain('python hello.py --who me')

    transport.emit('run.output', { id: ID, stdout: 'world\n', stdout_next: 12, stderr: 'oops\n', stderr_next: 5 })
    transport.emit('run.output', { id: 'RUN-other', stdout: 'nope\n', stdout_next: 99, stderr: '', stderr_next: 0 }) // another run
    await waitFor(() => expect(rows()).toEqual(['hello', 'world']))
    expect(rows(1)).toEqual(['oops'])

    transport.emit('run.status', events({ status: 'success', status_label: 'Success', active: false, exit_code: 0, duration: '3s', duration_seconds: 3 }))
    await waitFor(() => expect(text('[data-testid="status-chip"]')).toBe('Success'))
    expect(text('[data-testid="exit-code"]')).toBe('0')
    expect(text('[data-testid="run-foot"]')).toContain('Finished successfully')
    expect(text('[data-testid="run-foot"]')).toContain('exit code 0')
    expect(document.querySelector('#stop-btn')).toBeNull()
    await waitFor(() => expect(calls('runs.unwatch').length).toBe(1))
  })

  it('replays a finished run in chunks by offset and does not watch it', async () => {
    const chunks: Record<number, [string, number]> = { 0: ['a\nb\n', 4], 4: ['c\n', 6], 6: ['', 6] }
    serve({
      console: consoleOf({ active: false }, { status: 'success' }),
      status: ({ out }) => { const [stdout, next] = chunks[out] ?? ['', out]; return statusOf({ status: 'success', status_label: 'Success', active: false, exit_code: 0, stdout, stdout_next: next }) },
    })
    mount()
    await waitFor(() => expect(rows()).toEqual(['a', 'b', 'c']))
    expect(calls('runs.status').map((c) => c.args.out)).toEqual([0, 4, 6])
    expect(calls('runs.watch')).toHaveLength(0)
    expect(text('[data-testid="live"]')).toContain('Finished')
    expect(document.querySelector('#stop-btn')).toBeNull()
  })

  it('renders ANSI colours, and timestamps on request', async () => {
    serve({ status: () => statusOf({ stdout: '\x1b[31mred\x1b[0m plain\n', stdout_next: 20 }) })
    mount()
    await waitFor(() => expect(document.querySelector('.ansi-fg-1')?.textContent).toBe('red'))
    expect(rows()).toEqual(['red plain']) // the escape codes are not shown
    expect(document.querySelector('.vts')).toBeNull()
    fireEvent.click(screen.getByLabelText('Time'))
    expect(document.querySelector('.vts')).toBeTruthy()
  })

  it('shows the queue position, an error banner, and the exit code of a failed run', async () => {
    serve({ status: () => statusOf({ status: 'queued', status_label: 'Queued', queue_position: 2 }) })
    mount()
    await waitFor(() => expect(text('[data-testid="queue-note"]')).toContain('position 2'))
    transport.emit('run.status', events({ status: 'failed', status_label: 'Failed', active: false, exit_code: 3, error: 'The script exited with code 3.' }))
    await waitFor(() => expect(text('[data-testid="error-note"]')).toContain('exited with code 3'))
    expect(text('[data-testid="exit-code"]')).toBe('3')
    expect(text('[data-testid="run-foot"]')).toContain('Failed')
    expect(document.querySelector('[data-testid="queue-note"]')).toBeNull()
  })

  it('reports a run that does not exist', async () => {
    transport.on('runs.console', () => { throw new Error('Unknown execution') })
    mount()
    await waitFor(() => expect(document.body.textContent).toContain('Unknown execution'))
  })

  it('stays virtualised for a huge log', async () => {
    serve({ status: () => statusOf({ stdout: Array.from({ length: 60_000 }, (_, i) => `line ${i}`).join('\n') + '\n', stdout_next: 1 }) })
    mount()
    await waitFor(() => expect(text('[data-testid="run-foot"]')).toContain('60,000 lines'))
    expect(document.querySelectorAll('.vrow').length).toBeLessThan(200)
  })
})

describe('Run console: search and actions', () => {
  const lines = 'alpha\nbeta\ngamma\nbeta again\n'
  it('counts matches, steps through them and can show only matching lines', async () => {
    serve({ status: () => statusOf({ stdout: lines, stdout_next: 30 }) })
    mount()
    await waitFor(() => expect(rows()).toHaveLength(4))
    const box = screen.getByLabelText('Find in output')
    fireEvent.input(box, { target: { value: 'beta' } })
    await waitFor(() => expect(text('[data-testid="match-count"]')).toBe('1/2'))
    expect(document.querySelectorAll('mark.hit')).toHaveLength(2)
    expect(document.querySelectorAll('mark.hit-cur')).toHaveLength(1)
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(text('[data-testid="match-count"]')).toBe('2/2'))
    fireEvent.click(screen.getByLabelText('Only matching lines'))
    await waitFor(() => expect(rows()).toEqual(['beta', 'beta again']))
    fireEvent.keyDown(box, { key: 'Escape' })
    await waitFor(() => expect(rows()).toHaveLength(4))
    expect((box as HTMLInputElement).value).toBe('')
  })

  it('jumps to the first error line of stderr and switches to stacked output if it was hidden', async () => {
    serve({ status: () => statusOf({ stdout: 'ok\n', stdout_next: 3, stderr: 'warn\nTraceback (most recent call last)\n', stderr_next: 40 }) })
    mount()
    await waitFor(() => expect(rows(1)).toHaveLength(2))
    fireEvent.click(screen.getByTitle('Standard output only'))
    expect(document.querySelector('.pane-err')).toBeNull() // stderr hidden
    fireEvent.click(screen.getByText('First error'))
    await waitFor(() => expect(document.querySelector('.panes.layout-stack')).toBeTruthy())
    expect(rows(1)).toEqual(['warn', 'Traceback (most recent call last)'])
  })

  it('stops the run only after confirming', async () => {
    serve()
    transport.on('runs.stop', () => ({ stopped: true, active: true }))
    mount()
    await waitFor(() => expect(document.querySelector('#stop-btn')).toBeTruthy())
    fireEvent.click(document.querySelector('#stop-btn')!)
    await waitFor(() => expect(confirmState.value?.message).toBe('Stop this execution?'))
    confirmState.value!.resolve(false)
    await new Promise((r) => setTimeout(r, 20))
    expect(calls('runs.stop')).toHaveLength(0)
    fireEvent.click(document.querySelector('#stop-btn')!)
    await waitFor(() => expect(confirmState.value).toBeTruthy())
    confirmState.value!.resolve(true)
    await waitFor(() => expect(calls('runs.stop')[0].args).toEqual({ id: ID }))
  })

  it('opens the script, and "Run again" opens its run form with the values of this run', async () => {
    serve()
    transport.on('runs.form', () => ({ recent: [{ run_id: 'RUN-20261109-009', key: '@0' }, { run_id: ID, key: '@1' }] }))
    mount()
    await waitFor(() => expect(screen.getByText('Hello World')).toBeTruthy())
    fireEvent.click(screen.getByText('Hello World'))
    expect(activeTab.value).toMatchObject({ kind: 'script', id: 'aaaaaaaaaaaa' })
    fireEvent.click(screen.getByText('Run again'))
    await waitFor(() => expect(activeTab.value?.params).toMatchObject({ view: 'run', preset: '@1' }))
  })

  it('deletes a finished run after confirming and closes its tab', async () => {
    serve({ console: consoleOf({ active: false }, { status: 'success' }), status: () => statusOf({ status: 'success', status_label: 'Success', active: false, exit_code: 0 }) })
    transport.on('runs.delete', () => ({ deleted: true }))
    openTab({ kind: 'run', id: ID, title: 'Hello' })
    mount()
    await waitFor(() => expect(screen.getByTitle('Delete this run and its logs')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Delete this run and its logs'))
    await waitFor(() => expect(confirmState.value?.message).toContain(`Delete ${ID}`))
    confirmState.value!.resolve(true)
    await waitFor(() => expect(tabs.value.some((t) => t.key === tab.key)).toBe(false))
  })

  it('downloads a log through runs.logPath', async () => {
    serve({ status: () => statusOf({ stdout: 'hi\n', stdout_next: 3 }) })
    transport.on('runs.logPath', () => ({ path: 'C:\\r\\stdout.log', name: `${ID}-stdout.log` }))
    URL.createObjectURL = () => 'blob:x'
    mount()
    await waitFor(() => expect(rows()).toEqual(['hi']))
    fireEvent.click(screen.getByTitle('Download stdout'))
    await waitFor(() => expect(calls('runs.logPath')[0].args).toEqual({ id: ID, stream: 'stdout' }))
  })
})

// --------------------------------------------------------------- editor ---
class FakeEditor implements EditorAdapter {
  readonly kind = 'fake'
  decorations: Record<string, LineDecoration[]> = {}
  bps: number[] = []
  value = ''
  revealed: number[] = []
  bpCb: ((l: number[]) => void) | null = null
  cursor = 0
  async mount(_el: HTMLElement, o: { value: string }) { this.value = o.value }
  getValue() { return this.value }
  setValue(v: string) { this.value = v }
  onChange(): Disposable { return { dispose() {} } }
  setLanguage() {}
  setTheme() {}
  setReadOnly() {}
  setMarkers() {}
  setLineDecorations(owner: string, d: LineDecoration[]) { this.decorations[owner] = d }
  setBreakpoints(l: number[]) { this.bps = l }
  getBreakpoints() { return this.bps }
  onBreakpointsChange(cb: (l: number[]) => void): Disposable { this.bpCb = cb; return { dispose() {} } }
  onCursorLine(cb: (l: number) => void): Disposable { this.cursor = 0; this.cursorCb = cb; return { dispose() {} } }
  cursorCb: ((l: number) => void) | null = null
  revealLine(l: number) { this.revealed.push(l) }
  focus() {}
  layout() {}
  dispose() {}
}

const SRC = ['import time', 'x = 1', 'y = x + 1', 'print(y)']

describe('Run console: trace', () => {
  it('highlights the running line live, lists the lines reached and stops tracing', async () => {
    const ed = new FakeEditor()
    editorFactory.create = async () => ed
    serve({
      console: consoleOf({ trace: { stopped: false }, traceLines: SRC, traceLang: 'python' }),
      status: () => statusOf({ trace: { line: 2, stopped: false } }),
    })
    transport.on('runs.stopTrace', () => ({ ok: true }))
    mount()
    await waitFor(() => expect(ed.decorations.current?.[0]?.line).toBe(2))
    expect(ed.value).toBe(SRC.join('\n'))
    expect(text('[data-testid="trace-line"]')).toBe('2')
    expect(text('[data-testid="trace-state"]')).toBe('Tracing…')

    transport.emit('run.status', events({ trace: { line: 3, stopped: false } }))
    await waitFor(() => expect(ed.decorations.current?.[0]?.line).toBe(3))
    expect(ed.decorations.trace.map((d) => d.line)).toEqual([2]) // reached before, lighter tint
    expect([...document.querySelectorAll('.lh-chip')].map((e) => e.textContent)).toEqual(['2', '3'])
    expect(ed.revealed).toContain(3)

    fireEvent.click(screen.getByTestId('trace-stop'))
    await waitFor(() => expect(calls('runs.stopTrace')[0].args).toEqual({ id: ID }))

    transport.emit('run.status', events({ status: 'success', status_label: 'Success', active: false, exit_code: 0, trace: { line: 4, stopped: false } }))
    await waitFor(() => expect(text('[data-testid="trace-state"]')).toBe('Last line reached'))
    expect(screen.queryByTestId('trace-stop')).toBeNull()
  })
})

describe('Run console: debugger', () => {
  const paused = (line: number, extra: Record<string, any> = {}) => ({
    state: 'paused', line, breakpoints: [], stack: [{ fn: '<module>', line }],
    scopes: [{ name: 'Globals', vars: [{ name: 'x', type: 'int', value: '1' }] }], ...extra,
  })
  const setup = () => {
    const ed = new FakeEditor()
    editorFactory.create = async () => ed
    serve({
      console: consoleOf({ trace: { stopped: false }, debug: true, traceLines: SRC, traceLang: 'python' }, { debug: true }),
      status: () => statusOf({ trace: { line: 2, stopped: false }, debug: paused(2) }),
    })
    return ed
  }

  it('enables the controls while paused, sends step / continue / detach and shows variables and the call stack', async () => {
    const ed = setup()
    transport.on('runs.debug', ({ action }: any) => ({ ok: true, debug: action === 'step' ? paused(3, { scopes: [{ name: 'Globals', vars: [{ name: 'x', type: 'int', value: '5' }] }] }) : paused(2) }))
    mount()
    await waitFor(() => expect(text('#dbg-state')).toBe('Paused at line 2'))
    const btn = (a: string) => document.querySelector(`[data-dbg="${a}"]`) as HTMLButtonElement
    expect(btn('step').disabled).toBe(false)
    expect(btn('continue').disabled).toBe(false)
    expect(btn('pause').disabled).toBe(true) // only while running
    expect(text('[data-testid="status-chip"]')).toBe('Paused')
    expect(within(screen.getByTestId('dbg-vars')).getByText('x')).toBeTruthy()
    expect(text('[data-testid="dbg-stack"]')).toContain('<module>:2')
    await waitFor(() => expect(ed.decorations.current?.[0]).toMatchObject({ line: 2, glyph: 'current' })) // the editor mounts asynchronously

    fireEvent.click(btn('step'))
    await waitFor(() => expect(calls('runs.debug').some((c) => c.args.action === 'step')).toBe(true))
    await waitFor(() => expect(text('#dbg-state')).toBe('Paused at line 3'))
    expect(document.querySelector('.vars tr.is-changed')).toBeTruthy() // x changed from 1 to 5
  })

  it('works from the keyboard: F10 steps, F5 continues, and the shell never sees F10', async () => {
    setup()
    transport.on('runs.debug', () => ({ ok: true, debug: paused(2) }))
    mount()
    await waitFor(() => expect(text('#dbg-state')).toBe('Paused at line 2'))
    const f10 = new KeyboardEvent('keydown', { key: 'F10', bubbles: true, cancelable: true })
    window.dispatchEvent(f10)
    expect(f10.defaultPrevented).toBe(true)
    await waitFor(() => expect(calls('runs.debug').map((c) => c.args.action)).toContain('step'))
    await new Promise((r) => setTimeout(r, 60)) // the answer arrived and the buttons are back
    await waitFor(() => expect((document.querySelector('[data-dbg="continue"]') as HTMLButtonElement).disabled).toBe(false))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', bubbles: true, cancelable: true }))
    await waitFor(() => expect(calls('runs.debug').map((c) => c.args.action)).toContain('continue'))
  })

  it('toggles breakpoints from the gutter, sends them to the engine and mirrors the engine list', async () => {
    const ed = setup()
    transport.on('runs.debug', () => ({ ok: true, debug: paused(2) }))
    mount()
    await waitFor(() => expect(ed.bpCb).toBeTruthy())
    ed.bpCb!([3])
    await waitFor(() => expect(calls('runs.debug').find((c) => c.args.action === 'breakpoints')?.args.lines).toEqual([3]))
    await waitFor(() => expect(text('[data-testid="dbg-bps"]')).toContain('y = x + 1'))
    await waitFor(() => expect(ed.bps).toEqual([3]))

    fireEvent.click(screen.getByLabelText('Remove breakpoint 3'))
    await waitFor(() => expect(calls('runs.debug').filter((c) => c.args.action === 'breakpoints').pop()?.args.lines).toEqual([]))
    await waitFor(() => expect(ed.bps).toEqual([]))

    transport.emit('debug.state', { id: ID, debug: paused(2, { breakpoints: [4, 1] }) }) // set elsewhere (the engine's list wins)
    await waitFor(() => expect(ed.bps).toEqual([1, 4]))
  })

  it('F9 toggles a breakpoint on the cursor line', async () => {
    const ed = setup()
    transport.on('runs.debug', () => ({ ok: true, debug: paused(2) }))
    mount()
    await waitFor(() => expect(ed.cursorCb).toBeTruthy())
    ed.cursorCb!(4)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F9', bubbles: true, cancelable: true }))
    await waitFor(() => expect(ed.bps).toEqual([4]))
  })

  it('shows the ended state with every control off once the run finished', async () => {
    setup()
    mount()
    await waitFor(() => expect(text('#dbg-state')).toBe('Paused at line 2'))
    transport.emit('run.status', events({ status: 'success', status_label: 'Success', active: false, exit_code: 0 }))
    transport.emit('debug.state', { id: ID, debug: { state: 'ended', line: 4, scopes: [], stack: [], breakpoints: [] } })
    await waitFor(() => expect(text('#dbg-state')).toBe('Ended'))
    for (const a of ['step', 'continue', 'pause', 'detach', 'stop']) expect((document.querySelector(`[data-dbg="${a}"]`) as HTMLButtonElement).disabled).toBe(true)
    expect(text('[data-testid="status-chip"]')).toBe('Success')
  })
})
