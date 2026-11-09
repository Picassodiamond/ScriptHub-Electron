import { demoShell } from '@scripthub/client'
import type { ScriptDto } from '@scripthub/protocol'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import '../src/panels/library'
import { getPanel } from '../src/core/panels'
import { scan, shell } from '../src/core/shellState'
import { activeTab } from '../src/core/tabs'
import { toasts } from '../src/core/toast'
import { groupScripts, matches } from '../src/panels/library/LibraryPanel'
import { transport } from './setup'

const script = (id: string, name: string, over: Partial<ScriptDto> = {}): ScriptDto => ({
  id, name, path: `C:\\scripts\\${name}.py`, root: 'C:\\scripts', relative: `${name.toLowerCase()}.py`, location: 'C:\\scripts', category: 'General', description: `${name} does things`,
  extension: '.py', ext: 'py', interpreter: 'python', language: 'python', languageLabel: 'Python', platforms: ['windows', 'linux', 'macos'], platformLabels: ['Windows', 'Linux', 'macOS'],
  metaValid: true, metaError: null, parameterCount: 2, idConflict: '', pathId: id, lastRun: null, ...over,
})
const SCRIPTS = [
  script('aaaaaaaaaaaa', 'Backup', { category: 'Ops', lastRun: { id: 'RUN-20261109-001', status: 'success', label: 'Succeeded', ago: '2 min ago' } }),
  script('bbbbbbbbbbbb', 'Disk Report', { category: 'Ops', language: 'shell', languageLabel: 'Shell', ext: 'sh', extension: '.sh', platforms: ['linux', 'macos'], platformLabels: ['Linux', 'macOS'], interpreter: 'bash' }),
  script('cccccccccccc', 'Ping Hosts', { category: 'Network', parameterCount: 0 }),
  script('dddddddddddd', 'Broken', { category: 'Network', metaValid: false, metaError: 'parameters: bad value' }),
]
const state = (scripts = SCRIPTS, over: Record<string, any> = {}) => ({
  scripts, problems: [], categories: ['Network', 'Ops'], languages: [['python', 'Python'], ['shell', 'Shell']], platforms: [['windows', 'Windows'], ['linux', 'Linux'], ['macos', 'macOS']], interpreters: ['python', 'bash'], ...over,
})

function mount(active = true) {
  shell.value = demoShell()
  const Panel = getPanel('library')!.component
  return render(<Panel tab={{ key: 'library:', kind: 'library', title: 'Library', icon: 'list', params: {} }} active={active} />)
}
const ready = async () => { mount(); await screen.findByText('Backup') }
const names = () => [...document.querySelectorAll('[data-lib-item]')].map((e) => e.querySelector('a.plain')?.textContent)
const groupNames = () => [...document.querySelectorAll('[data-group]')].map((e) => (e as HTMLElement).dataset.group)

describe('Library panel', () => {
  it('groups the scripts by category with counts, favourites first, and shows last runs', async () => {
    transport.on('scripts.list', () => state())
    await ready()
    expect(groupNames()).toEqual(['Network', 'Ops'])
    expect(names()).toEqual(['Broken', 'Ping Hosts', 'Backup', 'Disk Report'])
    expect(screen.getByText('4 scripts')).toBeTruthy()
    const ops = document.querySelector('[data-group="Ops"]') as HTMLElement
    expect(ops.querySelector('.tree-count')?.textContent).toBe('2') // group count
    const link = within(ops).getByText('Succeeded')
    fireEvent.click(link)
    expect(activeTab.value).toMatchObject({ kind: 'run', id: 'RUN-20261109-001', params: { scriptId: 'aaaaaaaaaaaa' } })
    expect(screen.getByText('⚠ parameters: bad value')).toBeTruthy()
  })

  it('searches name, description and path; filters by category, platform and language; clears', async () => {
    transport.on('scripts.list', () => state())
    await ready()
    fireEvent.input(screen.getByLabelText('Search scripts'), { target: { value: 'ping' } })
    expect(names()).toEqual(['Ping Hosts'])
    expect(screen.getByText('1 of 4 shown')).toBeTruthy()
    fireEvent.click(screen.getByText('Clear'))
    expect(names().length).toBe(4)
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Ops' } })
    expect(names()).toEqual(['Backup', 'Disk Report'])
    fireEvent.change(screen.getByLabelText('Platform'), { target: { value: 'windows' } })
    expect(names()).toEqual(['Backup'])
    fireEvent.change(screen.getByLabelText('Platform'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'shell' } })
    expect(names()).toEqual(['Disk Report'])
    fireEvent.input(screen.getByLabelText('Search scripts'), { target: { value: 'nothing-matches' } })
    expect(await screen.findByText('No scripts match')).toBeTruthy()
    fireEvent.click(screen.getByText('clear the filters'))
    expect(names().length).toBe(4)
  })

  it('favourites: star toggles, persists on this machine, and filters', async () => {
    transport.on('scripts.list', () => state())
    await ready()
    fireEvent.click(screen.getByLabelText('Favourite Disk Report'))
    expect(JSON.parse(localStorage.getItem('scripthub.library.favorites')!)).toEqual(['bbbbbbbbbbbb'])
    expect(names()).toEqual(['Broken', 'Ping Hosts', 'Disk Report', 'Backup']) // favourite first within its category
    expect(screen.getByLabelText('Unfavourite Disk Report').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByText('Favourites'))
    expect(names()).toEqual(['Disk Report'])
    document.body.innerHTML = '' // remembered by a fresh panel
    mount()
    await screen.findByText('Backup')
    expect(screen.getByLabelText('Unfavourite Disk Report')).toBeTruthy()
  })

  it('collapses a category and remembers it; switches between table and cards and remembers that', async () => {
    transport.on('scripts.list', () => state())
    await ready()
    fireEvent.click(document.querySelector('[data-group="Network"] .tree-summary')!)
    expect(names()).toEqual(['Backup', 'Disk Report'])
    expect(JSON.parse(localStorage.getItem('scripthub.library.collapsed')!)).toEqual(['Network'])
    fireEvent.click(screen.getByLabelText('Cards'))
    expect(document.querySelector('#view-cards')).toBeTruthy()
    expect(document.querySelector('#view-table')).toBeNull()
    expect(document.querySelectorAll('article.sc').length).toBe(2) // Network is still collapsed
    expect(localStorage.getItem('sr.view')).toBe('cards')
    fireEvent.click(screen.getByLabelText('Table'))
    expect(document.querySelector('#view-table')).toBeTruthy()
  })

  it('Run opens the Run form of the script, Fix opens a script with bad metadata, names open the script', async () => {
    transport.on('scripts.list', () => state())
    await ready()
    const row = (name: string) => [...document.querySelectorAll<HTMLElement>('[data-lib-item]')].find((e) => e.querySelector('a.plain')?.textContent === name)!
    fireEvent.click(within(row('Backup')).getByText('Run'))
    expect(activeTab.value).toMatchObject({ kind: 'script', id: 'aaaaaaaaaaaa', params: { view: 'run' } })
    fireEvent.click(within(row('Broken')).getByText('Fix'))
    expect(activeTab.value).toMatchObject({ kind: 'script', id: 'dddddddddddd' })
    expect(activeTab.value?.params.view).toBeUndefined()
    fireEvent.click(screen.getByText('Ping Hosts'))
    expect(activeTab.value).toMatchObject({ kind: 'script', id: 'cccccccccccc', title: 'Ping Hosts' })
  })

  it('offers the edit button only while editing is enabled', async () => {
    transport.on('scripts.list', () => state())
    await ready()
    expect(screen.getAllByLabelText('Edit Backup').length).toBe(1)
    document.body.innerHTML = ''
    const Panel = getPanel('library')!.component
    shell.value = demoShell({ editingEnabled: false })
    render(<Panel tab={{ key: 'library:', kind: 'library', title: 'Library', icon: '', params: {} }} active />)
    await screen.findByText('Backup')
    expect(screen.queryByLabelText('Edit Backup')).toBeNull()
  })

  it('lists the problems of the scan and rescans on request', async () => {
    transport.on('scripts.list', () => state(SCRIPTS, { problems: ['Not scanned, more than 3 folder levels deep: C:\\scripts\\a\\b\\c\\d'] }))
    transport.on('workspace.rescan', () => ({ count: 4, problems: [], finished: true }))
    await ready()
    expect(screen.getByText(/more than 3 folder levels deep/)).toBeTruthy()
    const before = transport.count('scripts.list')
    fireEvent.click(screen.getByLabelText('Rescan'))
    await waitFor(() => expect(transport.count('workspace.rescan')).toBe(1))
    await waitFor(() => expect(transport.count('scripts.list')).toBeGreaterThan(before))
    expect(toasts.value.some((t) => t.text === 'Found 4 scripts.')).toBe(true)
  })

  it('reloads when a scan finishes with a different list (scan version)', async () => {
    let list = SCRIPTS
    transport.on('scripts.list', () => state(list))
    await ready()
    list = [...SCRIPTS, script('eeeeeeeeeeee', 'Fresh One')]
    act(() => { scan.value = { scanning: false, version: 7, count: 5 } })
    expect(await screen.findByText('Fresh One')).toBeTruthy()
  })

  it('keyboard: / focuses search, arrows move, Enter opens, f favourites', async () => {
    transport.on('scripts.list', () => state())
    await ready()
    fireEvent.keyDown(window, { key: '/' })
    expect(document.activeElement).toBe(screen.getByLabelText('Search scripts'))
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(document.querySelector('.is-focus [data-x], tr.is-focus')?.textContent).toContain('Ping Hosts')
    fireEvent.keyDown(window, { key: 'f' })
    expect(JSON.parse(localStorage.getItem('scripthub.library.favorites')!)).toEqual(['cccccccccccc'])
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(activeTab.value).toMatchObject({ kind: 'script', id: 'cccccccccccc' })
  })

  it('empty states: no folder, an empty folder, and a folder with scripts missing a known extension', async () => {
    transport.on('scripts.list', () => state([], { categories: [] }))
    const Panel = getPanel('library')!.component
    shell.value = demoShell({ folder: { folder: null, files: [], favorites: [], recent: [] } })
    render(<Panel tab={{ key: 'library:', kind: 'library', title: 'Library', icon: '', params: {} }} active />)
    expect(await screen.findByText('No folder is open. Open a script folder to see its scripts.')).toBeTruthy()
    expect(screen.getByText('Open folder…')).toBeTruthy()
    document.body.innerHTML = ''
    mount()
    expect(await screen.findByText('No scripts found')).toBeTruthy()
    expect(screen.getByText(/Nothing with a known extension in/)).toBeTruthy()
    fireEvent.click(screen.getByText('New script'))
    expect(activeTab.value).toMatchObject({ kind: 'new-script' })
  })

  it('pure helpers: matches and groupScripts', () => {
    const none = { q: '', category: '', platform: '', language: '', favs: false }
    expect(matches(SCRIPTS[1], { ...none, platform: 'windows' }, new Set())).toBe(false)
    expect(matches(SCRIPTS[1], { ...none, q: 'BASH' }, new Set())).toBe(true) // searches the interpreter, case-insensitively
    expect(matches(SCRIPTS[0], { ...none, favs: true }, new Set(['aaaaaaaaaaaa']))).toBe(true)
    expect(groupScripts(SCRIPTS, new Set(['bbbbbbbbbbbb'])).map((g) => [g.name, g.scripts.map((s) => s.name)])).toEqual([
      ['Network', ['Broken', 'Ping Hosts']], ['Ops', ['Disk Report', 'Backup']],
    ])
  })
})
