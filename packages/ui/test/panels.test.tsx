import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact'
import { demoShell, demoTransport } from '@scripthub/client'
import { afterEach, describe, expect, it } from 'vitest'
import '../src/panels'
import { startApp } from '../src/bootstrap'
import { setTransport } from '../src/core/api'
import { activeKey, activeTab, openTab, tabs } from '../src/core/tabs'
import { toasts } from '../src/core/toast'
import { App } from '../src/shell/App'
import { transport } from './setup'

let stop: (() => void) | null = null
async function mount() {
  render(<App />)
  stop = await startApp()
  await waitFor(() => expect(document.querySelector('.tab-panel[data-kind="home"]')).toBeTruthy())
}
afterEach(() => { stop?.(); stop = null })

const home = () => within(document.querySelector('.tab-panel[data-kind="home"]') as HTMLElement)
const stat = (label: string) => home().getAllByText(label).find((e) => e.classList.contains('stat-label'))?.nextElementSibling?.textContent
const callsOf = (name: string) => transport.calls.filter((c) => c.name === name)

describe('Home panel', () => {
  it('shows counts from the engine, recent runs, samples and the most used scripts', async () => {
    transport.on('runs.query', ({ status }: any) => ({ total: status === 'success' ? 12 : 3 }) as any)
    transport.on('runs.recent', () => [{ id: 'RUN-20261109-001', script_id: 'aaaaaaaaaaaa', script_name: 'Hello World', status: 'success', status_label: 'Succeeded', host: 'local', duration: '1s', ago: 'just now' }])
    await mount()
    await waitFor(() => expect(stat('Succeeded')).toBe('12'))
    expect(stat('Failed')).toBe('3')
    expect(stat('Scripts')).toBe('3') // three scripts in the tree
    await waitFor(() => expect(document.querySelector('.tab-panel[data-kind="home"] .st-success')?.textContent).toBe('Succeeded'))
    expect(home().getByText('Sample scripts')).toBeTruthy()
    expect(home().getByText('Maintenance')).toBeTruthy()
    expect(home().queryByText('Open a script folder to start')).toBeNull() // a folder is open
  })

  it('opens the sample scripts folder through the engine and a sample project in its own tab', async () => {
    await mount()
    const samples = home().getByText('Sample scripts') as HTMLButtonElement
    await waitFor(() => expect(samples.disabled).toBe(false)) // enabled once the engine told where the samples are
    fireEvent.click(samples)
    await waitFor(() => expect(callsOf('workspace.open')[0]?.args).toEqual({ paths: ['C:/app/samples/sample_scripts'] }))
    fireEvent.click(home().getByText('Maintenance'))
    expect(activeTab.value).toMatchObject({ kind: 'project-open', params: { sample: 'Maintenance' } })
  })

  it('Quick run opens the script with a run request; the name only opens it', async () => {
    await mount()
    fireEvent.click(home().getAllByText('Run')[0])
    expect(activeTab.value).toMatchObject({ kind: 'script', id: 'aaaaaaaaaaaa', params: { run: 'normal' } })
    expect(typeof activeTab.value?.params.nonce).toBe('number')
  })

  it('welcomes a user without a folder and offers favourites and recent folders', async () => {
    setTransport(demoTransport(demoShell({
      tree: [], palette: [],
      folder: { folder: null, files: [], favorites: [{ path: 'C:\\ops', name: 'ops', exists: true, is_file: false, favorite: true, is_open: false }],
        recent: [{ path: 'C:\\old', name: 'old', exists: true, is_file: false, favorite: false, is_open: false }, { path: 'C:\\gone', name: 'gone', exists: false, is_file: false, favorite: false, is_open: false }] },
    })))
    const t = demoTransport(demoShell({ tree: [], palette: [], folder: { folder: null, files: [], favorites: [{ path: 'C:\\ops', name: 'ops', exists: true, is_file: false, favorite: true, is_open: false }], recent: [{ path: 'C:\\old', name: 'old', exists: true, is_file: false, favorite: false, is_open: false }, { path: 'C:\\gone', name: 'gone', exists: false, is_file: false, favorite: false, is_open: false }] } }))
    t.on('workspace.open', ({ paths }: any) => ({ opened: paths, errors: [], scripts: 0, problems: [], finished: true, scriptId: null }))
    setTransport(t)
    await mount()
    expect(await home().findByText('Open a script folder to start')).toBeTruthy()
    expect(home().getByText('ops')).toBeTruthy()
    expect(home().getByText('old')).toBeTruthy()
    expect(home().queryByText('gone')).toBeNull() // missing folders are not offered
    fireEvent.click(home().getByText('ops'))
    await waitFor(() => expect(t.calls.find((c) => c.name === 'workspace.open')?.args).toEqual({ paths: ['C:\\ops'] }))
  })
})

describe('Folder panel', () => {
  const folderPanel = () => within(document.querySelector('.tab-panel[data-kind="folder"]') as HTMLElement)
  /** Open the Folder page and wait until it is on screen. */
  const openFolder = async () => {
    openTab({ kind: 'folder' })
    await waitFor(() => expect(document.querySelector('.tab-panel[data-kind="folder"]')).toBeTruthy())
  }

  it('browses folders, opens the typed path and closes itself after opening', async () => {
    transport.on('workspace.open', ({ paths }: any) => ({ opened: paths, errors: [], scripts: 2, problems: [], finished: true, scriptId: null }))
    await mount()
    await openFolder()
    await folderPanel().findByText('C:') // a place
    fireEvent.click(folderPanel().getByText('C:'))
    await waitFor(() => expect(callsOf('workspace.browse').some((c) => c.args.path === 'C:\\')).toBe(true))
    await folderPanel().findByText('sub')
    fireEvent.input(folderPanel().getByLabelText('Folder path'), { target: { value: 'C:\\work\\scripts' } })
    fireEvent.submit(folderPanel().getByLabelText('Folder path').closest('form')!)
    await waitFor(() => expect(callsOf('workspace.open').at(-1)?.args).toEqual({ paths: ['C:\\work\\scripts'] }))
    await waitFor(() => expect(tabs.value.some((t) => t.kind === 'folder')).toBe(false))
    expect(toasts.value.map((t) => t.text)).toContain('Opened scripts')
  })

  it('lists favourites and recent folders; the star toggles a favourite and the cross forgets a recent one', async () => {
    await mount()
    await openFolder()
    expect(await folderPanel().findByText('ops')).toBeTruthy() // C:\scripts\ops
    expect(folderPanel().getByText('tools')).toBeTruthy()
    const rows = [...document.querySelectorAll('.tab-panel[data-kind="folder"] .folder-list li')]
    expect(rows.length).toBe(2)
    fireEvent.click(within(rows[0] as HTMLElement).getByTitle('Remove from favourites'))
    await waitFor(() => expect(callsOf('workspace.favorite')[0]?.args).toEqual({ path: 'C:\\scripts\\ops', on: false }))
    fireEvent.click(within(rows[1] as HTMLElement).getByTitle('Remove from the recent list'))
    await waitFor(() => expect(callsOf('workspace.forget')[0]?.args).toEqual({ path: 'C:\\work\\tools' }))
  })

  it('uses the native folder dialog in the desktop app', async () => {
    ;(transport.handlers as any)['host.info'] = () => ({ desktop: true, nativeMenu: true, platform: 'win32' })
    transport.on('workspace.pickFolder', () => 'D:\\picked')
    transport.on('workspace.open', ({ paths }: any) => ({ opened: paths, errors: [], scripts: 1, problems: [], finished: true, scriptId: null }))
    await mount()
    await openFolder()
    fireEvent.click(await folderPanel().findByText('Browse…'))
    await waitFor(() => expect(callsOf('workspace.open').at(-1)?.args).toEqual({ paths: ['D:\\picked'] }))
  })

  it('shows engine errors from opening as messages and keeps the page', async () => {
    transport.on('workspace.open', () => ({ opened: [], errors: ['Not an existing folder or script file: Z:\\nope'], scripts: 0, problems: [], finished: true, scriptId: null }))
    await mount()
    await openFolder()
    fireEvent.input(await folderPanel().findByLabelText('Folder path'), { target: { value: 'Z:\\nope' } })
    fireEvent.submit(folderPanel().getByLabelText('Folder path').closest('form')!)
    await waitFor(() => expect(toasts.value.some((t) => t.kind === 'error' && t.text.includes('Z:\\nope'))).toBe(true))
    expect(activeKey.value).toBe('folder:')
  })
})
