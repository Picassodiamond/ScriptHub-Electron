/** The Settings panel against a mock engine (MockTransport): loading, editing, validation, saving, data, hosts, theme, import/export. */
import { act, fireEvent, render, waitFor, within } from '@testing-library/preact'
import type { MockTransport } from '@scripthub/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// only the panels this test needs: other panels are built concurrently and may be mid-edit
import '../src/panels/home'
import '../src/panels/settings'
import { startApp } from '../src/bootstrap'
import { confirmState } from '../src/core/confirm'
import { openTab, tabs } from '../src/core/tabs'
import { toasts } from '../src/core/toast'
import { App } from '../src/shell/App'
import {
  DRAFT_KEY, defaultsDraft, draftFromJson, draftToJson, exportSettings, fieldOfError, fromForm, importSettings, mapServerErrors, parseLines, toForm, validate,
} from '../src/panels/settings/model'
import { transport } from './setup'

let stop: (() => void) | null = null
afterEach(() => { stop?.(); stop = null })

const FORM = {
  max_concurrent_executions: 3, max_concurrent_per_host: 3, default_timeout: 3600, polling_interval: 2000,
  history_retention_days: 90, log_retention_days: 30, ssh_connect_timeout: 10, enable_script_editing: true,
  ssh_executable: 'ssh', environment: 'TZ=UTC', interpreters: '.py=python\n.bat=cmd', remote_interpreters: '.py=python3\n.sh=bash',
}
const ROWS = [
  { key: 'history', label: 'Run history', help: 'Past runs and their logs', bytes: 2048, files: 4, size: '2.0 KB' },
  { key: 'presets', label: 'Saved values', help: 'Presets and recent runs', bytes: 0, files: 0, size: '0 B' },
  { key: 'sequences', label: 'Sequences', help: 'Sequence files', bytes: 512, files: 1, size: '512 B' },
]

function engine(t: MockTransport, over: Record<string, any> = {}) {
  let form = { ...FORM, ...(over.form ?? {}) }
  t.on('settings.get', () => ({ form, sshHosts: over.hosts ?? ['web-1', 'db-1'], dataRows: over.rows ?? ROWS, dataLocation: { path: 'C:\\data\\ScriptHub', how: 'user' } }) as any)
  t.on('settings.save', (a: any) => {
    if (over.saveErrors) return { ok: false, errors: over.saveErrors } as any
    form = { ...a.form, max_concurrent_executions: Number(a.form.max_concurrent_executions) } as any
    return { ok: true, form } as any
  })
  t.on('settings.testHost', ({ host }: any) => (host === 'db-1' ? { ok: false, message: 'db-1: Connection timed out' } : { ok: true, message: `${host}: connected (Linux)` }) as any)
  t.on('settings.clear', ({ kind }: any) => ({ messages: [`Cleared ${kind}.`], errors: [] }) as any)
  t.on('settings.dataOverview', () => over.rows ?? ROWS)
}

async function mount(over: Record<string, any> = {}, params: Record<string, any> = {}) {
  engine(transport, over)
  render(<App />)
  stop = await startApp()
  openTab({ kind: 'settings', params })
  await waitFor(() => expect(panelEl().querySelector('.settings-page')).toBeTruthy())
  await waitFor(() => expect(panelEl().querySelector('#st-max_concurrent_executions')).toBeTruthy())
}
const panelEl = () => document.querySelector('.tab-panel[data-kind="settings"]') as HTMLElement
const page = () => within(panelEl())
const calls = (name: string) => transport.calls.filter((c) => c.name === name)
const input = (id: string) => panelEl().querySelector(`#${id}`) as HTMLInputElement
const type = (el: HTMLElement, value: string) => fireEvent.input(el, { target: { value } })
const saveBtn = () => page().getByRole('button', { name: /save settings|saving/i }) as HTMLButtonElement
const state = () => panelEl().querySelector('.st-state')!.textContent

beforeEach(() => { tabs.value = [] })

describe('Settings panel: loading and editing', () => {
  it('shows the saved values in every section and starts clean', async () => {
    await mount()
    expect(input('st-max_concurrent_executions').value).toBe('3')
    expect(input('st-default_timeout').value).toBe('3600')
    expect(input('st-history_retention_days').value).toBe('90')
    expect(input('st-ssh').value).toBe('ssh')
    const interp = panelEl().querySelector('[data-list="interpreters"]')!
    expect([...interp.querySelectorAll('input.input')].map((i) => (i as HTMLInputElement).value)).toEqual(['.py', 'python', '.bat', 'cmd'])
    const env = panelEl().querySelector('[data-list="environment"]')!
    expect([...env.querySelectorAll('input.input')].map((i) => (i as HTMLInputElement).value)).toEqual(['TZ', 'UTC'])
    expect(state()).toBe('All changes saved')
    expect(saveBtn().disabled).toBe(true)
    for (const title of ['Features', 'Execution', 'Retention', 'Interpreters', 'SSH & environment', 'SSH hosts', 'Data', 'Appearance', 'About'])
      expect(panelEl().querySelector('.settings-nav')!.textContent).toContain(title)
  })

  it('tracks changes: counter, field marker, nav count, Save and Revert', async () => {
    await mount()
    type(input('st-max_concurrent_executions'), '5')
    expect(state()).toBe('1 unsaved change')
    expect(saveBtn().disabled).toBe(false)
    expect(panelEl().querySelector('[data-field="max_concurrent_executions"]')!.classList.contains('is-changed')).toBe(true)
    expect(panelEl().querySelector('.settings-nav .count-pill')!.textContent).toBe('1')
    fireEvent.click(page().getByRole('button', { name: 'Revert' }))
    expect(input('st-max_concurrent_executions').value).toBe('3')
    expect(state()).toBe('All changes saved')
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
  })

  it('marks the tab title while there are unsaved changes', async () => {
    await mount()
    type(input('st-polling_interval'), '3000')
    await waitFor(() => expect(tabs.value.find((t) => t.kind === 'settings')?.title).toBe('Settings •'))
    fireEvent.click(page().getByRole('button', { name: 'Revert' }))
    await waitFor(() => expect(tabs.value.find((t) => t.kind === 'settings')?.title).toBe('Settings'))
  })

  it('edits the interpreter and environment lists with add and remove', async () => {
    await mount()
    fireEvent.click(page().getByRole('button', { name: 'Add interpreter' }))
    const rows = () => panelEl().querySelectorAll('[data-list="interpreters"] .rl-row')
    expect(rows().length).toBe(3)
    const last = rows()[2].querySelectorAll('input')
    type(last[0] as HTMLElement, '.ps1')
    type(last[1] as HTMLElement, 'powershell')
    fireEvent.click(page().getByRole('button', { name: 'Remove interpreter 2' }))
    expect(rows().length).toBe(2)
    fireEvent.click(page().getByRole('button', { name: 'Add variable' }))
    const env = panelEl().querySelectorAll('[data-list="environment"] .rl-row')
    type(env[1].querySelectorAll('input')[0] as HTMLElement, 'LANG')
    type(env[1].querySelectorAll('input')[1] as HTMLElement, 'C')
    fireEvent.click(saveBtn())
    await waitFor(() => expect(calls('settings.save').length).toBe(1))
    expect(calls('settings.save')[0].args.form).toMatchObject({ interpreters: '.py=python\n.ps1=powershell', environment: 'TZ=UTC\nLANG=C' })
  })
})

describe('Settings panel: validation', () => {
  it('shows a client-side error at the field and does not call the engine', async () => {
    await mount()
    type(input('st-max_concurrent_executions'), '100')
    expect(panelEl().querySelector('[data-field="max_concurrent_executions"] .field-error')!.textContent).toBe('Must be between 1 and 64.')
    fireEvent.click(saveBtn())
    await waitFor(() => expect(toasts.value.some((t) => t.kind === 'error' && /Not saved: 1 setting needs fixing/.test(t.text))).toBe(true))
    expect(calls('settings.save').length).toBe(0)
    type(input('st-max_concurrent_executions'), 'abc')
    expect(panelEl().querySelector('[data-field="max_concurrent_executions"] .field-error')!.textContent).toBe('Must be a whole number.')
  })

  it('validates extensions and environment names per row', async () => {
    await mount()
    fireEvent.click(page().getByRole('button', { name: 'Add interpreter' }))
    const row = panelEl().querySelectorAll('[data-list="interpreters"] .rl-row')[2].querySelectorAll('input')
    type(row[0] as HTMLElement, 'py')
    type(row[1] as HTMLElement, 'python')
    expect(panelEl().querySelector('[data-list="interpreters"] .rl-err')!.textContent).toMatch(/not a file extension/)
    fireEvent.click(page().getByRole('button', { name: 'Add variable' }))
    const env = panelEl().querySelectorAll('[data-list="environment"] .rl-row')[1].querySelectorAll('input')
    type(env[0] as HTMLElement, '1BAD')
    expect(panelEl().querySelector('[data-list="environment"] .rl-err')!.textContent).toMatch(/not a valid variable name/)
  })

  it("shows the engine's errors at the field they belong to, and keeps the edits", async () => {
    await mount({ saveErrors: ['Max concurrent executions per host must be between 1 and 64.', 'Interpreters, line 2: use the form key=value.', 'Something unexpected.'] })
    type(input('st-ssh'), 'ssh -q') // dirty, valid on the client: the engine decides
    fireEvent.click(saveBtn())
    await waitFor(() => expect(panelEl().querySelector('.settings-errors')).toBeTruthy())
    expect([...panelEl().querySelectorAll('.settings-errors li')].map((l) => l.textContent)).toHaveLength(3)
    expect(panelEl().querySelector('[data-field="max_concurrent_per_host"] .field-error')!.textContent).toContain('between 1 and 64')
    expect(panelEl().querySelector('[data-field="max_concurrent_executions"] .field-error')).toBeNull()
    expect(panelEl().querySelector('[data-field="interpreters"] .field-error')!.textContent).toContain('line 2')
    expect(input('st-ssh').value).toBe('ssh -q')
    expect(state()).toBe('1 unsaved change')
  })
})

describe('Settings panel: saving', () => {
  it('sends the form as the protocol expects it, confirms with a toast and is clean afterwards', async () => {
    await mount()
    type(input('st-max_concurrent_executions'), '5')
    fireEvent.click(page().getByLabelText(/Create and edit scripts/))
    fireEvent.click(saveBtn())
    await waitFor(() => expect(state()).toBe('All changes saved'))
    expect(calls('settings.save')[0].args.form).toEqual({
      ...FORM, max_concurrent_executions: '5', max_concurrent_per_host: '3', default_timeout: '3600', polling_interval: '2000',
      history_retention_days: '90', log_retention_days: '30', ssh_connect_timeout: '10', enable_script_editing: false, // numbers travel as text
    })
    expect(toasts.value.some((t) => t.kind === 'success' && /Settings saved/.test(t.text))).toBe(true)
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
    expect(input('st-max_concurrent_executions').value).toBe('5')
  })

  it('Ctrl+S saves while the page has focus', async () => {
    await mount()
    type(input('st-log_retention_days'), '45')
    fireEvent.keyDown(input('st-log_retention_days'), { key: 's', ctrlKey: true })
    await waitFor(() => expect(calls('settings.save').length).toBe(1))
  })

  it('restores the defaults of one section, not saved until Save', async () => {
    await mount()
    type(input('st-max_concurrent_executions'), '9')
    type(input('st-polling_interval'), '5000')
    type(input('st-history_retention_days'), '7')
    const exec = panelEl().querySelector('[data-section="execution"]') as HTMLElement
    fireEvent.click(within(exec).getByRole('button', { name: 'Restore defaults' }))
    expect(input('st-max_concurrent_executions').value).toBe('3')
    expect(input('st-polling_interval').value).toBe('2000')
    expect(input('st-history_retention_days').value).toBe('7') // another section stays
    expect(calls('settings.save').length).toBe(0)
    expect(state()).toBe('1 unsaved change')
  })
})

describe('Settings panel: search and navigation', () => {
  it('filters sections and fields by what you type', async () => {
    await mount()
    const q = page().getByLabelText('Search settings')
    type(q, 'timeout')
    const sections = [...panelEl().querySelectorAll('.settings-body > section')].map((s) => s.getAttribute('data-section'))
    expect(sections).toContain('execution')
    expect(sections).toContain('ssh')
    expect(sections).not.toContain('retention')
    expect(panelEl().querySelector('#st-default_timeout')).toBeTruthy()
    expect(panelEl().querySelector('#st-max_concurrent_executions')).toBeNull() // section matched by a field, so only that field shows
    type(q, 'zzzz')
    expect(panelEl().querySelector('.settings-empty')!.textContent).toContain('No settings match')
    fireEvent.keyDown(q, { key: 'Escape' })
    expect((q as HTMLInputElement).value).toBe('')
    expect(panelEl().querySelectorAll('.settings-body > section').length).toBe(9)
  })

  it('jumps to the section named in the tab params', async () => {
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView')
    await mount({}, { section: 'data' })
    await waitFor(() => expect(spy.mock.contexts.some((c) => (c as HTMLElement).getAttribute?.('data-section') === 'data')).toBe(true))
    spy.mockRestore()
  })
})

describe('Settings panel: SSH hosts', () => {
  it('tests a host and shows the result next to it', async () => {
    await mount()
    const row = panelEl().querySelector('tr[data-host="db-1"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(row.querySelector('.st-host-result')!.textContent).toBe('db-1: Connection timed out'))
    expect(row.querySelector('.st-host-result')!.classList.contains('is-bad')).toBe(true)
    const ok = panelEl().querySelector('tr[data-host="web-1"]') as HTMLElement
    fireEvent.click(within(ok).getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(ok.querySelector('.st-host-result.is-ok')).toBeTruthy())
    expect(calls('settings.testHost').map((c) => c.args.host)).toEqual(['db-1', 'web-1'])
  })

  it('says so when there are no hosts', async () => {
    await mount({ hosts: [] })
    expect(panelEl().querySelector('[data-section="hosts"]')!.textContent).toContain('No hosts found')
  })
})

describe('Settings panel: data', () => {
  it('lists the engine\'s data kinds with sizes, never offers secrets, and disables empty ones', async () => {
    await mount({ rows: [...ROWS, { key: 'secret_key', label: 'Secret key', help: '', bytes: 64, files: 1, size: '64 B' }, { key: 'locks', label: 'Locks', help: '', bytes: 1, files: 1, size: '1 B' }] })
    const kinds = [...panelEl().querySelectorAll('[data-section="data"] tr[data-kind]')].map((r) => r.getAttribute('data-kind'))
    expect(kinds).toEqual(['history', 'presets', 'sequences'])
    const empty = panelEl().querySelector('tr[data-kind="presets"]') as HTMLElement
    expect(empty.textContent).toContain('empty')
    expect((within(empty).getByRole('button', { name: 'Clear' }) as HTMLButtonElement).disabled).toBe(true)
    expect(panelEl().querySelector('[data-section="data"]')!.textContent).toContain('C:\\data\\ScriptHub')
  })

  it('clears one kind after confirming, and not when cancelled', async () => {
    await mount()
    const row = () => panelEl().querySelector('tr[data-kind="history"]') as HTMLElement
    fireEvent.click(within(row()).getByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(confirmState.value).toBeTruthy())
    expect(confirmState.value!.message).toBe('Clear run history? This cannot be undone.')
    confirmState.value!.resolve(false)
    await new Promise((r) => setTimeout(r, 20))
    expect(calls('settings.clear').length).toBe(0)

    fireEvent.click(within(row()).getByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(confirmState.value).toBeTruthy())
    confirmState.value!.resolve(true)
    await waitFor(() => expect(calls('settings.clear')).toEqual([{ name: 'settings.clear', args: { kind: 'history' } }]))
    await waitFor(() => expect(toasts.value.some((t) => t.text === 'Cleared history.')).toBe(true))
  })

  it('Clear all warns about everything it removes, and reloads the form when settings were cleared', async () => {
    await mount()
    type(input('st-max_concurrent_executions'), '8') // an edit that the reset discards
    fireEvent.click(within(panelEl().querySelector('[data-section="data"]') as HTMLElement).getByRole('button', { name: 'Clear all' }))
    await waitFor(() => expect(confirmState.value).toBeTruthy())
    expect(confirmState.value!.message).toContain('run history, saved values, sequences, backups, recent folders and settings')
    confirmState.value!.resolve(true)
    await waitFor(() => expect(calls('settings.clear')[0].args).toEqual({ kind: 'all' }))
    await waitFor(() => expect(state()).toBe('All changes saved'))
    expect(input('st-max_concurrent_executions').value).toBe('3')
  })
})

describe('Settings panel: appearance', () => {
  it('switches theme at once and "System" goes back to following the OS', async () => {
    await mount()
    const group = panelEl().querySelector('[role="radiogroup"]') as HTMLElement
    fireEvent.click(within(group).getByRole('radio', { name: /Light/ }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(localStorage.getItem('sr.theme')).toBe('light')
    await waitFor(() => expect(within(group).getByRole('radio', { name: /Light/ }).getAttribute('aria-checked')).toBe('true'))
    fireEvent.click(within(group).getByRole('radio', { name: /Dark/ }))
    expect(localStorage.getItem('sr.theme')).toBe('dark')
    fireEvent.click(within(group).getByRole('radio', { name: /System/ }))
    expect(localStorage.getItem('sr.theme')).toBeNull()
    await waitFor(() => expect(within(group).getByRole('radio', { name: /System/ }).getAttribute('aria-checked')).toBe('true'))
  })
})

describe('Settings panel: import, export and the unsaved draft', () => {
  it('imports a settings file into the form as unsaved changes', async () => {
    await mount()
    const file = new File([JSON.stringify({ max_concurrent_executions: 7, interpreters: { '.py': 'python3', '.ps1': 'pwsh' }, environment: { A: '1' }, bogus: 1, _format: 'x' })], 'cfg.json', { type: 'application/json' })
    const el = panelEl().querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(el, 'files', { value: [file], configurable: true })
    fireEvent.change(el)
    await waitFor(() => expect(input('st-max_concurrent_executions').value).toBe('7'))
    expect([...panelEl().querySelectorAll('[data-list="interpreters"] input.input')].map((i) => (i as HTMLInputElement).value)).toEqual(['.py', 'python3', '.ps1', 'pwsh'])
    expect(toasts.value.some((t) => /Imported 3 settings from cfg.json \(ignored: bogus\)/.test(t.text))).toBe(true)
    expect(calls('settings.save').length).toBe(0)
    expect(state()).toMatch(/unsaved change/)
  })

  it('rejects a file that is not settings', async () => {
    await mount()
    const el = panelEl().querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(el, 'files', { value: [new File(['not json'], 'x.json')], configurable: true })
    fireEvent.change(el)
    await waitFor(() => expect(toasts.value.some((t) => t.kind === 'error' && /not valid JSON/.test(t.text))).toBe(true))
  })

  it('exports the form as a JSON download', async () => {
    await mount()
    const blobs: Blob[] = []
    ;(URL as any).createObjectURL = (b: Blob) => { blobs.push(b); return 'blob:x' }
    ;(URL as any).revokeObjectURL = () => {}
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fireEvent.click(page().getByRole('button', { name: /Export/ }))
    expect(click).toHaveBeenCalled()
    const data = JSON.parse(await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsText(blobs[0]) }))
    expect(data).toMatchObject({ _format: 'scripthub-settings', max_concurrent_executions: 3, interpreters: { '.py': 'python', '.bat': 'cmd' }, environment: { TZ: 'UTC' } })
    click.mockRestore()
  })

  it('keeps unsaved edits as a draft and offers them back, with a way to discard', async () => {
    await mount()
    type(input('st-default_timeout'), '120')
    await waitFor(() => expect(localStorage.getItem(DRAFT_KEY)).toContain('"default_timeout":"120"'))
    stop?.(); stop = null
    document.body.innerHTML = ''
    tabs.value = []
    await mount()
    expect(input('st-default_timeout').value).toBe('120')
    expect(panelEl().querySelector('.settings-banner')!.textContent).toContain('restored')
    expect(state()).toBe('1 unsaved change')
    fireEvent.click(page().getByRole('button', { name: 'Discard them' }))
    expect(input('st-default_timeout').value).toBe('3600')
    expect(panelEl().querySelector('.settings-banner')).toBeNull()
  })

  it('asks the window to confirm leaving while there are unsaved changes', async () => {
    await mount()
    const fire = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented }
    expect(fire()).toBe(false)
    type(input('st-default_timeout'), '120')
    await waitFor(() => expect(fire()).toBe(true))
  })
})

describe('settings model', () => {
  it('round-trips the protocol form and keeps environment values as typed', () => {
    const form = { ...FORM, environment: 'A= spaced \nB=' } as any
    const d = fromForm(form)
    expect(d.environment.map((r) => [r.key, r.value])).toEqual([['A', ' spaced'], ['B', '']])
    expect(toForm(fromForm({ ...FORM } as any))).toEqual({ ...FORM, max_concurrent_executions: '3', max_concurrent_per_host: '3', default_timeout: '3600', polling_interval: '2000', history_retention_days: '90', log_retention_days: '30', ssh_connect_timeout: '10' })
  })

  it('validates every number against the engine ranges', () => {
    const d = defaultsDraft('win32')
    expect(validate(d).count).toBe(0)
    Object.assign(d, { max_concurrent_executions: '0', max_concurrent_per_host: '65', default_timeout: '604801', polling_interval: '499', history_retention_days: '', log_retention_days: '1.5', ssh_connect_timeout: '301' })
    expect(Object.keys(validate(d).fields).sort()).toEqual(['default_timeout', 'history_retention_days', 'log_retention_days', 'max_concurrent_executions', 'max_concurrent_per_host', 'polling_interval', 'ssh_connect_timeout'])
    const e = defaultsDraft('win32')
    e.interpreters = []
    e.ssh_executable = ' '
    expect(validate(e).fields).toMatchObject({ interpreters: expect.stringContaining('at least one'), ssh_executable: expect.any(String) })
  })

  it('catches duplicate extensions and variables', () => {
    const d = defaultsDraft('linux')
    d.interpreters = parseLines('.py=python\n.PY=python3')
    d.environment = parseLines('A=1\nA=2', true)
    const p = validate(d)
    expect(Object.values(p.rows.interpreters)[0]).toContain('twice')
    expect(Object.values(p.rows.environment)[0]).toContain('twice')
  })

  it("maps the engine's messages to fields", () => {
    expect(fieldOfError('Max concurrent executions per host must be between 1 and 64.')).toBe('max_concurrent_per_host')
    expect(fieldOfError('Max concurrent executions must be a whole number.')).toBe('max_concurrent_executions')
    expect(fieldOfError('SSH connect timeout (seconds) must be between 1 and 300.')).toBe('ssh_connect_timeout')
    expect(fieldOfError('Remote interpreters, line 3: use the form key=value.')).toBe('remote_interpreters')
    expect(fieldOfError('Invalid remote file extension: "x".')).toBe('remote_interpreters')
    expect(fieldOfError('Interpreters, line 1: use the form key=value.')).toBe('interpreters')
    expect(fieldOfError('Invalid file extension: "py" (use e.g. .py).')).toBe('interpreters')
    expect(fieldOfError('Environment line 2 must look like NAME=value.')).toBe('environment')
    expect(fieldOfError('Invalid environment variable name: "1x".')).toBe('environment')
    expect(fieldOfError('ssh_executable must be a command or path.')).toBe('ssh_executable')
    expect(fieldOfError('Something else')).toBeNull()
    expect(mapServerErrors(['Log retention must be between 1 and 36500.', 'x'])).toEqual({ log_retention_days: ['Log retention must be between 1 and 36500.'] })
  })

  it('has the engine defaults per platform', () => {
    expect(defaultsDraft('win32').interpreters.map((r) => [r.key, r.value])).toEqual([['.py', 'python'], ['.sh', 'bash'], ['.bat', 'cmd']])
    expect(defaultsDraft('linux').interpreters.map((r) => [r.key, r.value])).toEqual([['.py', 'python3'], ['.sh', 'bash']])
  })

  it('exports and re-imports settings, and refuses non-settings', () => {
    const d = defaultsDraft('win32')
    const exported = exportSettings(d)
    expect(exported).toMatchObject({ _format: 'scripthub-settings', default_timeout: 3600, interpreters: { '.py': 'python', '.sh': 'bash', '.bat': 'cmd' } })
    const back = importSettings(JSON.parse(JSON.stringify(exported)), defaultsDraft('linux'))
    expect(toForm(back.draft)).toEqual(toForm(d))
    expect(importSettings({ interpreters: '.py=python3' }, d).draft.interpreters.map((r) => r.value)).toEqual(['python3']) // the text form too
    expect(() => importSettings([], d)).toThrow(/not a settings file/)
    expect(() => importSettings({ hello: 1 }, d)).toThrow(/Nothing in this file/)
  })

  it('reads a stored draft back and ignores garbage', () => {
    const d = defaultsDraft('win32')
    expect(toForm(draftFromJson(draftToJson(d))!)).toEqual(toForm(d))
    expect(draftFromJson('{nope')).toBeNull()
    expect(draftFromJson('{"a":1}')).toBeNull()
    expect(draftFromJson(null)).toBeNull()
  })
})

describe('Settings panel: the Data overview stays current (regression: it showed "empty" right after a run)', () => {
  it('refreshes when runs change, without touching what is being edited', async () => {
    const empty = [{ key: 'history', label: 'Run history', help: 'Past runs and their logs', bytes: 0, files: 0, size: '0 B' }]
    let rows: any[] = empty
    await mount({ rows: empty })
    transport.on('settings.get', () => ({ form: FORM, sshHosts: [], dataRows: rows, dataLocation: { path: 'C:\data\ScriptHub', how: 'user' } }) as any)
    const historyRow = () => panelEl().querySelector('tr[data-kind="history"]') as HTMLElement
    await waitFor(() => expect(historyRow().textContent).toContain('empty'))
    expect((historyRow().querySelector('button') as HTMLButtonElement).disabled).toBe(true)

    type(input('st-default_timeout'), '1234') // an unsaved edit in progress
    rows = [{ key: 'history', label: 'Run history', help: 'Past runs and their logs', bytes: 4096, files: 3, size: '4.0 KB' }]
    act(() => transport.emit('runs.changed', { counts: { running: 0, queued: 0 }, started: [], finished: ['RUN-1'], sequences: { started: [], finished: [] } } as any))
    await waitFor(() => expect(historyRow().textContent).toContain('4.0 KB'))
    expect((historyRow().querySelector('button') as HTMLButtonElement).disabled).toBe(false)
    expect(input('st-default_timeout').value).toBe('1234') // the user's edit survives the refresh
  })
})
