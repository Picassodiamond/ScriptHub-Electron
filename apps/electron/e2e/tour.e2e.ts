/**
 * A tour of every main page with real data, in the light and the dark theme. It writes screenshots to
 * e2e/screenshots/ for review, and checks two things that only show with many pages open at once: no console
 * errors, and no element id used twice in the document.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launch, openFolder, sleep, until, type Launched } from './harness'
import { active, diagnoseFailures, openScript, pressRun, rightTab, runConsole, setParam, showExplorer, waitKind, waitStatus } from './ui'

let l: Launched
beforeAll(async () => {
  l = await launch()
  await openFolder(l, l.scripts)
})
afterAll(async () => { await l?.close() })
diagnoseFailures(() => l)

const canvas = () => active(l).getByTestId('seq-canvas')
const nodes = () => active(l).locator('.seq-node')

async function runOutcome(outcome: 'success' | 'failure') {
  await openScript(l, 'Succeed, fail or take a while')
  await rightTab(l, 'run')
  await setParam(l, 'outcome', outcome)
  await setParam(l, 'seconds', '1')
  await pressRun(l)
  await runConsole(l)
  await waitStatus(l, outcome === 'success' ? 'success' : 'failed')
}

async function snapAll(theme: 'light' | 'dark', prefix: string) {
  const shot = (n: string) => l.shot(`${prefix}-${theme}-${n}`)
  await l.page.locator('.act').first().click()
  await waitKind(l, 'home')
  await sleep(300)
  await shot('home')
  await l.page.locator('.vtab', { hasText: 'Library' }).click()
  await waitKind(l, 'library')
  await sleep(300)
  await shot('library')
  await l.page.locator('.vtab', { hasText: /^Runs/ }).click()
  await waitKind(l, 'history')
  await sleep(300)
  await shot('history')
  await l.page.locator('.vtab', { hasText: /Pipeline/ }).first().click()
  await waitKind(l, 'sequence')
  await sleep(300)
  await shot('sequence')
  await l.page.locator('.vtab', { hasText: /^run 00\d/ }).first().click()
  await waitKind(l, 'run')
  await sleep(300)
  await shot('run-console')
  await l.page.locator('.vtab', { hasText: 'Succeed, fail or take a while' }).first().click()
  await waitKind(l, 'script')
  for (const v of ['overview', 'parameters', 'run'] as const) {
    await rightTab(l, v)
    await sleep(300)
    await shot(`script-${v}`)
  }
  await l.page.locator('.vtab', { hasText: 'Settings' }).click()
  await waitKind(l, 'settings')
  await sleep(300)
  await shot('settings')
}

describe('tour', () => {
  it('builds some state: two runs, a sequence with two steps and an arrow, a preset', async () => {
    await runOutcome('failure')
    await runOutcome('success') // the last run's values seed a new sequence step, so the sequence succeeds
    // a sequence
    await l.page.locator('.act').nth(2).click()
    await l.page.getByLabel('New sequence').first().click()
    await l.page.locator('.side-pane-seq input').first().fill('Pipeline')
    await l.page.keyboard.press('Enter')
    await waitKind(l, 'sequence')
    for (const [name, x, y] of [['Succeed, fail or take a while', 80, 120], ['Hello (Python)', 400, 260]] as const) {
      const before = await nodes().count()
      await l.page.locator('#tree .tree-item', { hasText: name }).first().dragTo(canvas(), { targetPosition: { x, y } })
      await until(async () => (await nodes().count()) === before + 1, `a box for ${name}`)
    }
    const port = await nodes().nth(0).locator('.seq-port').boundingBox()
    const target = await nodes().nth(1).boundingBox()
    await l.page.mouse.move(port!.x + 7, port!.y + 7)
    await l.page.mouse.down()
    await l.page.mouse.move(target!.x + 60, target!.y + 25, { steps: 8 })
    await l.page.mouse.up()
    await until(async () => (await active(l).locator('.seq-labels > *').count()) === 1, 'an arrow')
    await active(l).locator('#seq-play').click()
    await until(async () => (await active(l).locator('.seq-node .st-success').count()) === 2, 'the sequence to finish', 60000)
    // a preset
    await openScript(l, 'Hello (Python)')
    await rightTab(l, 'run')
    await active(l).locator('select[id$="-preset"]').selectOption('+')
    await active(l).locator('input[aria-label="Preset name"]').fill('demo')
    await active(l).locator('[data-new-preset] button.btn-primary').click()
    await until(async () => (await active(l).locator('select[id$="-preset"]').inputValue()) === 'demo', 'the preset')
    await l.page.locator('.act').nth(3).click() // Runs: opens History
    await waitKind(l, 'history')
  })

  it('opens the remaining pages: new script, project, folders, library', async () => {
    await showExplorer(l)
    await l.page.getByLabel('New script').first().click()
    await waitKind(l, 'new-script')
    await sleep(300)
    await l.shot('tour-light-new-script')
    await l.menu('File', 'Open recent', 'Manage folders')
    await waitKind(l, 'folder')
    await sleep(400)
    await l.shot('tour-light-folder')
    await l.page.locator('.act').first().click()
    await l.page.locator('.q-name, a, button', { hasText: 'Library' }).first().click().catch(() => {})
    await l.menu('File', 'Open project').catch(() => {})
    await l.page.keyboard.press('Control+k')
    await sleep(500)
    await l.shot('tour-light-palette')
    await l.page.keyboard.press('Escape')
    await l.page.locator('.act').nth(1).click() // explorer
    await l.page.getByRole('button', { name: /Library|Scripts/ }).first().click().catch(() => {})
  })

  it('opens Settings so it is part of the tour', async () => {
    await l.page.locator('.act').last().click()
    await waitKind(l, 'settings')
  })

  it('light theme: screenshots of every main page', async () => {
    await l.page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'light') })
    await l.page.locator('.act').nth(1).click()
    // make sure a Library tab exists
    if ((await l.page.locator('.vtab', { hasText: 'Library' }).count()) === 0) await l.page.keyboard.press('Control+k')
    await snapAll('light', 'tour')
  })

  it('dark theme: the same pages', async () => {
    const theme = () => l.page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    for (let i = 0; i < 3 && (await theme()) !== 'dark'; i++) {
      await l.page.getByLabel('Toggle theme').click() // the status bar button
      await sleep(300)
    }
    await until(async () => (await theme()) === 'dark', 'the dark theme')
    await snapAll('dark', 'tour')
  })

  it('no element id is used twice, and the page logged no errors', async () => {
    const dups = await l.page.evaluate(() => {
      const ids = Array.from(document.querySelectorAll('[id]')).map((e) => e.id)
      return ids.filter((id, i) => ids.indexOf(id) !== i)
    })
    expect([...new Set(dups)].join(', ')).toBe('')
    expect(l.errors.filter((e) => !/Autofill|DevTools/i.test(e))).toEqual([])
  })
})
