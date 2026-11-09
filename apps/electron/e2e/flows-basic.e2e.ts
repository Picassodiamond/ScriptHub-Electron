import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launch, openFolder, until, type Launched } from './harness'
import { active, confirmDialog, diagnoseFailures, kind, openScript, pressRun, readRunLog, readRunMeta, rightTab, runConsole, runFolders, setParam, stdout, waitKind, waitStatus } from './ui'

let l: Launched
beforeAll(async () => { l = await launch() })
diagnoseFailures(() => l)
afterAll(async () => { await l?.close() })

describe('1. open a folder, explorer, filter', () => {
  it('opens the folder through the File menu and lists the scripts grouped by category', async () => {
    await l.shot('10-home-empty')
    await openFolder(l, l.scripts)
    expect(await l.page.locator('#tree .tree-item').count()).toBe(19)
    const groups = await l.page.locator('#tree .tree-group .tree-summary').allInnerTexts()
    expect(groups.map((g) => g.split('\n')[0])).toEqual(['Basics', 'Data', 'Files', 'Network', 'System'])
    expect((await l.page.locator('.side-title').innerText()).toLowerCase()).toBe(path.basename(l.scripts).toLowerCase())
    expect(await l.page.locator('.side-title-block').getAttribute('title')).toBe(l.scripts)
    await l.shot('11-explorer')
  })

  it('filters the explorer as you type and shows a message when nothing matches', async () => {
    const f = l.page.getByLabel('Filter scripts')
    await f.fill('hello')
    expect(await l.page.locator('#tree .tree-item').count()).toBe(3)
    await f.fill('zzzz')
    expect(await l.page.locator('#tree .tree-item').count()).toBe(0)
    expect(await l.page.locator('#tree').innerText()).toMatch(/No match/)
    await f.fill('')
    expect(await l.page.locator('#tree .tree-item').count()).toBe(19)
  })
})

describe('2. run a script from the Run tab', () => {
  it('changes parameters, runs, shows live output and Success, and records the run on disk', async () => {
    await openScript(l, 'Hello (Python)')
    await rightTab(l, 'run')
    await setParam(l, 'name', 'Electron')
    await setParam(l, 'greeting', 'Hi')
    await setParam(l, 'times', '2')
    await pressRun(l)
    const c = await runConsole(l)
    await waitStatus(l, 'success')
    await until(async () => (await stdout(l)).includes('Hi, Electron!'), 'stdout text')
    expect(await stdout(l)).toMatch(/Hi, Electron!\s+Hi, Electron!/)
    expect(await c.getByTestId('exit-code').innerText()).toBe('0')
    await l.shot('20-run-success')

    const ids = runFolders(l)
    expect(ids.length).toBe(1)
    const meta = readRunMeta(l, ids[0])
    expect(meta.status).toBe('success')
    expect(meta.parameters).toMatchObject({ name: 'Electron', greeting: 'Hi', times: 2 })
    expect(readRunLog(l, ids[0], 'stdout')).toContain('Hi, Electron!')
  })

  it('lists the run in History, and "Run again" opens the form with the same values', async () => {
    await l.page.locator('.act').nth(3).click() // Runs
    await waitKind(l, 'history')
    await until(async () => (await active(l).locator('tbody tr').count()) === 1, 'one history row')
    expect(await active(l).locator('tbody tr').first().innerText()).toMatch(/Hello \(Python\)[\s\S]*Success/)
    await l.shot('21-history')
    await l.page.locator('.vtab', { hasText: /^run 001/ }).click()
    await active(l).getByRole('button', { name: /Run again/ }).click()
    await waitKind(l, 'script')
    await until(async () => (await active(l).locator('[name="p_name"]').inputValue()) === 'Electron', 'prefilled name')
    expect(await active(l).locator('[name="p_greeting"]').inputValue()).toBe('Hi')
    expect(await active(l).locator('[name="p_times"]').inputValue()).toBe('2')
  })
})

describe('3. failure and Stop', () => {
  it('a failing script ends Failed and its stderr is shown', async () => {
    await openScript(l, 'Succeed, fail or take a while')
    await rightTab(l, 'run')
    await setParam(l, 'outcome', 'failure')
    await setParam(l, 'seconds', '1')
    await setParam(l, 'exit_code', '7')
    await pressRun(l)
    const c = await runConsole(l)
    await waitStatus(l, 'failed')
    await until(async () => (await c.locator('.vlog-err').innerText()).includes('Failing on purpose with exit code 7.'), 'stderr text')
    expect(await c.getByTestId('exit-code').innerText()).toBe('7')
    expect(await c.getByTestId('status-chip').innerText()).toBe('Failed')
    await l.shot('22-run-failed')
  })

  it('Stop ends a long-running script as Cancelled', async () => {
    await openScript(l, 'Succeed, fail or take a while')
    await rightTab(l, 'run')
    await setParam(l, 'outcome', 'success')
    await setParam(l, 'seconds', '120')
    await pressRun(l)
    const c = await runConsole(l)
    await until(async () => (await stdout(l)).includes('step 2 of 120'), 'live output while running', 20000)
    expect(await c.getAttribute('data-status')).toBe('running')
    await l.shot('23-run-running')
    await c.getByRole('button', { name: /Stop/ }).first().click()
    await confirmDialog(l)
    await waitStatus(l, 'cancelled', 20000)
    expect(readRunMeta(l, runFolders(l).at(-1)!).status).toBe('cancelled')
    expect(await kind(l)).toBe('run')
  })
})
