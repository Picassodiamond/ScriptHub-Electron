import fs from 'node:fs'
import path from 'node:path'
import { unzipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launch, openFolder, tmp, until, type Launched } from './harness'
import { active, confirmDialog, diagnoseFailures, kind, openScript, pressRun, rightTab, runConsole, runFolders, waitKind, waitStatus } from './ui'

let l: Launched
beforeAll(async () => {
  l = await launch()
  await openFolder(l, l.scripts)
})
afterAll(async () => { await l?.close() })
diagnoseFailures(() => l)

const cfg = () => JSON.parse(fs.readFileSync(path.join(l.home, 'config.json'), 'utf8'))
const openSettings = async () => {
  await l.page.locator('.act').last().click()
  await waitKind(l, 'settings')
}

describe('10. settings persist and data can be cleared', () => {
  it('rejects an invalid value without saving, then saves a valid one to config.json', async () => {
    await openSettings()
    await l.shot('70-settings')
    const max = active(l).locator('#st-max_concurrent_executions')
    await max.fill('0')
    await active(l).getByRole('button', { name: 'Save settings' }).click()
    await until(async () => /between 1 and 64|whole number|must be/i.test(await active(l).innerText()), 'a validation message')
    expect(fs.existsSync(path.join(l.home, 'config.json')) && cfg().max_concurrent_executions === 0).toBe(false) // nothing invalid on disk
    await max.fill('5')
    await active(l).locator('#st-default_timeout').fill('900')
    await active(l).getByRole('button', { name: 'Save settings' }).click()
    await until(() => fs.existsSync(path.join(l.home, 'config.json')) && cfg().max_concurrent_executions === 5, 'config.json written')
    expect(cfg().default_timeout).toBe(900)
  })

  it('the values are still there after the app is closed and started again', async () => {
    const { home, profile, scripts, work } = l
    await l.close()
    l = await launch({ home, profile, scripts, work })
    await until(async () => (await l.page.locator('#tree .tree-item').count()) === 19, 'the open folder is restored', 30000)
    await openSettings()
    await until(async () => (await active(l).locator('#st-max_concurrent_executions').inputValue()) === '5', 'the saved value')
    expect(await active(l).locator('#st-default_timeout').inputValue()).toBe('900')
  })

  it('Clear history removes finished runs after a confirm', async () => {
    await openScript(l, 'Hello (Python)')
    await rightTab(l, 'run')
    await pressRun(l)
    await runConsole(l)
    await waitStatus(l, 'success')
    expect(runFolders(l).length).toBe(1)
    await openSettings()
    await active(l).getByRole('button', { name: 'Data', exact: true }).click()
    await active(l).locator('tr[data-kind="history"]').getByRole('button', { name: 'Clear' }).click()
    await confirmDialog(l, /Clear|Delete|OK|Yes/i)
    await until(() => runFolders(l).length === 0, 'run folders removed')
    await until(async () => (await active(l).locator('tr[data-kind="history"] td.num').innerText()) === 'empty', 'the row says empty')
  })
})

describe('11. project files: save and open', () => {
  let projectFile: string

  it('File ▸ Save project as… writes a valid .scripthub with the open folder’s scripts', async () => {
    projectFile = path.join(tmp('sh-e2e-proj-'), 'my.scripthub')
    l.dialogs.push('saveProject', projectFile)
    await l.menu('File', 'Save project as')
    await until(() => fs.existsSync(projectFile), 'the project file', 30000)
    const files = unzipSync(new Uint8Array(fs.readFileSync(projectFile)))
    const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString('utf8'))
    expect(manifest.format).toBe('scripthub-project')
    expect(Object.keys(files).filter((n) => n.startsWith('files/') && n.endsWith('.py')).length).toBeGreaterThanOrEqual(10)
    expect(Object.keys(files).some((n) => n.includes('hello.py'))).toBe(true)
    expect(Buffer.from(files['files/basics/hello.py']).toString('utf8')).toBe(fs.readFileSync(path.join(l.scripts, 'basics', 'hello.py'), 'utf8'))
  })

  it('File ▸ Open project… previews it, unpacks it into a new folder and opens that folder', async () => {
    l.dialogs.push('openProject', projectFile)
    await l.menu('File', 'Open project')
    await waitKind(l, 'project-open')
    await until(async () => /Unpack into this new folder/i.test(await active(l).innerText()), 'the preview with a destination', 20000)
    await l.shot('71-project-preview')
    expect(await active(l).innerText()).toMatch(/files?/i)
    await active(l).locator('#p-dest').fill(l.work)
    await active(l).getByRole('button', { name: /Open project/ }).click()
    await until(async () => /Show the scripts/i.test(await active(l).innerText()), 'the result page', 30000)
    const root = l.work // the destination is the new project folder itself (it was empty)
    expect(fs.readdirSync(root).sort()).toEqual(['basics', 'data', 'files', 'network', 'system'])
    expect(fs.readFileSync(path.join(root, 'basics', 'hello.py'), 'utf8')).toBe(fs.readFileSync(path.join(l.scripts, 'basics', 'hello.py'), 'utf8'))
    await until(async () => (await l.page.locator('.side-title-block').first().getAttribute('title')) === root, 'the explorer now shows the new folder')
    expect(await l.page.locator('#tree .tree-item').count()).toBe(19)
    await l.shot('72-project-opened')
  })

  it('File ▸ Close project closes the folder', async () => {
    await l.menu('File', 'Close project')
    await confirmDialog(l, /^Close$/)
    await until(async () => (await l.page.locator('#tree .tree-item').count()) === 0, 'an empty explorer')
  })
})
