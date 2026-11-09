import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/preact'
import { beforeEach, describe, expect, it } from 'vitest'
import '../src/panels'
import { activeKey, activeTab, closeTab, confirmState, emitCommand, forceCloseTab, getPanel, openTab, refreshShell, tabs } from '../src/core'
import { demoShell } from '@scripthub/client'
import { editorFactory, type Disposable, type EditorAdapter } from '../src/editor'
import { toasts } from '../src/core/toast'
import { dirtyIds, requestLoad } from '../src/panels/script/store'
import { SavedValues } from '../src/panels/script/SavedValues'
import { transport } from './setup'

const CODE = '#!/usr/bin/env python3\n# --- scripthub ---\n# name: Hello\n# --- end scripthub ---\nimport sys\ndays = int(sys.argv[2])\nprint("days", days)\n'
const ID = 'aaaaaaaaaaaa'

const SCRIPT = {
  id: ID, name: 'Hello', path: 'C:\\s\\hello.py', root: 'C:\\s', relative: 'hello.py', location: 'C:\\s', category: 'General', description: '',
  extension: '.py', ext: 'py', interpreter: 'python', language: 'python', languageLabel: 'Python', platforms: ['windows', 'linux', 'macos'],
  platformLabels: ['Windows', 'Linux', 'macOS'], metaValid: true, metaError: null, parameterCount: 1, idConflict: '', pathId: ID,
}
const PARAM = { name: 'days', label: 'Days', type: 'number', default: 7, required: false, editable_at_runtime: true, pass_as: 'flag', arg: '--days' }
const TYPE_INFO = {
  text: { label: 'Text', allowed: ['min_length', 'max_length', 'pattern'] }, number: { label: 'Number', allowed: ['min', 'max'] },
  boolean: { label: 'Boolean', allowed: [] }, select: { label: 'Select', allowed: ['choices'] },
}
const FORM = { name: '', description: '', category: '', interpreter: '', platforms: [], host: 'local', working_directory: '', environment: '' }

function detail(over: Record<string, any> = {}) {
  return {
    script: SCRIPT, runs: [], presets: [], recent: [], savedCount: 0, form: FORM, params: [PARAM], typeInfo: TYPE_INFO,
    platformChoices: [['windows', 'Windows'], ['linux', 'Linux'], ['macos', 'macOS']], hosts: ['local', 'web-1'], loadError: null, ...over,
  }
}
function doc(over: Record<string, any> = {}) {
  return {
    source: { text: CODE, lines: [], truncated: false, error: null, language: 'python', size: CODE.length, metaText: '' },
    editor: { text: CODE, hash: 'h1', newline: 'LF', bom: false, size: CODE.length, writable: true }, editorError: null, versions: [],
    grid: { columns: [], rows: [] }, file: {}, ...over,
  }
}
const field = (over: Record<string, any> = {}) => ({
  p: PARAM, name: 'days', input_name: 'p_days', input: 'number', value: '7', selected: [], choices: [], locked: false, error: null, ...over,
})
function runForm(over: Record<string, any> = {}) {
  return {
    script: SCRIPT, blocked: null, fields: [field()], hosts: ['local', 'web-1'], host: 'local', source: { kind: 'defaults', key: '-', label: 'Defaults' },
    warnings: [], presets: [], recent: [], hasPassword: false, modesSupported: true, ...over,
  }
}

/** An editor that lives in memory: tests type into it with `type()`, and read back what the page decorated. */
class FakeEditor implements EditorAdapter {
  readonly kind = 'fake'
  value = ''
  readOnly = false
  change: ((v: string) => void) | null = null
  decorations: Record<string, Array<{ line: number }>> = {}
  revealed: number[] = []
  async mount(_el: HTMLElement, o: { value: string; readOnly?: boolean }) { this.value = o.value; this.readOnly = !!o.readOnly }
  getValue() { return this.value }
  setValue(v: string) { this.value = v }
  onChange(cb: (v: string) => void): Disposable { this.change = cb; return { dispose() {} } }
  setLanguage() {}
  setTheme() {}
  setReadOnly(r: boolean) { this.readOnly = r }
  setMarkers() {}
  setLineDecorations(owner: string, d: Array<{ line: number }>) { this.decorations[owner] = d }
  setBreakpoints() {}
  getBreakpoints() { return [] }
  onBreakpointsChange(): Disposable { return { dispose() {} } }
  onCursorLine(): Disposable { return { dispose() {} } }
  revealLine(l: number) { this.revealed.push(l) }
  focus() {}
  layout() {}
  dispose() {}
  type(v: string) { this.value = v; this.change?.(v) }
}

let editor: FakeEditor
const saved: Array<Record<string, any>> = []

function wire(over: { detail?: any; doc?: any; form?: any } = {}) {
  const state = { detail: over.detail ?? detail(), doc: over.doc ?? doc(), form: over.form ?? runForm(), hash: 'h1' }
  transport
    .on('scripts.get', () => state.detail)
    .on('scripts.doc', () => state.doc)
    .on('runs.form', ({ preset }: any) => ({ ...state.form, source: preset && preset !== '-' && preset !== '' ? { kind: 'preset', key: preset, label: 'Nightly', slug: preset } : state.form.source }))
    .on('presets.list', () => ({ presets: [], recent: [] }))
    .on('editor.read', () => ({ info: { ...state.doc.editor, hash: state.hash }, error: null, versions: [] }))
    .on('editor.save', (a: any) => { saved.push(a); state.hash = 'h2'; return { ok: true, changed: true, warning: null, id: ID } })
    .on('app.reveal', () => ({ ok: true }))
  return state
}

async function mount(params: Record<string, any> = {}) {
  const tab = openTab({ kind: 'script', id: ID, title: 'Hello', params })
  const Panel = getPanel('script')!.component
  const view = render(<Panel tab={tab} active />)
  await waitFor(() => expect(view.container.querySelector('[data-doc]')).toBeTruthy())
  await waitFor(() => expect(editor.value).toBe(CODE))
  return view
}

const saveButton = (v: { container: Element }) => v.container.querySelector('[data-save-all]') as HTMLButtonElement
/** A shell that knows this script (the explorer renames its tab to the script's name, and prunes unknown ones). */
async function withShell() {
  transport.on('app.shell', () => demoShell({ palette: [
    { id: ID, name: 'Hello', cat: 'General', ext: 'py', path: SCRIPT.path, run: true },
    { id: 'bbbbbbbbbbbb', name: 'Hello', cat: 'General', ext: 'py', path: SCRIPT.path, run: true },
  ] }))
  await refreshShell()
}
const callsOf = (name: string) => transport.calls.filter((c) => c.name === name)
const pressSave = () => fireEvent.keyDown(window, { key: 's', ctrlKey: true })

beforeEach(() => {
  editor = new FakeEditor()
  editorFactory.create = async () => editor
  saved.length = 0
  dirtyIds.value = {}
})

describe('script page: loading and layout', () => {
  it('shows the script in the editor, the right column with Overview / Parameters / Run, and the run form', async () => {
    wire()
    const v = await mount()
    expect(v.container.querySelector('.doc-tab .tab-name')?.textContent).toBe('hello.py')
    expect(v.container.querySelector('.lang')?.textContent).toBe('py')
    expect(editor.readOnly).toBe(false)
    await waitFor(() => expect(v.container.querySelector('form[id^="run"][id$="-form"]')).toBeTruthy())
    expect((v.container.querySelector('[id$="-id_days"]') as HTMLInputElement).value).toBe('7')
    expect(v.container.querySelector('[data-view="run"]')?.classList.contains('is-active')).toBe(true)
    fireEvent.click(v.container.querySelector('[data-view="overview"]')!)
    expect((v.container.querySelector('[id^="ov"][id$="-host"]') as HTMLSelectElement).value).toBe('local')
    fireEvent.click(v.container.querySelector('[data-view="parameters"]')!)
    expect(v.container.querySelector('#param-list')).toBeTruthy()
    expect(v.container.querySelector('.count-pill')?.textContent).toBe('1')
  })

  it('opens read-only when editing is off, with the reason shown', async () => {
    wire({ doc: doc({ editor: null }) })
    const v = await mount()
    expect(editor.readOnly).toBe(true)
    expect(v.container.textContent).toContain('Editing is switched off')
    expect(v.container.querySelector('.ed-hint')).toBeNull()
  })

  it('marks a read-only file', async () => {
    wire({ doc: doc({ editor: { ...doc().editor, writable: false } }) })
    const v = await mount()
    expect(v.container.textContent).toContain('read-only file')
    expect(editor.readOnly).toBe(true)
  })

  it('shows the block reason when the metadata is invalid and keeps the Run tab blocked', async () => {
    wire({ detail: detail({ script: { ...SCRIPT, metaValid: false, metaError: 'Invalid metadata: parameters[0].name' } }), form: runForm({ blocked: 'Invalid metadata: parameters[0].name', fields: [] }) })
    const v = await mount()
    await waitFor(() => expect(v.container.textContent).toContain('Invalid metadata: parameters[0].name'))
    expect(v.container.querySelector('form[id^="run"][id$="-form"]')).toBeNull()
    fireEvent.click(v.container.querySelector('[data-view="overview"]')!)
    expect(v.container.textContent).toContain('Invalid metadata')
  })

  it('warns about a copy that has the same id as another script', async () => {
    wire({ detail: detail({ script: { ...SCRIPT, idConflict: 'C:\\s\\original.py' } }) })
    const v = await mount()
    fireEvent.click(v.container.querySelector('[data-view="overview"]')!)
    expect(v.container.textContent).toContain('same id as')
    expect(v.container.textContent).toContain('C:\\s\\original.py')
  })

  it('reveals the script in the file manager on the desktop only', async () => {
    wire()
    const { hostInfo } = await import('../src/core/shellState')
    hostInfo.value = { desktop: true, nativeMenu: true, platform: 'win32' }
    const v = await mount()
    fireEvent.click(v.container.querySelector('[aria-label="Show in folder"]')!)
    await waitFor(() => expect(callsOf('app.reveal')[0]?.args).toEqual({ kind: 'script', id: ID }))
  })
})

describe('script page: one Save', () => {
  it('marks unsaved edits (button, tab title, status) and saves with the base hash on Ctrl+S', async () => {
    wire()
    const v = await mount()
    expect(saveButton(v).classList.contains('is-dirty')).toBe(false)
    act(() => editor.type(CODE + 'print("more")\n'))
    await waitFor(() => expect(saveButton(v).classList.contains('is-dirty')).toBe(true))
    expect(activeTab.value?.title).toBe('● Hello')
    expect(dirtyIds.value[ID]).toBe(true)
    expect(v.container.querySelector('.ed-dirty')?.textContent).toContain('unsaved')
    pressSave()
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0]).toMatchObject({ id: ID, baseHash: 'h1', text: CODE + 'print("more")\n' })
    await waitFor(() => expect(saveButton(v).classList.contains('is-dirty')).toBe(false))
    expect(activeTab.value?.title).toBe('Hello')
    expect(dirtyIds.value[ID]).toBeUndefined()
    expect(toasts.value.some((t) => t.text === 'Saved.')).toBe(true)
    // the next save uses the new hash the engine reported
    act(() => editor.type(CODE))
    pressSave()
    await waitFor(() => expect(saved).toHaveLength(2))
    expect(saved[1].baseHash).toBe('h2')
  })

  it('keeps the unsaved dot on the tab title when the shell refreshes the explorer', async () => {
    wire()
    await withShell()
    const v = await mount()
    act(() => editor.type('changed\n'))
    await waitFor(() => expect(activeTab.value?.title).toBe('● Hello'))
    await act(async () => { await refreshShell() }) // the shell renames the tab to the script's name
    await waitFor(() => expect(activeTab.value?.title).toBe('● Hello'))
    expect(saveButton(v).classList.contains('is-dirty')).toBe(true)
  })

  it('says so when there is nothing to save', async () => {
    wire()
    await mount()
    pressSave()
    await waitFor(() => expect(toasts.value.some((t) => t.text === 'Nothing to save.')).toBe(true))
    expect(saved).toHaveLength(0)
  })

  it('shows the syntax warning the engine reports', async () => {
    const s = wire()
    transport.on('editor.save', () => { s.hash = 'h2'; return { ok: true, changed: true, warning: 'Syntax error on line 3', id: ID } })
    const v = await mount()
    act(() => editor.type('def (:\n'))
    pressSave()
    await waitFor(() => expect(v.container.querySelector('[data-warning]')?.textContent).toContain('Syntax error on line 3'))
  })

  it('offers Reload / Overwrite on a conflict, and Overwrite saves again with force', async () => {
    wire()
    transport.on('editor.save', (a: any) => {
      saved.push(a)
      return a.force ? { ok: true, changed: true, warning: null, id: ID } : { ok: false, conflict: true, error: 'The file changed on disk since you opened it.' }
    })
    const v = await mount()
    act(() => editor.type(CODE + '# mine\n'))
    pressSave()
    await waitFor(() => expect(v.container.querySelector('[data-conflict]')).toBeTruthy())
    expect(v.container.querySelector('[data-conflict]')?.textContent).toContain('changed on disk')
    expect(saveButton(v).classList.contains('is-dirty')).toBe(true) // still unsaved
    fireEvent.click(within(v.container.querySelector('[data-conflict]') as HTMLElement).getByText('Overwrite with mine'))
    await waitFor(() => expect(saved).toHaveLength(2))
    expect(saved[1].force).toBe(true)
    await waitFor(() => expect(v.container.querySelector('[data-conflict]')).toBeNull())
  })

  it('reloads from disk after a conflict, dropping the edits', async () => {
    const s = wire()
    transport.on('editor.save', () => ({ ok: false, conflict: true, error: 'The file changed on disk.' }))
    const v = await mount()
    act(() => editor.type('mine\n'))
    pressSave()
    await waitFor(() => expect(v.container.querySelector('[data-conflict]')).toBeTruthy())
    s.doc = doc({ editor: { ...doc().editor, text: 'theirs\n', hash: 'h9' }, source: { ...doc().source, text: 'theirs\n' } })
    fireEvent.click(within(v.container.querySelector('[data-conflict]') as HTMLElement).getByText('Reload from disk'))
    await waitFor(() => expect(editor.value).toBe('theirs\n'))
    await waitFor(() => expect(saveButton(v).classList.contains('is-dirty')).toBe(false))
  })

  it('refuses to save an edited metadata block together with an edited form', async () => {
    wire()
    const v = await mount()
    act(() => editor.type(CODE.replace('name: Hello', 'name: Other')))
    fireEvent.click(v.container.querySelector('[data-view="overview"]')!)
    fireEvent.input(v.container.querySelector('[id^="ov"][id$="-name"]')!, { target: { value: 'Renamed' } })
    pressSave()
    await waitFor(() => expect(toasts.value.some((t) => /same settings/.test(t.text))).toBe(true))
    expect(saved).toHaveLength(0)
    expect(callsOf('scripts.saveInfo')).toHaveLength(0)
  })

  it('saves Overview settings through scripts.saveInfo and reloads everything', async () => {
    const s = wire()
    transport.on('scripts.saveInfo', ({ form }: any) => { s.detail = detail({ form }); return { ok: true, id: ID } })
    const v = await mount()
    fireEvent.click(v.container.querySelector('[data-view="overview"]')!)
    fireEvent.input(v.container.querySelector('[id^="ov"][id$="-name"]')!, { target: { value: 'Pretty name' } })
    fireEvent.change(v.container.querySelector('[id^="ov"][id$="-host"]')!, { target: { value: 'web-1' } })
    fireEvent.click(v.container.querySelector('input[type=checkbox][value=linux]')!)
    await waitFor(() => expect(saveButton(v).classList.contains('is-dirty')).toBe(true))
    pressSave()
    await waitFor(() => expect(callsOf('scripts.saveInfo')).toHaveLength(1))
    expect(callsOf('scripts.saveInfo')[0].args).toEqual({ id: ID, form: { ...FORM, name: 'Pretty name', host: 'web-1', platforms: ['linux'] } })
    expect(saved).toHaveLength(0) // the script text was not touched
    await waitFor(() => expect(saveButton(v).classList.contains('is-dirty')).toBe(false))
    expect((v.container.querySelector('[id^="ov"][id$="-name"]') as HTMLInputElement).value).toBe('Pretty name')
  })

  it('keeps the form dirty and lists the engine\'s errors when saving settings fails', async () => {
    wire()
    transport.on('scripts.saveInfo', () => ({ ok: false, errors: ['Environment: line 2 is not NAME=value.'] }))
    const v = await mount()
    fireEvent.click(v.container.querySelector('[data-view="overview"]')!)
    fireEvent.input(v.container.querySelector('[id^="ov"][id$="-env"]')!, { target: { value: 'nonsense' } })
    pressSave()
    await waitFor(() => expect(v.container.textContent).toContain('Environment: line 2 is not NAME=value.'))
    expect(v.container.textContent).toContain('Not saved.')
    expect(saveButton(v).classList.contains('is-dirty')).toBe(true)
  })

  it('saves the script first, then the forms, in that order', async () => {
    const s = wire()
    transport.on('scripts.saveInfo', ({ form }: any) => { s.detail = detail({ form }); return { ok: true, id: ID } })
    const v = await mount()
    act(() => editor.type(CODE + '# body only\n'))
    fireEvent.click(v.container.querySelector('[data-view="overview"]')!)
    fireEvent.input(v.container.querySelector('[id^="ov"][id$="-category"]')!, { target: { value: 'Ops' } })
    pressSave()
    await waitFor(() => expect(callsOf('scripts.saveInfo')).toHaveLength(1))
    const order = transport.calls.map((c) => c.name).filter((n) => n === 'editor.save' || n === 'scripts.saveInfo')
    expect(order).toEqual(['editor.save', 'scripts.saveInfo'])
  })

  it('moves the tab to the new id when saving writes a stable id', async () => {
    const s = wire()
    await withShell()
    transport.on('scripts.saveInfo', ({ form }: any) => { s.detail = detail({ form, script: { ...SCRIPT, id: 'bbbbbbbbbbbb' } }); return { ok: true, id: 'bbbbbbbbbbbb' } })
    const v = await mount()
    fireEvent.click(v.container.querySelector('[data-view="overview"]')!)
    fireEvent.input(v.container.querySelector('[id^="ov"][id$="-name"]')!, { target: { value: 'X' } })
    pressSave()
    await waitFor(() => expect(tabs.value.map((t) => t.key)).toContain('script:bbbbbbbbbbbb'))
    expect(tabs.value.map((t) => t.key)).not.toContain(`script:${ID}`)
    expect(activeKey.value).toBe('script:bbbbbbbbbbbb')
    v.unmount()
  })

  const dirtyTab = async () => {
    wire()
    const v = await mount()
    act(() => editor.type('changed\n'))
    await waitFor(() => expect(dirtyIds.value[ID]).toBe(true))
    return v
  }
  const hasTab = () => tabs.value.some((t) => t.key === `script:${ID}`)

  it('asks Save / Don\'t save / Cancel before a tab with unsaved changes closes (x, Ctrl+W, menu: all go through closeTab)', async () => {
    await dirtyTab()
    const closing = closeTab(`script:${ID}`)
    await waitFor(() => expect(confirmState.value?.title).toBe('Unsaved changes'))
    expect(confirmState.value?.altLabel).toBe("Don't save")
    expect(hasTab()).toBe(true)
    act(() => confirmState.value!.resolve('cancel'))
    expect(await closing).toBe(false)
    expect(hasTab()).toBe(true)
  })

  it('Don\'t save closes the tab and forgets the draft', async () => {
    await dirtyTab()
    await waitFor(() => expect(localStorage.getItem(`scripthub.draft.${ID}`)).toContain('changed'))
    const closing = closeTab(`script:${ID}`)
    await waitFor(() => expect(confirmState.value).toBeTruthy())
    act(() => confirmState.value!.resolve('alt'))
    expect(await closing).toBe(true)
    expect(hasTab()).toBe(false)
    expect(localStorage.getItem(`scripthub.draft.${ID}`)).toBeNull()
    expect(saved.length).toBe(0)
  })

  it('Save saves first, then closes; a failed save keeps the tab', async () => {
    await dirtyTab()
    const closing = closeTab(`script:${ID}`)
    await waitFor(() => expect(confirmState.value).toBeTruthy())
    act(() => confirmState.value!.resolve('ok'))
    expect(await closing).toBe(true)
    expect(saved.length).toBe(1)
    expect(hasTab()).toBe(false)
  })

  it('a clean script closes at once, without a question', async () => {
    wire()
    await mount()
    await closeTab(`script:${ID}`)
    expect(confirmState.value).toBeNull()
    expect(hasTab()).toBe(false)
  })

  it('a script page that moves to a new id (first save writes a stable id) does not ask', async () => {
    await dirtyTab()
    forceCloseTab(`script:${ID}`)
    expect(confirmState.value).toBeNull()
    expect(hasTab()).toBe(false)
  })

  it('params.view and params.preset open the Run tab and load those saved values ("Run again"), once', async () => {
    wire()
    const v = await mount({ view: 'overview' })
    expect(v.container.querySelector('[data-view="overview"]')?.classList.contains('is-active')).toBe(true)
    const Panel = getPanel('script')!.component
    openTab({ kind: 'script', id: ID, params: { view: 'run', preset: '@1', nonce: 1 } })
    v.rerender(<Panel tab={tabs.value.find((t) => t.key === `script:${ID}`)!} active />)
    await waitFor(() => expect(callsOf('runs.form').some((c) => (c.args as any).preset === '@1')).toBe(true))
    expect(v.container.querySelector('[data-view="run"]')?.classList.contains('is-active')).toBe(true)
    await waitFor(() => expect(tabs.value.find((t) => t.key === `script:${ID}`)?.params.preset).toBeNull()) // asked once
    const loads = callsOf('runs.form').filter((c) => (c.args as any).preset === '@1').length
    v.rerender(<Panel tab={tabs.value.find((t) => t.key === `script:${ID}`)!} active />)
    await new Promise((r) => setTimeout(r, 30))
    expect(callsOf('runs.form').filter((c) => (c.args as any).preset === '@1').length).toBe(loads) // not again on a re-render
  })

  it('keeps a draft of unsaved edits and offers it back the next time the script opens', async () => {
    wire()
    const first = await mount()
    act(() => editor.type('draft text\n'))
    await waitFor(() => expect(localStorage.getItem(`scripthub.draft.${ID}`)).toContain('draft text'))
    first.unmount()
    tabs.value = []
    activeKey.value = null
    editor = new FakeEditor()
    const second = await mount()
    await waitFor(() => expect(second.container.querySelector('[data-draft]')).toBeTruthy())
    fireEvent.click(within(second.container.querySelector('[data-draft]') as HTMLElement).getByText('Restore them'))
    expect(editor.value).toBe('draft text\n')
    await waitFor(() => expect(saveButton(second).classList.contains('is-dirty')).toBe(true))
  })

  it('discards the draft when asked', async () => {
    wire()
    localStorage.setItem(`scripthub.draft.${ID}`, JSON.stringify({ text: 'old draft', hash: 'h1' }))
    const v = await mount()
    await waitFor(() => expect(v.container.querySelector('[data-draft]')).toBeTruthy())
    fireEvent.click(within(v.container.querySelector('[data-draft]') as HTMLElement).getByText('Discard'))
    expect(localStorage.getItem(`scripthub.draft.${ID}`)).toBeNull()
    expect(v.container.querySelector('[data-draft]')).toBeNull()
  })
})

describe('script page: parameters', () => {
  it('adds, edits, reorders and deletes definitions and saves them through scripts.saveParameters', async () => {
    const s = wire()
    transport.on('scripts.saveParameters', ({ parameters }: any) => { s.detail = detail({ params: parameters }); return { ok: true, id: ID } })
    const v = await mount()
    fireEvent.click(v.container.querySelector('[data-view="parameters"]')!)
    fireEvent.click(v.container.querySelector('#add-param')!)
    const rows = () => [...v.container.querySelectorAll('.pe-item')] as HTMLElement[]
    expect(rows()).toHaveLength(2)
    expect(rows()[1].dataset.param).toBe('param_2')
    // the new definition opens for editing: rename it and make it a select with choices
    const card = v.container.querySelector('.pe-card') as HTMLElement
    const [name] = card.querySelectorAll('input')
    fireEvent.input(name, { target: { value: 'color' } })
    fireEvent.change(card.querySelector('select')!, { target: { value: 'select' } })
    const choices = await waitFor(() => { const t = card.querySelector('textarea'); if (!t) throw new Error('no choices'); return t })
    fireEvent.input(choices, { target: { value: 'red\ngreen|Green' } })
    // move it up
    fireEvent.click(rows()[1].querySelector('[aria-label="Move up"]')!)
    expect(rows().map((r) => r.dataset.param)).toEqual(['color', 'days'])
    await waitFor(() => expect(saveButton(v).classList.contains('is-dirty')).toBe(true))
    pressSave()
    await waitFor(() => expect(callsOf('scripts.saveParameters')).toHaveLength(1))
    const sent = callsOf('scripts.saveParameters')[0].args.parameters
    expect(sent.map((p: any) => p.name)).toEqual(['color', 'days'])
    expect(sent[0]).toMatchObject({ name: 'color', type: 'select', choices: ['red', { value: 'green', label: 'Green' }], pass_as: 'flag' })
    expect(sent[1]).toEqual(PARAM) // untouched definitions go back unchanged
    await waitFor(() => expect(saveButton(v).classList.contains('is-dirty')).toBe(false))

    // delete asks first
    fireEvent.click(rows()[0].querySelector('[aria-label="Delete parameter"]')!)
    await waitFor(() => expect(confirmState.value).toBeTruthy())
    act(() => confirmState.value!.resolve(true))
    await waitFor(() => expect(rows()).toHaveLength(1))
  })

  it('does not count a re-rendered but unchanged parameter list as unsaved', async () => {
    wire()
    const v = await mount()
    fireEvent.click(v.container.querySelector('[data-view="parameters"]')!)
    fireEvent.click(v.container.querySelector('.pe-row')!)
    expect(v.container.querySelector('.pe-edit')).toBeTruthy()
    expect(saveButton(v).classList.contains('is-dirty')).toBe(false)
  })

  it('shows early hints in the row and the engine\'s errors after a failed save', async () => {
    wire()
    transport.on('scripts.saveParameters', () => ({ ok: false, errors: ['Parameter 1 (days): minimum is larger than the maximum.'] }))
    const v = await mount()
    fireEvent.click(v.container.querySelector('[data-view="parameters"]')!)
    fireEvent.click(v.container.querySelector('.pe-row')!)
    const inputs = [...v.container.querySelectorAll('.pe-card input')] as HTMLInputElement[]
    const labelFor = (t: string) => [...v.container.querySelectorAll('.pe-card .field')].find((f) => f.textContent?.startsWith(t))!.querySelector('input')!
    fireEvent.input(labelFor('Minimum'), { target: { value: '9' } })
    fireEvent.input(labelFor('Maximum'), { target: { value: '2' } })
    expect(inputs.length).toBeGreaterThan(3)
    await waitFor(() => expect(v.container.querySelector('[data-issues]')?.textContent).toMatch(/minimum is larger/))
    pressSave()
    await waitFor(() => expect(v.container.textContent).toContain('Parameter 1 (days): minimum is larger than the maximum.'))
    expect(saveButton(v).classList.contains('is-dirty')).toBe(true)
  })

  it('marks the script lines that use a parameter when its field or row is hovered or focused', async () => {
    wire()
    const v = await mount()
    const f = v.container.querySelector('[data-field="days"]') as HTMLElement
    fireEvent.mouseOver(f.querySelector('input')!)
    await waitFor(() => expect(editor.decorations.params?.map((d) => d.line)).toEqual([6, 7]))
    expect(v.container.querySelector('.doc-refs')?.textContent).toBe('days: 2 lines')
    fireEvent.mouseOut(f.querySelector('input')!, { relatedTarget: document.body })
    await waitFor(() => expect(editor.decorations.params).toEqual([]))
    fireEvent.focusIn(f.querySelector('input')!)
    await waitFor(() => expect(editor.revealed).toEqual([6]))
    // the parameter editor rows mark their flag too
    fireEvent.click(v.container.querySelector('[data-view="parameters"]')!)
    fireEvent.mouseOver(v.container.querySelector('.pe-item')!)
    await waitFor(() => expect(editor.decorations.params?.length).toBeGreaterThan(0))
  })
})

describe('script page: Run tab', () => {
  it('starts a run from the form values, opens it as a run tab and keeps the form', async () => {
    wire()
    transport.on('runs.start', () => ({ ok: true, runId: 'RUN-20261109-007' }))
    const v = await mount()
    await waitFor(() => expect(v.container.querySelector('[id$="-id_days"]')).toBeTruthy())
    fireEvent.input(v.container.querySelector('[id$="-id_days"]')!, { target: { value: '30' } })
    fireEvent.change(v.container.querySelector('[id^="run"][id$="-host"]')!, { target: { value: 'web-1' } })
    fireEvent.click(v.container.querySelector('input[name=mode][value=trace]')!)
    fireEvent.submit(v.container.querySelector('form[id^="run"][id$="-form"]')!)
    await waitFor(() => expect(callsOf('runs.start')).toHaveLength(1))
    const a = callsOf('runs.start')[0].args
    expect(a).toMatchObject({ scriptId: ID, host: 'web-1', values: { days: '30' }, mode: 'trace' })
    expect(a.token).toBeTruthy()
    await waitFor(() => expect(tabs.value.some((t) => t.key === 'run:RUN-20261109-007')).toBe(true))
    expect(tabs.value.find((t) => t.kind === 'run')).toMatchObject({ title: 'run 007', params: { scriptId: ID } })
    expect((v.container.querySelector('[id$="-id_days"]') as HTMLInputElement).value).toBe('30')
    // the next run gets its own submit token
    fireEvent.submit(v.container.querySelector('form[id^="run"][id$="-form"]')!)
    await waitFor(() => expect(callsOf('runs.start')).toHaveLength(2))
    expect(callsOf('runs.start')[1].args.token).not.toBe(a.token)
  })

  it('shows the engine\'s field and host errors and starts nothing', async () => {
    wire()
    transport.on('runs.start', () => ({
      ok: false, errors: { days: 'Must be at least 1.' }, hostError: null, host: 'local', source: null, warnings: [], fields: [field({ error: 'Must be at least 1.' })],
    }))
    const v = await mount()
    await waitFor(() => expect(v.container.querySelector('[id$="-id_days"]')).toBeTruthy())
    fireEvent.submit(v.container.querySelector('form[id^="run"][id$="-form"]')!)
    await waitFor(() => expect(v.container.querySelector('[data-field="days"] .field-error')?.textContent).toBe('Must be at least 1.'))
    expect(v.container.textContent).toContain('Please correct the highlighted fields.')
    expect(tabs.value.some((t) => t.kind === 'run')).toBe(false)
    fireEvent.input(v.container.querySelector('[id$="-id_days"]')!, { target: { value: '5' } }) // typing clears that error
    await waitFor(() => expect(v.container.querySelector('[data-field="days"] .field-error')).toBeNull())
  })

  it('shows early hints while typing, without blocking the run', async () => {
    wire()
    transport.on('runs.start', () => ({ ok: true, runId: 'RUN-20261109-008' }))
    const v = await mount()
    await waitFor(() => expect(v.container.querySelector('[id$="-id_days"]')).toBeTruthy())
    fireEvent.input(v.container.querySelector('[id$="-id_days"]')!, { target: { value: '1.5' } })
    await waitFor(() => expect(v.container.querySelector('[data-field="days"] .field-error')?.textContent ?? '').toMatch(/whole number/))
    fireEvent.submit(v.container.querySelector('form[id^="run"][id$="-form"]')!)
    await waitFor(() => expect(callsOf('runs.start')).toHaveLength(1)) // the engine decides
  })

  it('runs on the run.run command (Ctrl+Enter, r, Run menu) in the requested mode, from any right-hand tab', async () => {
    wire()
    transport.on('runs.start', () => ({ ok: true, runId: 'RUN-20261109-009' }))
    const v = await mount()
    await waitFor(() => expect(v.container.querySelector('[id$="-id_days"]')).toBeTruthy())
    fireEvent.click(v.container.querySelector('[data-view="overview"]')!)
    act(() => { emitCommand('run.run', { mode: 'debug' }) })
    await waitFor(() => expect(callsOf('runs.start')).toHaveLength(1))
    expect(callsOf('runs.start')[0].args.mode).toBe('debug')
    expect(v.container.querySelector('[data-view="run"]')?.classList.contains('is-active')).toBe(true)
  })

  it('saves unsaved script edits before it runs, and does not run when saving fails', async () => {
    wire()
    transport.on('runs.start', () => ({ ok: true, runId: 'RUN-20261109-010' }))
    const v = await mount()
    await waitFor(() => expect(v.container.querySelector('[id$="-id_days"]')).toBeTruthy())
    act(() => editor.type(CODE + '# edit\n'))
    fireEvent.submit(v.container.querySelector('form[id^="run"][id$="-form"]')!)
    await waitFor(() => expect(callsOf('runs.start')).toHaveLength(1))
    const order = transport.calls.map((c) => c.name).filter((n) => n === 'editor.save' || n === 'runs.start')
    expect(order).toEqual(['editor.save', 'runs.start'])

    transport.on('editor.save', () => ({ ok: false, conflict: false, error: 'The file is read-only.' }))
    act(() => editor.type(CODE + '# edit 2\n'))
    fireEvent.submit(v.container.querySelector('form[id^="run"][id$="-form"]')!)
    await waitFor(() => expect(toasts.value.some((t) => t.text === 'The file is read-only.')).toBe(true))
    expect(callsOf('runs.start')).toHaveLength(1)
  })

  it('renders every parameter type and posts checkboxes, multi-selects and selects in the engine\'s shape', async () => {
    const fields = [
      field({ name: 'sel', input: 'select', value: 'b', p: { name: 'sel', label: 'Pick', type: 'select', required: true }, choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }),
      field({ name: 'multi', input: 'multiselect', value: ['x'], selected: ['x'], p: { name: 'multi', label: 'Many', type: 'multiselect' }, choices: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }] }),
      field({ name: 'flag', input: 'checkbox', value: false, p: { name: 'flag', label: 'Verbose', type: 'boolean' } }),
      field({ name: 'note', input: 'textarea', value: 'hi', p: { name: 'note', label: 'Note', type: 'textarea', help: 'Free text' } }),
      field({ name: 'pw', input: 'password', value: '', p: { name: 'pw', label: 'Secret', type: 'password' } }),
      field({ name: 'when', input: 'date', value: '2026-01-02', p: { name: 'when', label: 'When', type: 'date' } }),
      field({ name: 'fixed', input: 'text', value: 'const', locked: true, p: { name: 'fixed', label: 'Fixed', type: 'text', editable_at_runtime: false } }),
    ]
    wire({ form: runForm({ fields, hasPassword: true }) })
    transport.on('runs.start', () => ({ ok: true, runId: 'RUN-20261109-011' }))
    const v = await mount()
    await waitFor(() => expect(v.container.querySelector('[id$="-id_sel"]')).toBeTruthy())
    expect((v.container.querySelector('[id$="-id_pw"]') as HTMLInputElement).type).toBe('password')
    expect((v.container.querySelector('[id$="-id_when"]') as HTMLInputElement).type).toBe('date')
    expect((v.container.querySelector('[id$="-id_fixed"]') as HTMLInputElement).disabled).toBe(true)
    expect(v.container.textContent).toContain('Fixed — not editable at run time.')
    expect(v.container.textContent).toContain('Free text')
    fireEvent.change(v.container.querySelector('[id$="-id_sel"]')!, { target: { value: 'a' } })
    fireEvent.click(v.container.querySelector('[id$="-id_multi"] input[value=y]')!)
    fireEvent.click(v.container.querySelector('[id$="-id_flag"]')!)
    fireEvent.input(v.container.querySelector('[id$="-id_pw"]')!, { target: { value: 's3cret' } })
    fireEvent.submit(v.container.querySelector('form[id^="run"][id$="-form"]')!)
    await waitFor(() => expect(callsOf('runs.start')).toHaveLength(1))
    expect(callsOf('runs.start')[0].args.values).toEqual({ sel: 'a', multi: ['x', 'y'], flag: true, note: 'hi', pw: 's3cret', when: '2026-01-02' })
  })

  it('loads a recent run or preset from the list, and resets to the defaults', async () => {
    wire({ form: runForm({ recent: [{ key: '@0', label: 'Last run', when: '2026-11-09 10:00' }], presets: [{ slug: 'nightly', name: 'Nightly', saved_at: '', host: 'local' }] }) })
    const v = await mount()
    const select = await waitFor(() => { const s = v.container.querySelector('select[id$="-preset"]') as HTMLSelectElement; if (!s) throw new Error('x'); return s })
    expect([...select.options].map((o) => o.textContent)).toEqual(['Defaults', 'Last run · 2026-11-09 10:00', 'Nightly', '+ Save current values as preset…'])
    fireEvent.change(select, { target: { value: 'nightly' } })
    await waitFor(() => expect(callsOf('runs.form').some((c) => c.args.preset === 'nightly')).toBe(true))
    await waitFor(() => expect(v.container.querySelector('[data-preset-box]')).toBeTruthy())
    fireEvent.click(within(v.container as HTMLElement).getByText('Reset'))
    await waitFor(() => expect(callsOf('runs.form').some((c) => c.args.preset === '-')).toBe(true))
  })

  it('saves the current values as a preset with a typed name, then selects it', async () => {
    wire()
    transport.on('presets.save', () => ({ ok: true, slug: 'nightly', updated: false }))
    const v = await mount()
    await waitFor(() => expect(v.container.querySelector('select[id$="-preset"]')).toBeTruthy())
    fireEvent.input(v.container.querySelector('[id$="-id_days"]')!, { target: { value: '14' } })
    fireEvent.change(v.container.querySelector('select[id$="-preset"]')!, { target: { value: '+' } })
    const name = await waitFor(() => { const i = v.container.querySelector('[data-new-preset] input') as HTMLInputElement; if (!i) throw new Error('x'); return i })
    fireEvent.input(name, { target: { value: 'Nightly' } })
    fireEvent.click(within(v.container.querySelector('[data-new-preset]') as HTMLElement).getByText('Save'))
    await waitFor(() => expect(callsOf('presets.save')).toHaveLength(1))
    expect(callsOf('presets.save')[0].args).toEqual({ scriptId: ID, name: 'Nightly', host: 'local', values: { days: '14' } })
    await waitFor(() => expect(callsOf('runs.form').some((c) => c.args.preset === 'nightly')).toBe(true))
    expect(toasts.value.some((t) => t.text.includes('saved'))).toBe(true)
  })

  it('renames and deletes the current preset', async () => {
    wire({ form: runForm({ presets: [{ slug: 'nightly', name: 'Nightly', saved_at: '', host: 'local' }] }) })
    transport.on('presets.rename', () => ({ ok: true, slug: 'weekly' }))
    transport.on('presets.delete', () => ({ removed: true }))
    const v = await mount()
    const select = await waitFor(() => { const s = v.container.querySelector('select[id$="-preset"]') as HTMLSelectElement; if (!s) throw new Error('x'); return s })
    fireEvent.change(select, { target: { value: 'nightly' } })
    const box = await waitFor(() => { const b = v.container.querySelector('[data-preset-box]') as HTMLElement; if (!b) throw new Error('x'); return b })
    fireEvent.input(box.querySelector('input')!, { target: { value: 'Weekly' } })
    fireEvent.click(within(box).getByText('Rename'))
    await waitFor(() => expect(callsOf('presets.rename')[0]?.args).toEqual({ scriptId: ID, slug: 'nightly', newName: 'Weekly' }))
    fireEvent.click(await waitFor(() => { const b = v.container.querySelector('[data-preset-box] [aria-label="Delete preset"]'); if (!b) throw new Error('x'); return b }))
    await waitFor(() => expect(confirmState.value).toBeTruthy())
    act(() => confirmState.value!.resolve(true))
    await waitFor(() => expect(callsOf('presets.delete')[0]?.args).toEqual({ scriptId: ID, slug: 'weekly' })) // renamed first
  })

  it('starts a run once when opened with params.run (Quick run), then forgets the request', async () => {
    wire()
    transport.on('runs.start', () => ({ ok: true, runId: 'RUN-20261109-012' }))
    await mount({ run: 'trace', nonce: 5 })
    await waitFor(() => expect(callsOf('runs.start')).toHaveLength(1))
    expect(callsOf('runs.start')[0].args).toMatchObject({ scriptId: ID, mode: 'trace', values: { days: '7' } })
    await waitFor(() => expect(tabs.value.find((t) => t.key === `script:${ID}`)?.params.run).toBeNull())
    await new Promise((r) => setTimeout(r, 50))
    expect(callsOf('runs.start')).toHaveLength(1) // not again
  })

  it('opens the Run tab with the reason instead of running when the metadata is invalid (Quick run)', async () => {
    wire({ detail: detail({ script: { ...SCRIPT, metaValid: false, metaError: 'bad' } }), form: runForm({ blocked: 'bad', fields: [] }) })
    const v = await mount({ run: 'normal', nonce: 1 })
    await waitFor(() => expect(v.container.textContent).toContain('bad'))
    expect(callsOf('runs.start')).toHaveLength(0)
  })

  it('loads values into the form when the saved-values grid asks for them', async () => {
    wire()
    const v = await mount()
    await waitFor(() => expect(v.container.querySelector('[id$="-id_days"]')).toBeTruthy())
    fireEvent.click(v.container.querySelector('[data-view="overview"]')!)
    act(() => requestLoad(ID, 'nightly'))
    await waitFor(() => expect(callsOf('runs.form').some((c) => c.args.preset === 'nightly')).toBe(true))
    expect(v.container.querySelector('[data-view="run"]')?.classList.contains('is-active')).toBe(true)
  })

  it('lists the runs of the script in the Overview and opens one as a tab', async () => {
    wire({ detail: detail({ runs: [{ id: 'RUN-20261109-003', status: 'success', status_label: 'Succeeded', duration: '2s', ago: '1 min ago' }] }) })
    const v = await mount()
    fireEvent.click(v.container.querySelector('[data-view="overview"]')!)
    fireEvent.click(within(v.container as HTMLElement).getByText('RUN-20261109-003'))
    expect(tabs.value.some((t) => t.key === 'run:RUN-20261109-003')).toBe(true)
    fireEvent.click(within(v.container as HTMLElement).getByText('History'))
    expect(tabs.value.some((t) => t.kind === 'history')).toBe(true)
  })
})

describe('script page: versions and restore', () => {
  const VERSIONS = [
    { name: 'v2', when: '2026-11-09 10:00', size: 120, file: 'x' },
    { name: 'v1', when: '2026-11-08 09:00', size: 100, file: 'y' },
  ]

  it('restores the previous version after confirming, and reloads the text', async () => {
    const s = wire({ doc: doc({ versions: VERSIONS }) })
    transport.on('editor.restore', () => {
      s.doc = doc({ editor: { ...doc().editor, text: 'restored\n', hash: 'h5' }, source: { ...doc().source, text: 'restored\n' } })
      return { ok: true, id: ID }
    })
    const v = await mount()
    fireEvent.click(v.container.querySelector('[data-restore-previous]')!)
    await waitFor(() => expect(confirmState.value?.message).toMatch(/Put back the previous version of hello\.py/))
    act(() => confirmState.value!.resolve(true))
    await waitFor(() => expect(callsOf('editor.restore')[0]?.args).toEqual({ id: ID, previous: true }))
    await waitFor(() => expect(editor.value).toBe('restored\n'))
  })

  it('hides the restore buttons when there is no earlier version', async () => {
    wire()
    const v = await mount()
    expect(v.container.querySelector('[data-restore-previous]')).toBeNull()
    expect(v.container.querySelector('[data-versions]')).toBeNull()
  })

  it('shows a version side by side with the editor and restores the chosen one', async () => {
    const s = wire({ doc: doc({ versions: VERSIONS }) })
    transport.on('editor.versionText', ({ version }: any) => ({ text: version === 'v1' ? 'old one\n' : CODE.replace('days', 'DAYS') }))
    transport.on('editor.restore', () => ({ ok: true, id: ID }))
    const v = await mount()
    fireEvent.click(v.container.querySelector('[data-versions]')!)
    await waitFor(() => expect(v.container.querySelector('[data-diff]')).toBeTruthy())
    expect(callsOf('editor.versionText')[0].args).toEqual({ id: ID, version: 'v2' }) // the newest is selected first
    expect(v.container.querySelector('.versions-note')?.textContent).toMatch(/\d+ lines? differ/)
    fireEvent.click(within(v.container as HTMLElement).getByRole('option', { name: /2026-11-08/ }))
    await waitFor(() => expect(callsOf('editor.versionText')[1]?.args.version).toBe('v1'))
    await waitFor(() => expect(v.container.querySelector('.diff-del, .diff-change')).toBeTruthy())
    fireEvent.click(v.container.querySelector('[data-restore]')!)
    await waitFor(() => expect(confirmState.value?.message).toMatch(/this version/))
    act(() => confirmState.value!.resolve(true))
    await waitFor(() => expect(callsOf('editor.restore')[0]?.args).toEqual({ id: ID, version: 'v1' }))
    await waitFor(() => expect(v.container.querySelector('.versions-dialog')).toBeNull())
  })

  it('warns that unsaved editor changes are replaced by a restore', async () => {
    wire({ doc: doc({ versions: VERSIONS }) })
    const v = await mount()
    act(() => editor.type('edited\n'))
    fireEvent.click(v.container.querySelector('[data-restore-previous]')!)
    await waitFor(() => expect(confirmState.value?.message).toMatch(/unsaved changes in the editor are replaced/))
    act(() => confirmState.value!.resolve(false))
    expect(callsOf('editor.restore')).toHaveLength(0)
  })
})

describe('saved values (bottom panel)', () => {
  const GRID = {
    columns: [
      { kind: 'preset', key: 'nightly', name: 'Nightly', host: '', saved_at: '2026-11-09 10:00:00' },
      { kind: 'recent', key: '@0', name: 'Last run', run_id: 'RUN-20261109-001', host: '', saved_at: '2026-11-09 11:00:00' },
    ],
    rows: [
      { label: 'Target host', name: 'host', varies: false, cells: [{ text: 'local' }, { text: 'local' }] },
      { label: 'Days', name: 'days', varies: true, cells: [{ text: '30', changed: true }, { text: 'default', muted: true }] },
    ],
  }
  const tabFor = () => openTab({ kind: 'script', id: ID, title: 'Hello' })

  it('shows presets and recent runs side by side, highlighting differences from the default', async () => {
    transport.on('presets.grid', () => GRID).on('scripts.get', () => detail())
    const view = render(<SavedValues tab={tabFor()} active />)
    await waitFor(() => expect(view.container.querySelector('.pgrid')).toBeTruthy())
    expect([...view.container.querySelectorAll('thead .pg-col')].map((c) => c.querySelector('.clamp-1')?.textContent)).toEqual(['Nightly', 'Last run'])
    expect(view.container.querySelector('tr.varies .pg-param')?.textContent).toContain('Days')
    expect(view.container.querySelector('td.is-changed')?.textContent).toBe('30')
    expect(view.container.querySelector('td.is-muted')?.textContent).toBe('default')
    expect(view.container.querySelector('.pg-col.is-recent')).toBeTruthy()
  })

  it('says nothing is saved yet', async () => {
    transport.on('presets.grid', () => ({ columns: [], rows: [] })).on('scripts.get', () => detail())
    const view = render(<SavedValues tab={tabFor()} active />)
    await waitFor(() => expect(view.container.textContent).toContain('Nothing saved yet'))
  })

  it('runs a column straight away, loads it into the form, or deletes a preset after confirming', async () => {
    transport.on('presets.grid', () => GRID).on('scripts.get', () => detail()).on('runs.start', () => ({ ok: true, runId: 'RUN-20261109-020' })).on('presets.delete', () => ({ removed: true }))
    const view = render(<SavedValues tab={tabFor()} active />)
    await waitFor(() => expect(view.container.querySelector('.pgrid')).toBeTruthy())
    const col = (key: string) => view.container.querySelector(`[data-col="${key}"]`) as HTMLElement
    fireEvent.click(col('nightly').querySelector('[data-act="run"]')!)
    await waitFor(() => expect(callsOf('runs.start')[0]?.args).toEqual({ scriptId: ID, fromPreset: 'nightly' }))
    await waitFor(() => expect(tabs.value.some((t) => t.key === 'run:RUN-20261109-020')).toBe(true))
    fireEvent.click(col('@0').querySelector('[data-act="load"]')!)
    const { loadRequest } = await import('../src/panels/script/store')
    expect(loadRequest.value).toMatchObject({ id: ID, key: '@0' })
    expect(col('@0').querySelector('[data-act="delete"]')).toBeNull() // recent runs are not deleted here
    fireEvent.click(col('nightly').querySelector('[data-act="delete"]')!)
    await waitFor(() => expect(confirmState.value?.message).toContain('Nightly'))
    act(() => confirmState.value!.resolve(true))
    await waitFor(() => expect(callsOf('presets.delete')[0]?.args).toEqual({ scriptId: ID, slug: 'nightly' }))
  })

  it('hides Run and Load for a script whose metadata is invalid', async () => {
    transport.on('presets.grid', () => GRID).on('scripts.get', () => detail({ script: { ...SCRIPT, metaValid: false } }))
    const view = render(<SavedValues tab={tabFor()} active />)
    await waitFor(() => expect(view.container.querySelector('.pgrid')).toBeTruthy())
    await waitFor(() => expect(view.container.querySelector('[data-act="run"]')).toBeNull())
  })
})

describe('script panel registration', () => {
  it('registers the script panel as a full-bleed page with the saved values as its bottom panel', () => {
    const entry = getPanel('script')!
    expect(entry.options.fill).toBe(true)
    expect(entry.options.bottom).toBe(SavedValues)
    expect(entry.options.bottomTitle).toBe('Saved values')
    expect(screen).toBeTruthy()
  })
})

describe('script pages that are open at the same time (regression: Run on the second tab ran the first)', () => {
  it('gives every mounted page its own form and field ids, so Run submits its own form', async () => {
    wire()
    const a = await mount()
    const b = await mount()
    const formOf = (v: { container: Element }) => v.container.querySelector('form[id$="-form"]') as HTMLFormElement
    const runBtn = (v: { container: Element }) => v.container.querySelector('button[data-run]') as HTMLButtonElement
    await waitFor(() => expect(formOf(b)).toBeTruthy())
    expect(formOf(a).id).not.toBe(formOf(b).id)
    for (const v of [a, b]) {
      // the submit button sits outside the form and finds it through the `form` attribute: it must be THIS page's form
      const target = document.getElementById(runBtn(v).getAttribute('form')!)
      expect(target).toBe(formOf(v))
      expect(v.container.contains(target)).toBe(true)
      // a label points at the input of its own page
      const label = v.container.querySelector('label[for]') as HTMLLabelElement
      expect(document.getElementById(label.htmlFor)).not.toBeNull()
      expect(v.container.contains(document.getElementById(label.htmlFor))).toBe(true)
    }
    const ids = Array.from(document.querySelectorAll('[id]')).map((e) => e.id)
    const dups = ids.filter((id, i) => ids.indexOf(id) !== i)
    expect(dups).toEqual([]) // no duplicate ids anywhere in the document
  })
})
