import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launch, openFolder, until, type Launched } from './harness'
import { active, diagnoseFailures, openScript, pressRun, readRunMeta, rightTab, runConsole, runFolders, selectMode, setParam, stdout, waitKind, waitStatus } from './ui'

let l: Launched
beforeAll(async () => {
  l = await launch()
  await openFolder(l, l.scripts)
})
afterAll(async () => { await l?.close() })
diagnoseFailures(() => l)

async function startOutcome(mode: 'trace' | 'debug', seconds: string) {
  await openScript(l, 'Succeed, fail or take a while')
  await rightTab(l, 'run')
  await setParam(l, 'outcome', 'success')
  await setParam(l, 'seconds', seconds)
  await selectMode(l, mode)
  await pressRun(l)
  return runConsole(l)
}

describe('7. trace and debug', () => {
  it('trace: the running line is highlighted live, and the run finishes with a trace log on disk', async () => {
    const c = await startOutcome('trace', '4')
    await until(async () => /RUNNING LINE\s+\d+/i.test(await c.innerText()), 'running line shown', 20000)
    await until(async () => (await c.locator('.ed-line-highlight').count()) > 0, 'a line marked in the source pane', 15000) // Monaco decorates a moment after the text shows
    await l.shot('40-trace')
    const run = runFolders(l).at(-1)!
    expect(readRunMeta(l, run).trace).toBeTruthy()
    await waitStatus(l, 'success', 30000)
    const dir = path.join(l.home, 'executions', run)
    await until(() => fs.existsSync(path.join(dir, 'trace.last')) && fs.existsSync(path.join(dir, 'trace_source')), 'trace files in the run folder')
    expect(fs.readFileSync(path.join(dir, 'trace_source'), 'utf8')).toContain('time.sleep(1)')
    expect(fs.readFileSync(path.join(dir, 'stderr.log'), 'utf8')).not.toContain('SRL') // markers never leak into the output
  })

  it('debug: pauses on entry; Step advances; Continue finishes the run', async () => {
    const c = await startOutcome('debug', '2')
    await until(async () => /Paused at line \d+/.test(await c.innerText()), 'paused on entry', 20000)
    const lineOf = async () => Number(/Paused at line (\d+)/.exec(await c.innerText())![1])
    const first = await lineOf()
    expect(await c.getAttribute('data-status')).toBe('running')
    expect(await c.getByTestId('status-chip').innerText()).toBe('Paused')
    await l.shot('41-debug-paused')
    await c.getByRole('button', { name: /^Step/ }).click()
    await until(async () => (await lineOf()) !== first, 'a different line after Step')
    const second = await lineOf()
    expect(second).toBeGreaterThan(first)
    await c.getByRole('button', { name: /^Step/ }).click()
    await until(async () => (await lineOf()) > second, 'Step again')
    await c.getByRole('button', { name: /^Continue/ }).click()
    await waitStatus(l, 'success', 30000)
    expect(await stdout(l)).toContain('step 2 of 2')
    expect(readRunMeta(l, runFolders(l).at(-1)!).debug).toBeTruthy()
  })
})

describe('8. create a new script', () => {
  it('the + button opens New script, creating a file in the open folder and opening it', async () => {
    await l.page.getByLabel('New script').first().click()
    await waitKind(l, 'new-script')
    await active(l).locator('#n_file').fill('e2e_made')
    await active(l).locator('#n_sub').fill('e2e')
    await active(l).locator('#n_cat').fill('E2E')
    await active(l).locator('#n_name').fill('Made by e2e')
    await l.shot('50-new-script')
    await active(l).locator('button[type="submit"], button.btn-primary').last().click()
    await waitKind(l, 'script')
    const file = path.join(l.scripts, 'e2e', 'e2e_made.py')
    await until(() => fs.existsSync(file), 'the new file on disk')
    expect(fs.readFileSync(file, 'utf8')).toContain('name: Made by e2e')
    await until(async () => (await l.page.locator('#tree .tree-item', { hasText: 'Made by e2e' }).count()) === 1, 'explorer lists it')
  })

  it('refuses to overwrite an existing file and shows the reason', async () => {
    await l.page.getByLabel('New script').first().click()
    await waitKind(l, 'new-script')
    await active(l).locator('#n_file').fill('e2e_made')
    await active(l).locator('#n_sub').fill('e2e')
    await active(l).locator('button[type="submit"], button.btn-primary').last().click()
    await until(async () => /exist|already/i.test(await active(l).innerText()), 'an error that the file exists')
    expect(fs.readFileSync(path.join(l.scripts, 'e2e', 'e2e_made.py'), 'utf8')).toContain('Made by e2e') // untouched
  })

  it('the new script runs from its Run tab', async () => {
    await openScript(l, 'Made by e2e')
    await rightTab(l, 'run')
    await pressRun(l)
    await runConsole(l)
    await waitStatus(l, 'success')
  })
})
