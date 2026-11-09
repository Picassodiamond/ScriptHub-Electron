import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact'
import { afterEach, describe, expect, it } from 'vitest'
import '../src/panels'
import { startApp } from '../src/bootstrap'
import { onCommand } from '../src/core/bus'
import { confirm } from '../src/core/confirm'
import { activeKey, activeTab, closeTab, loadWorkspaceTabs, moveTab, openTab, pruneTabs, tabs } from '../src/core/tabs'
import { toast } from '../src/core/toast'
import { toasts } from '../src/core/toast'
import { App } from '../src/shell/App'
import { transport } from './setup'

let stop: (() => void) | null = null
async function mount() {
  const view = render(<App />)
  stop = await startApp()
  await waitFor(() => expect(screen.getAllByText('Hello World').length).toBeGreaterThan(0))
  return view
}
afterEach(() => { stop?.(); stop = null })

const tree = () => within(document.getElementById('tree') as HTMLElement)
const key = (k: string, o: KeyboardEventInit = {}, target: Element | Document = document.body) => fireEvent.keyDown(target, { key: k, ...o })
const tabTitles = () => tabs.value.map((t) => t.title)

describe('workbench shell', () => {
  it('starts on Home, shows the explorer tree and the status bar', async () => {
    await mount()
    expect(tabTitles()).toEqual(['Home'])
    expect(activeTab.value?.kind).toBe('home')
    expect(tree().getByText('General')).toBeTruthy()
    expect(tree().getByText('Ping Hosts')).toBeTruthy()
    expect(screen.getByText(/0 running · 0 queued/)).toBeTruthy()
    expect(document.title).toContain('scripts')
    expect(document.querySelector('.menubar')).toBeTruthy() // browser: no native menu
  })

  it('opens a script from the explorer as a tab, activates it again instead of duplicating, and closes it', async () => {
    await mount()
    fireEvent.click(tree().getByText('Hello World'))
    expect(tabTitles()).toEqual(['Home', 'Hello World'])
    expect(activeKey.value).toBe('script:aaaaaaaaaaaa')
    fireEvent.click(tree().getByText('Disk Report'))
    fireEvent.click(tree().getByText('Hello World'))
    expect(tabTitles()).toEqual(['Home', 'Hello World', 'Disk Report'])
    expect(activeKey.value).toBe('script:aaaaaaaaaaaa')
    // the panel of an inactive tab stays mounted but hidden
    expect(document.querySelectorAll('.tab-panel').length).toBe(3)
    expect(document.querySelectorAll('.tab-panel[hidden]').length).toBe(2)
    fireEvent.click(screen.getByLabelText('Close Hello World'))
    expect(tabTitles()).toEqual(['Home', 'Disk Report'])
    expect(activeKey.value).toBe('script:bbbbbbbbbbbb') // the neighbour takes over
  })

  it('closes a tab with the middle button and with Ctrl+W', async () => {
    await mount()
    fireEvent.click(tree().getByText('Hello World'))
    fireEvent.click(tree().getByText('Disk Report'))
    fireEvent(screen.getByRole('tab', { name: /Hello World/ }), new MouseEvent('auxclick', { button: 1, bubbles: true }))
    expect(tabTitles()).toEqual(['Home', 'Disk Report'])
    key('w', { ctrlKey: true })
    expect(tabTitles()).toEqual(['Home'])
  })

  it('reorders tabs by drag and drop', async () => {
    await mount()
    fireEvent.click(tree().getByText('Hello World'))
    fireEvent.click(tree().getByText('Disk Report'))
    const tabEls = screen.getAllByRole('tab')
    fireEvent.dragStart(tabEls[2], { dataTransfer: { setData() {} } })
    fireEvent.dragOver(tabEls[0])
    fireEvent.drop(tabEls[0])
    expect(tabTitles()).toEqual(['Disk Report', 'Home', 'Hello World'])
    moveTab(0, 2)
    expect(tabTitles()).toEqual(['Home', 'Hello World', 'Disk Report'])
  })

  it('remembers the open tabs per workspace in localStorage', async () => {
    await mount()
    fireEvent.click(tree().getByText('Ping Hosts'))
    const raw = JSON.parse(localStorage.getItem('scripthub.openTabs.C:\\scripts')!)
    expect(raw.tabs.map((t: any) => t.kind + ':' + (t.id ?? ''))).toEqual(['home:', 'script:cccccccccccc'])
    expect(raw.active).toBe('script:cccccccccccc')
    // another workspace has its own list; coming back restores this one
    loadWorkspaceTabs('D:\\other')
    expect(tabTitles()).toEqual(['Home'])
    loadWorkspaceTabs('C:\\scripts')
    expect(tabTitles()).toEqual(['Home', 'Ping Hosts'])
    expect(activeKey.value).toBe('script:cccccccccccc')
  })

  it('drops tabs of scripts that no longer exist', async () => {
    await mount()
    openTab({ kind: 'script', id: 'ffffffffffff', title: 'Gone' })
    openTab({ kind: 'sequence', id: 'nightly', title: 'Nightly' })
    pruneTabs({ script: new Set(['aaaaaaaaaaaa']), sequence: new Set(['nightly']) })
    expect(tabTitles()).toEqual(['Home', 'Nightly'])
  })

  it('opens the script panel from the registry when a script is clicked in the explorer', async () => {
    await mount()
    fireEvent.click(tree().getByText('Hello World'))
    const panel = document.querySelector('.tab-panel[data-kind="script"]') as HTMLElement
    expect(panel).toBeTruthy()
    expect(within(panel).queryByText('placeholder')).toBeNull() // a real panel, not the stand-in
  })

  it('filters the explorer', async () => {
    await mount()
    fireEvent.input(screen.getByLabelText('Filter scripts'), { target: { value: 'ping' } })
    expect(tree().queryByText('Hello World')).toBeNull()
    expect(tree().getByText('Ping Hosts')).toBeTruthy()
    fireEvent.input(screen.getByLabelText('Filter scripts'), { target: { value: 'zzz' } })
    expect(tree().getByText('No match.')).toBeTruthy()
  })
})

describe('command palette', () => {
  it('opens with Ctrl+K, filters, and Enter opens the chosen script', async () => {
    await mount()
    key('k', { ctrlKey: true })
    const input = await screen.findByLabelText('Command palette')
    fireEvent.input(input, { target: { value: 'disk' } })
    expect(document.querySelectorAll('.pal-item').length).toBe(1)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(tabTitles()).toContain('Disk Report')
    expect(document.querySelector('.palette')).toBeNull() // closed
  })

  it('lists commands, folders and sequences, supports > for commands only and arrow keys', async () => {
    await mount()
    key('k', { ctrlKey: true })
    const input = await screen.findByLabelText('Command palette')
    const groups = [...document.querySelectorAll('.pal-group')].map((g) => g.textContent)
    expect(groups).toEqual(expect.arrayContaining(['Scripts', 'Sequences', 'Folders', 'Commands']))
    fireEvent.input(input, { target: { value: '>theme' } })
    expect([...document.querySelectorAll('.pal-item .pal-text')].map((e) => e.textContent)).toEqual(['Light / dark theme'])
    fireEvent.input(input, { target: { value: 'o' } })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(document.querySelectorAll('.pal-item')[1].classList.contains('is-sel')).toBe(true)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(document.querySelector('.palette')).toBeNull()
  })

  it('Ctrl+K toggles it closed again and clicking outside closes it', async () => {
    await mount()
    key('k', { ctrlKey: true })
    await screen.findByLabelText('Command palette')
    key('k', { ctrlKey: true })
    expect(document.querySelector('.palette')).toBeNull()
    key('k', { ctrlKey: true })
    fireEvent.mouseDown(document.querySelector('.overlay')!)
    expect(document.querySelector('.palette')).toBeNull()
  })
})

describe('hotkeys', () => {
  it('runs chords (g l), single keys (?) and Ctrl combinations', async () => {
    await mount()
    key('g')
    key('s')
    expect(activeTab.value?.kind).toBe('settings')
    key('g')
    key('o')
    expect(activeTab.value?.kind).toBe('home')
    key('?')
    expect(document.querySelector('[aria-label="Keyboard shortcuts"].dialog')).toBeTruthy()
    key('Escape')
    key('b', { ctrlKey: true })
    expect(document.documentElement.classList.contains('side-off')).toBe(true)
    key('b', { ctrlKey: true })
    expect(document.documentElement.classList.contains('side-off')).toBe(false)
  })

  it('does not treat plain keys as shortcuts while typing, but Ctrl+Enter still runs', async () => {
    await mount()
    const filter = screen.getByLabelText('Filter scripts')
    key('g', {}, filter)
    key('s', {}, filter)
    expect(activeTab.value?.kind).toBe('home')
    fireEvent.click(tree().getByText('Hello World'))
    const runs: any[] = []
    const off = onCommand('run.run', (p) => runs.push(p))
    key('Enter', { ctrlKey: true }, filter)
    key('r')
    off()
    expect(runs.map((r) => r.mode)).toEqual(['normal', 'normal'])
    expect(runs[0].tab.id).toBe('aaaaaaaaaaaa')
  })

  it('says so when Run is used without a script page', async () => {
    await mount()
    key('r')
    expect(toasts.value.map((t) => t.text)).toContain('Open a script or a sequence first.')
  })

  it('an unfinished chord is forgotten after a second', async () => {
    await mount()
    key('g')
    await new Promise((r) => setTimeout(r, 1100))
    key('s')
    expect(activeTab.value?.kind).toBe('home')
  })
})

describe('menu bar', () => {
  it('opens on click, switches on hover, closes on Escape, and runs the item', async () => {
    await mount()
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }))
    expect(screen.getByText('Open folder…')).toBeTruthy()
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'View' }))
    expect(screen.queryByText('Open folder…')).toBeNull()
    expect(screen.getByText('Command palette')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('Command palette')).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }))
    fireEvent.click(within(document.querySelector('.menu') as HTMLElement).getByText('Settings'))
    expect(activeTab.value?.kind).toBe('settings')
    expect(screen.queryByText('Open folder…')).toBeNull() // the menu closed
  })

  it('does not hover-switch while no menu is open, shows shortcuts and disables unavailable items', async () => {
    await mount()
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'View' }))
    expect(screen.queryByText('Command palette')).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Run' }))
    const run = screen.getByText('Run script').closest('.menu-item')!
    expect(run.classList.contains('is-disabled')).toBe(true) // no script page is active
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'View' }))
    expect(within(screen.getByText('Home', { selector: '.menu span' }).closest('.menu-item') as HTMLElement).getByText('g o')).toBeTruthy()
  })

  it('F10 opens the first menu', async () => {
    await mount()
    key('F10')
    expect(await screen.findByText('Open folder…')).toBeTruthy()
  })
})

describe('desktop mode', () => {
  it('hides the HTML menu bar when the host has a native menu', async () => {
    ;(transport.handlers as any)['host.info'] = () => ({ desktop: true, nativeMenu: true, platform: 'win32' })
    await mount()
    expect(document.querySelector('.menubar')).toBeNull()
    expect(document.documentElement.style.getPropertyValue('--mb-h')).toBe('0px')
  })

  it('runs commands sent by the native menu, opens dropped paths, and shows host messages', async () => {
    await mount()
    transport.emit('app.command', { name: 'view.sequences' })
    await waitFor(() => expect(activeTab.value?.kind).toBe('sequences'))
    transport.on('workspace.open', ({ paths }: any) => ({ opened: paths, errors: [], scripts: 1, problems: [], finished: true, scriptId: null }))
    transport.emit('app.drop', { paths: ['C:\\dropped\\folder'] })
    await waitFor(() => expect(transport.count('workspace.open')).toBe(1))
    await waitFor(() => expect(toasts.value.map((t) => t.text)).toContain('Opened folder'))
    transport.emit('app.toast', { kind: 'error', text: 'Could not save' })
    expect(toasts.value.at(-1)).toMatchObject({ kind: 'error', text: 'Could not save' })
  })
})

describe('overlays', () => {
  it('toasts hide themselves (success) or stay (error) and can be dismissed', async () => {
    await mount()
    toast.error('Broken')
    toast.info('Fine')
    expect(await screen.findByText('Broken')).toBeTruthy()
    fireEvent.click(within(screen.getByText('Broken').parentElement as HTMLElement).getByLabelText('Dismiss'))
    expect(screen.queryByText('Broken')).toBeNull()
    expect(screen.getByText('Fine')).toBeTruthy()
  })

  it('confirm resolves true on OK and false on Cancel or Escape', async () => {
    await mount()
    const yes = confirm({ title: 'Delete', message: 'Delete it?', confirmLabel: 'Delete', danger: true })
    fireEvent.click(await screen.findByText('Delete', { selector: 'button' }))
    expect(await yes).toBe(true)
    const no = confirm({ message: 'Sure?' })
    fireEvent.click(await screen.findByText('Cancel'))
    expect(await no).toBe(false)
    const esc = confirm({ message: 'Again?' })
    await screen.findByText('Again?')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(await esc).toBe(false)
    expect(document.querySelector('.dialog')).toBeNull()
  })

  it('toggles the theme and remembers it', async () => {
    await mount()
    const before = document.documentElement.getAttribute('data-theme')
    fireEvent.click(screen.getByLabelText('Toggle theme'))
    const after = document.documentElement.getAttribute('data-theme')
    expect(after).not.toBe(before)
    expect(localStorage.getItem('sr.theme')).toBe(after)
  })

  it('closing a tab through the context menu works', async () => {
    await mount()
    fireEvent.click(tree().getByText('Hello World'))
    fireEvent.contextMenu(screen.getByRole('tab', { name: /Hello World/ }))
    fireEvent.click(screen.getByText('Close others'))
    expect(tabTitles()).toEqual(['Hello World'])
    closeTab('script:aaaaaaaaaaaa')
    expect(tabs.value).toEqual([])
    expect(await screen.findByText('No page is open')).toBeTruthy()
  })
})
