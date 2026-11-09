import { ApiError } from '@scripthub/client'
import { act, fireEvent, render, waitFor } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import '../src/panels'
import { activeKey, emitCommand, getPanel, openTab, tabs } from '../src/core'
import { toasts } from '../src/core/toast'
import { checkForm } from '../src/panels/new-script'
import { transport } from './setup'

const LANGS: Array<[string, string]> = [['.py', 'Python'], ['.sh', 'Shell'], ['.bat', 'Batch']]
const OPTIONS = {
  languages: LANGS, folder: 'C:\\scripts', subFolders: ['maintenance', 'maintenance/logs'], categories: ['Ops', 'Network'], maxDepth: 3,
  form: { language: '.py', filename: '', subfolder: '', name: '', category: '' },
}

async function mount(params: Record<string, any> = {}) {
  const tab = openTab({ kind: 'new-script', title: 'New script', params })
  const Panel = getPanel('new-script')!.component
  const view = render(<Panel tab={tab} active />)
  return view
}
const callsOf = (name: string) => transport.calls.filter((c) => c.name === name)
const el = <T extends HTMLElement>(v: { container: Element }, sel: string) => v.container.querySelector(sel) as T

describe('new script: early hints (checkForm)', () => {
  const ok = { language: '.py', filename: 'cleanup_logs', subfolder: '', name: '', category: '' }
  it('accepts good input, with or without the extension typed', () => {
    expect(checkForm(ok, 3, LANGS)).toEqual({})
    expect(checkForm({ ...ok, filename: 'cleanup_logs.py' }, 3, LANGS)).toEqual({})
    expect(checkForm({ ...ok, subfolder: 'maintenance/logs' }, 3, LANGS)).toEqual({})
    expect(checkForm({ ...ok, subfolder: 'My Folder\\sub' }, 3, LANGS)).toEqual({})
  })
  it('flags bad names and sub-folders the way the engine does', () => {
    expect(checkForm({ ...ok, filename: '' }, 3, LANGS).filename).toMatch(/Enter a file name/)
    expect(checkForm({ ...ok, filename: '-x' }, 3, LANGS).filename).toMatch(/letters, digits/)
    expect(checkForm({ ...ok, filename: 'a b' }, 3, LANGS).filename).toMatch(/letters, digits/)
    expect(checkForm({ ...ok, subfolder: 'C:\\x' }, 3, LANGS).subfolder).toMatch(/relative/)
    expect(checkForm({ ...ok, subfolder: '/etc' }, 3, LANGS).subfolder).toMatch(/relative/)
    expect(checkForm({ ...ok, subfolder: '../up' }, 3, LANGS).subfolder).toMatch(/not allowed/)
    expect(checkForm({ ...ok, subfolder: 'a/b/c/d' }, 3, LANGS).subfolder).toMatch(/At most 3 levels/)
    expect(checkForm({ ...ok, category: 'x'.repeat(61) }, 3, LANGS).category).toMatch(/60/)
    expect(checkForm({ ...ok, name: 'x'.repeat(121) }, 3, LANGS).name).toMatch(/120/)
  })
})

describe('new script panel', () => {
  it('shows the open folder, languages and suggestions, prefilled from the script it was opened from', async () => {
    transport.on('newScript.options', ({ from }: any) => ({ ...OPTIONS, form: from ? { ...OPTIONS.form, language: '.sh', subfolder: 'maintenance', category: 'Ops' } : OPTIONS.form }))
    const v = await mount({ from: 'aaaaaaaaaaaa' })
    await waitFor(() => expect(el(v, '#n_file')).toBeTruthy())
    expect(callsOf('newScript.options')[0].args).toEqual({ from: 'aaaaaaaaaaaa' })
    expect(v.container.querySelector('.panel-head h2')?.textContent).toContain('scripts')
    expect([...v.container.querySelectorAll('#n_lang option')].map((o) => o.textContent)).toEqual(['Python (.py)', 'Shell (.sh)', 'Batch (.bat)'])
    expect(el<HTMLSelectElement>(v, '#n_lang').value).toBe('.sh')
    expect(el<HTMLInputElement>(v, '#n_sub').value).toBe('maintenance')
    expect(el<HTMLInputElement>(v, '#n_cat').value).toBe('Ops')
    expect([...v.container.querySelectorAll('#n_sub_list option')].map((o) => (o as HTMLOptionElement).value)).toEqual(['maintenance', 'maintenance/logs'])
    expect(v.container.textContent).toContain('at most 3 levels deep')
  })

  it('explains why a script cannot be created and offers to open a folder', async () => {
    transport.on('newScript.options', () => { throw new ApiError('no_folder', 'Open a script folder first; new scripts are saved in it.') })
    const v = await mount()
    await waitFor(() => expect(v.container.textContent).toContain('Open a script folder first'))
    expect(el(v, '#new-form')).toBeNull()
    expect(v.container.textContent).toContain('Open folder…')
  })

  it('previews the path and shows hints only after a field was touched, and does not post invalid input', async () => {
    transport.on('newScript.options', () => OPTIONS).on('newScript.create', () => ({ ok: true, id: 'cccccccccccc', path: 'C:\\scripts\\x.py' }))
    const v = await mount()
    await waitFor(() => expect(el(v, '#n_file')).toBeTruthy())
    expect(v.container.querySelector('.field-error')).toBeNull() // nothing shown before the user typed
    fireEvent.input(el(v, '#n_file'), { target: { value: 'bad name' } })
    await waitFor(() => expect(v.container.querySelector('.has-error .field-error')?.textContent).toMatch(/letters, digits/))
    fireEvent.submit(el(v, '#new-form'))
    await new Promise((r) => setTimeout(r, 30))
    expect(callsOf('newScript.create')).toHaveLength(0)
    fireEvent.input(el(v, '#n_file'), { target: { value: 'cleanup' } })
    fireEvent.input(el(v, '#n_sub'), { target: { value: 'maintenance' } })
    fireEvent.change(el(v, '#n_lang'), { target: { value: '.sh' } })
    await waitFor(() => expect(el(v, '[data-target]').textContent).toBe('C:\\scripts/maintenance/cleanup.sh'))
    fireEvent.input(el(v, '#n_sub'), { target: { value: 'a/b/c/d' } })
    await waitFor(() => expect(v.container.textContent).toContain('At most 3 levels deep.'))
  })

  it('creates the script, closes itself and opens the new script on its Run tab', async () => {
    transport.on('newScript.options', () => OPTIONS).on('newScript.create', () => ({ ok: true, id: 'cccccccccccc', path: 'C:\\scripts\\maintenance\\cleanup.sh' }))
    const v = await mount()
    await waitFor(() => expect(el(v, '#n_file')).toBeTruthy())
    fireEvent.input(el(v, '#n_file'), { target: { value: 'cleanup' } })
    fireEvent.change(el(v, '#n_lang'), { target: { value: '.sh' } })
    fireEvent.input(el(v, '#n_sub'), { target: { value: 'maintenance' } })
    fireEvent.input(el(v, '#n_cat'), { target: { value: 'Ops' } })
    fireEvent.input(el(v, '#n_name'), { target: { value: 'Clean up logs' } })
    fireEvent.submit(el(v, '#new-form'))
    await waitFor(() => expect(callsOf('newScript.create')).toHaveLength(1))
    expect(callsOf('newScript.create')[0].args).toEqual({ language: '.sh', filename: 'cleanup', subfolder: 'maintenance', name: 'Clean up logs', category: 'Ops' })
    await waitFor(() => expect(tabs.value.some((t) => t.key === 'script:cccccccccccc')).toBe(true))
    expect(tabs.value.some((t) => t.kind === 'new-script')).toBe(false)
    expect(activeKey.value).toBe('script:cccccccccccc')
    expect(tabs.value.find((t) => t.kind === 'script')).toMatchObject({ title: 'cleanup.sh', params: { view: 'run' } })
    expect(toasts.value.some((t) => t.text === 'Script created.')).toBe(true)
  })

  it('shows the engine\'s refusals inline and stays open', async () => {
    transport.on('newScript.options', () => OPTIONS).on('newScript.create', () => ({ ok: false, errors: ['maintenance/cleanup.py already exists; ScriptHub never overwrites files.'] }))
    const v = await mount()
    await waitFor(() => expect(el(v, '#n_file')).toBeTruthy())
    fireEvent.input(el(v, '#n_file'), { target: { value: 'cleanup' } })
    fireEvent.submit(el(v, '#new-form'))
    await waitFor(() => expect(v.container.textContent).toContain('already exists'))
    expect(v.container.textContent).toContain('Not created.')
    expect(tabs.value.some((t) => t.kind === 'new-script')).toBe(true)
  })

  it('creates on Ctrl+Enter (the run command) and does nothing while the form is invalid', async () => {
    transport.on('newScript.options', () => OPTIONS).on('newScript.create', () => ({ ok: true, id: 'dddddddddddd', path: 'C:\\scripts\\a.py' }))
    const v = await mount()
    await waitFor(() => expect(el(v, '#n_file')).toBeTruthy())
    act(() => { emitCommand('run.run', {}) })
    await new Promise((r) => setTimeout(r, 30))
    expect(callsOf('newScript.create')).toHaveLength(0)
    expect(v.container.querySelector('.has-error .field-error')?.textContent).toMatch(/Enter a file name/) // the hint appears
    fireEvent.input(el(v, '#n_file'), { target: { value: 'a' } })
    act(() => { emitCommand('run.run', {}) })
    await waitFor(() => expect(callsOf('newScript.create')).toHaveLength(1))
  })

  it('reloads the form when opened again from another script', async () => {
    transport.on('newScript.options', ({ from }: any) => ({ ...OPTIONS, form: { ...OPTIONS.form, subfolder: from ? 'maintenance' : '' } }))
    const v = await mount()
    await waitFor(() => expect(el<HTMLInputElement>(v, '#n_sub')?.value).toBe(''))
    const Panel = getPanel('new-script')!.component
    const again = openTab({ kind: 'new-script', params: { from: 'zzzzzzzzzzzz', nonce: 2 } }) // the shell hands the page its updated tab
    v.rerender(<Panel tab={again} active />)
    await waitFor(() => expect(callsOf('newScript.options').length).toBeGreaterThan(1))
    expect(callsOf('newScript.options')[1].args).toEqual({ from: 'zzzzzzzzzzzz' })
    await waitFor(() => expect(el<HTMLInputElement>(v, '#n_sub').value).toBe('maintenance'))
  })
})
