import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launch, openFolder, sleep, until, type Launched } from './harness'
import { active, diagnoseFailures, openScript, pressRun, readRunMeta, rightTab, runConsole, runFolders, setParam, stdout, waitStatus } from './ui'

let l: Launched
beforeAll(async () => {
  l = await launch()
  await openFolder(l, l.scripts)
})
afterAll(async () => { await l?.close() })
diagnoseFailures(() => l)

const hello = () => path.join(l.scripts, 'basics', 'hello.py')
const winState = () => l.app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  return { exists: !!w && !w.isDestroyed(), visible: !!w && w.isVisible() }
})

describe('12. closing', () => {
  it('closing a tab with unsaved edits asks first; Cancel keeps it, Don’t save discards', async () => {
    await openScript(l, 'Hello (Python)')
    const original = fs.readFileSync(hello(), 'utf8')
    await active(l).locator('.monaco-editor .view-lines').first().click()
    await l.page.keyboard.press('Control+End')
    await l.page.keyboard.type('\n# unsaved')
    await until(async () => ((await active(l).locator('[data-save-all]').getAttribute('class')) ?? '').includes('is-dirty'), 'dirty')

    await l.page.locator('.vtab.is-active .vtab-x').click()
    const dlg = l.page.locator('[role="dialog"], .modal, .dialog').last()
    await dlg.waitFor({ timeout: 10000 })
    await l.shot('80-close-asks')
    expect(await dlg.innerText()).toMatch(/unsaved|changes/i)
    await dlg.getByRole('button', { name: /Cancel/i }).click()
    expect(await l.page.locator('.vtab', { hasText: 'Hello (Python)' }).count()).toBe(1) // still open
    expect(((await active(l).locator('[data-save-all]').getAttribute('class')) ?? '')).toContain('is-dirty') // the edit is still there

    await l.page.locator('.vtab.is-active .vtab-x').click()
    await dlg.waitFor({ timeout: 10000 })
    await dlg.getByRole('button', { name: /Don.?t save|Discard/i }).click()
    await until(async () => (await l.page.locator('.vtab', { hasText: 'Hello (Python)' }).count()) === 0, 'the tab to close')
    expect(fs.readFileSync(hello(), 'utf8')).toBe(original) // nothing was written
  })

  it('closing the window while a run is active keeps the app (and the run) alive in the tray', async () => {
    await openScript(l, 'Succeed, fail or take a while')
    await rightTab(l, 'run')
    await setParam(l, 'seconds', '120')
    await pressRun(l)
    await runConsole(l)
    await until(async () => (await stdout(l)).includes('step 2 of 120'), 'the run to be going', 20000)
    const run = runFolders(l).at(-1)!
    const pid = await l.app.evaluate(() => process.pid)

    await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await until(async () => !(await winState()).visible, 'the window to hide')
    expect(l.app.process().exitCode).toBeNull() // still running
    expect(await l.app.evaluate(() => process.pid)).toBe(pid)
    await sleep(1500)
    expect(readRunMeta(l, run).status).toBe('running') // the run was not touched
    expect(fs.readFileSync(path.join(l.home, 'executions', run, 'stdout.log'), 'utf8')).toMatch(/step [3-9] of 120/) // and keeps producing output

    // the tray "Show" brings it back; here the same thing through the window
    await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
    await until(async () => (await winState()).visible, 'the window to show again')
    expect(await l.page.locator('.run-console').count()).toBeGreaterThan(0)
  })

  it('Quit while a run is active asks; "Keep running" keeps everything, "Stop them and quit" cancels the run and exits', async () => {
    const run = runFolders(l).at(-1)!
    l.dialogs.push('quit', 1) // Keep running
    await l.menu('File', 'Quit')
    await sleep(1500)
    expect(l.app.process().exitCode).toBeNull()
    expect((await winState()).exists).toBe(true)
    expect(readRunMeta(l, run).status).toBe('running')

    l.dialogs.push('quit', 0) // Stop them and quit
    await l.menu('File', 'Quit')
    await Promise.race([l.exited, sleep(30000).then(() => { throw new Error('the app did not exit') })])
    expect(readRunMeta(l, run).status).toBe('cancelled') // stopped on the way out, not left "running"
  })

  it('on the next start nothing is left running and the cancelled run is in History', async () => {
    const { home, profile, scripts, work } = l
    l = await launch({ home, profile, scripts, work })
    await until(async () => (await l.page.locator('#tree .tree-item').count()) === 19, 'the folder to be restored', 30000)
    await l.page.locator('.act').nth(3).click()
    await until(async () => /Cancelled/.test(await active(l).innerText()), 'the cancelled run in History')
    await l.page.getByText(/0 running · 0 queued/).first().waitFor()
  })
})
