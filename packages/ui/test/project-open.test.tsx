import { demoShell } from '@scripthub/client'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import '../src/panels/project-open'
import { getPanel } from '../src/core/panels'
import { hostInfo, shell } from '../src/core/shellState'
import { activeKey, activeTab, openTab, tabs } from '../src/core/tabs'
import { toasts } from '../src/core/toast'
import { joinDestination } from '../src/panels/project-open/ProjectOpen'
import { transport } from './setup'

const PREVIEW = {
  token: 'tok-1', fileName: 'Maintenance.scripthub', destination: 'C:/Users/me/Documents/ScriptHub/maintenance', folderName: 'maintenance',
  preview: {
    name: 'Maintenance', created_at: '2026-11-09 21:10', scripthub: '2.0', folder: 'maintenance', files: 7, scripts: 4,
    file_list: ['disk.py', 'clean.sh', 'sub/ping.py'], sequences: [{ name: 'Nightly', as: 'Nightly (2)', steps: 3 }, { name: 'Weekly', as: 'Weekly', steps: 1 }],
    presets: 5, warnings: ['Step 2 uses a script on another host.'],
  },
}
const INSTALLED = { folder: 'C:/Users/me/Documents/ScriptHub/maintenance', files: 7, sequences: ['Nightly (2)', 'Weekly'], presets: 5, kept: ['prod'], warnings: ['Check the remote hosts.'] }
const desktop = () => { hostInfo.value = { desktop: true, nativeMenu: true, platform: 'win32' } }

const Panel = getPanel('project-open')!.component
function mount(params: Record<string, any> = {}) {
  shell.value = demoShell()
  const tab = openTab({ kind: 'project-open', params })
  return render(<Panel tab={tab} active />)
}
const calls = (name: string) => transport.calls.filter((c) => c.name === name)

describe('Project open panel', () => {
  it('without the desktop app asks for a path, checks it and previews what is inside', async () => {
    transport.on('project.open', () => PREVIEW)
    mount()
    const input = await screen.findByLabelText('Project file path')
    const go = screen.getByText('Check the file') as HTMLButtonElement
    expect(go.disabled).toBe(true)
    fireEvent.input(input, { target: { value: 'C:\\in\\Maintenance.scripthub' } })
    fireEvent.click(go)
    await screen.findByText('Maintenance')
    expect(calls('project.open')[0].args).toEqual({ path: 'C:\\in\\Maintenance.scripthub' })
    const stats = [...document.querySelectorAll('.proj-stats > div')].map((d) => d.textContent)
    expect(stats).toEqual(['4scripts', '7files in all', '2sequences', '5presets'])
    expect(screen.getByText(/added as “Nightly \(2\)” \(the name is taken\)/)).toBeTruthy()
    expect(screen.getByText('Step 2 uses a script on another host.')).toBeTruthy()
    expect(screen.getByText(/saved 2026-11-09 21:10 with ScriptHub 2.0/)).toBeTruthy()
    expect((screen.getByLabelText('Unpack into this new folder') as HTMLInputElement).value).toBe(PREVIEW.destination)
    expect(screen.queryByText('Browse…')).toBeNull() // no native folder dialog in a browser
  })

  it('a project file given by the menu opens straight to the preview, and a new nonce asks again', async () => {
    transport.on('project.open', () => PREVIEW)
    const { rerender } = mount({ path: 'C:\\in\\Maintenance.scripthub', nonce: 1 })
    await screen.findByText('Maintenance')
    expect(calls('project.open').length).toBe(1)
    const next = openTab({ kind: 'project-open', params: { path: 'C:\\in\\Other.scripthub', nonce: 2 } }) // the shell hands the page its updated tab
    rerender(<Panel tab={next} active />)
    await waitFor(() => expect(calls('project.open').length).toBe(2))
    expect(calls('project.open')[1].args).toEqual({ path: 'C:\\in\\Other.scripthub' })
  })

  it('a sample project from Home opens its preview; the chooser lists the samples too', async () => {
    transport.on('project.openSample', () => PREVIEW)
    mount({ sample: 'Maintenance', nonce: 5 })
    await screen.findByText('Maintenance')
    expect(calls('project.openSample')[0].args).toEqual({ name: 'Maintenance' })
    fireEvent.click(screen.getByText('Cancel'))
    expect(await screen.findByText('Samples')).toBeTruthy()
    fireEvent.click(await screen.findByTitle(/A project with a sequence and presets/))
    await waitFor(() => expect(calls('project.openSample').length).toBe(2))
  })

  it('unpacks into the chosen folder, shows the result and refreshes the workbench', async () => {
    transport.on('project.openSample', () => ({ ...PREVIEW, token: 'tok-install' }))
    transport.on('project.install', () => INSTALLED)
    mount({ sample: 'Maintenance', nonce: 1 })
    const dest = (await screen.findByLabelText('Unpack into this new folder')) as HTMLInputElement
    fireEvent.input(dest, { target: { value: 'D:/work/maintenance' } })
    const shellCalls = calls('app.shell').length
    fireEvent.click(screen.getByText('Open project'))
    await screen.findByTestId('project-done')
    expect(calls('project.install')[0].args).toEqual({ token: 'tok-install', destination: 'D:/work/maintenance' })
    expect(screen.getByText(/Sequences added: Nightly \(2\), Weekly/)).toBeTruthy()
    expect(screen.getByText(/5 presets added; 1 existing kept/)).toBeTruthy()
    expect(screen.getByText('Check the remote hosts.')).toBeTruthy()
    expect(toasts.value.some((t) => t.text === 'Opened Maintenance: 7 files unpacked.')).toBe(true)
    await waitFor(() => expect(calls('app.shell').length).toBeGreaterThan(shellCalls)) // the explorer shows the new folder
    cleanup()
    await new Promise((r) => setTimeout(r, 20))
    expect(calls('project.cancel').filter((c) => c.args.token === 'tok-install').length).toBe(0) // an installed file is not "cancelled" when the page closes
  })

  it('shows an install error and stays on the preview so the folder can be changed', async () => {
    transport.on('project.openSample', () => PREVIEW)
    transport.on('project.install', () => { throw new Error('The folder is not empty: D:/work') })
    mount({ sample: 'Maintenance', nonce: 1 })
    await screen.findByText('Maintenance')
    fireEvent.click(screen.getByText('Open project'))
    expect((await screen.findByRole('alert')).textContent).toContain('The folder is not empty: D:/work')
    expect(screen.getByText('Open project')).toBeTruthy()
    expect((screen.getByText('Open project') as HTMLButtonElement).disabled).toBe(false)
  })

  it('reports a file that is not a project and goes back to the chooser', async () => {
    transport.on('project.open', () => { throw new Error('This is not a ScriptHub project file.') })
    mount()
    fireEvent.input(await screen.findByLabelText('Project file path'), { target: { value: 'C:\\x.txt' } })
    fireEvent.click(screen.getByText('Check the file'))
    expect((await screen.findByRole('alert')).textContent).toContain('This is not a ScriptHub project file.')
    expect(screen.getByLabelText('Project file path')).toBeTruthy()
  })

  it('Cancel and closing the page forget the uploaded copy', async () => {
    transport.on('project.openSample', () => PREVIEW)
    mount({ sample: 'Maintenance', nonce: 1 })
    await screen.findByText('Maintenance')
    fireEvent.click(screen.getByText('Cancel'))
    await waitFor(() => expect(calls('project.cancel')[0]?.args).toEqual({ token: 'tok-1' }))
    expect(await screen.findByText('Samples')).toBeTruthy()
    fireEvent.click(await screen.findByTitle(/A project with a sequence and presets/))
    await screen.findByText('Maintenance')
    const n = calls('project.cancel').length
    cleanup() // the tab is closed while the preview waits
    await waitFor(() => expect(calls('project.cancel').length).toBe(n + 1))
  })

  it('desktop: chooses the file with the native dialog, browses for the destination', async () => {
    desktop()
    transport.on('host.openProject' as any, () => 'C:\\in\\Maintenance.scripthub')
    transport.on('project.open', () => PREVIEW)
    transport.on('workspace.pickFolder', () => 'D:\\Projects')
    mount()
    fireEvent.click(await screen.findByText('Choose project file…'))
    await screen.findByText('Maintenance')
    expect(calls('project.open')[0].args).toEqual({ path: 'C:\\in\\Maintenance.scripthub' })
    fireEvent.click(screen.getByText('Browse…'))
    await waitFor(() => expect((screen.getByLabelText('Unpack into this new folder') as HTMLInputElement).value).toBe('D:\\Projects\\maintenance'))
  })

  it('a cancelled native dialog does nothing', async () => {
    desktop()
    transport.on('host.openProject' as any, () => null)
    mount()
    fireEvent.click(await screen.findByText('Choose project file…'))
    await new Promise((r) => setTimeout(r, 30))
    expect(calls('project.open').length).toBe(0)
  })

  it('saves the open folder as a project and toasts the summary', async () => {
    desktop()
    transport.on('host.saveProject' as any, () => ({ path: 'C:\\out\\scripts.scripthub', report: { summary: '12 files, 2 sequences, 4 presets' } }))
    mount()
    fireEvent.click(await screen.findByText('Save project as…'))
    await waitFor(() => expect(toasts.value.some((t) => t.text === 'Saved C:\\out\\scripts.scripthub: 12 files, 2 sequences, 4 presets')).toBe(true))
  })

  it('saving is disabled without a folder or outside the desktop app', async () => {
    mount()
    const btn = (await screen.findByText('Save project as…')) as HTMLButtonElement
    expect(btn.closest('button')!.disabled).toBe(true)
    expect(screen.getByText(/Needs the desktop app/)).toBeTruthy()
    cleanup()
    desktop()
    shell.value = demoShell({ folder: { folder: null, files: [], favorites: [], recent: [] } })
    const tab = { key: 'project-open:', kind: 'project-open' as const, title: 'x', icon: '', params: {} }
    const Panel = getPanel('project-open')!.component
    render(<Panel tab={tab} active />)
    expect((await screen.findByText('Save project as…')).closest('button')!.disabled).toBe(true)
    expect(screen.getByText(/Open a folder first/)).toBeTruthy()
  })

  it('the finished page opens the library, the sequences or just closes', async () => {
    transport.on('project.openSample', () => PREVIEW)
    transport.on('project.install', () => INSTALLED)
    mount({ sample: 'Maintenance', nonce: 1 })
    await screen.findByText('Maintenance')
    fireEvent.click(screen.getByText('Open project'))
    fireEvent.click(await screen.findByText('Sequences'))
    expect(tabs.value.find((t) => t.kind === 'project-open')).toBeUndefined() // the page closed itself
    expect(activeTab.value).toMatchObject({ kind: 'sequences' })
    activeKey.value = null
  })

  it('builds the destination with the separator the picked path already uses', () => {
    expect(joinDestination('D:\\Projects', 'demo')).toBe('D:\\Projects\\demo')
    expect(joinDestination('D:\\Projects\\', 'demo')).toBe('D:\\Projects\\demo')
    expect(joinDestination('/home/me/', 'demo')).toBe('/home/me/demo')
    expect(joinDestination('C:/work', 'demo')).toBe('C:/work/demo')
  })
})
