import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launch, openFolder, sleep, until, type Launched } from './harness'
import { active, diagnoseFailures, waitKind } from './ui'

let l: Launched
beforeAll(async () => {
  l = await launch()
  await openFolder(l, l.scripts)
})
afterAll(async () => { await l?.close() })
diagnoseFailures(() => l)

const canvas = () => active(l).getByTestId('seq-canvas')
const nodes = () => active(l).locator('.seq-node')
const seqFile = () => path.join(l.home, 'sequences', 'pipeline.yaml')
const seqRunDirs = () => (fs.existsSync(path.join(l.home, 'sequence_runs')) ? fs.readdirSync(path.join(l.home, 'sequence_runs')).sort() : [])
const seqRun = () => JSON.parse(fs.readFileSync(path.join(l.home, 'sequence_runs', seqRunDirs().at(-1)!, 'metadata.json'), 'utf8'))
const stepStatuses = () => Object.fromEntries(seqRun().steps.map((s: any) => [s.script_name, s.status]))

async function dropScript(name: string, x: number, y: number) {
  const before = await nodes().count()
  await l.page.locator('#tree .tree-item', { hasText: name }).first().dragTo(canvas(), { targetPosition: { x, y } })
  await until(async () => (await nodes().count()) === before + 1, `a box for ${name}`)
}

/** Drag from the dot under box `from` onto box `to`, with real mouse events. */
async function connect(from: number, to: number) {
  const port = await nodes().nth(from).locator('.seq-port').boundingBox()
  const target = await nodes().nth(to).boundingBox()
  expect(port && target).toBeTruthy()
  const m = l.page.mouse
  await m.move(port!.x + port!.width / 2, port!.y + port!.height / 2)
  await m.down()
  await m.move(target!.x + 60, target!.y + 25, { steps: 8 })
  await m.move(target!.x + 70, target!.y + 30, { steps: 3 })
  await m.up()
}
const labels = () => active(l).locator('.seq-labels > *')

describe('9. build and run a sequence in the diagram', () => {
  it('creates a sequence from the side panel and opens its editor', async () => {
    await l.page.locator('.act').nth(2).click()
    await l.page.getByLabel('New sequence').first().click()
    await l.page.locator('.side-pane-seq input').first().fill('Pipeline')
    await l.page.keyboard.press('Enter')
    await waitKind(l, 'sequence')
    expect(fs.existsSync(seqFile())).toBe(true)
    expect(await active(l).locator('.seq-empty').isVisible()).toBe(true)
    await l.shot('60-seq-empty')
  })

  it('dragging scripts from the explorer adds steps, saved to the sequence file', async () => {
    await dropScript('Succeed, fail or take a while', 60, 60)
    await dropScript('Hello (Python)', 360, 60)
    await dropScript('Log a message', 360, 220)
    await until(() => (fs.readFileSync(seqFile(), 'utf8').match(/- id: s\d/g) ?? []).length === 3, 'three steps on disk')
    expect(await active(l).locator('.seq-empty').count()).toBe(0)
  })

  it('connects boxes with arrows and changes an arrow to "on failure"', async () => {
    await connect(0, 1)
    await until(async () => (await labels().count()) === 1, 'first arrow')
    await connect(0, 2)
    await until(async () => (await labels().count()) === 2, 'second arrow')
    await until(() => (fs.readFileSync(seqFile(), 'utf8').match(/- from: s\d/g) ?? []).length === 2, 'two arrows on disk')
    // click the second arrow's label until it says failure
    for (let i = 0; i < 3 && !/fail/i.test(await labels().nth(1).innerText()); i++) await labels().nth(1).click()
    await until(() => /when: failure/.test(fs.readFileSync(seqFile(), 'utf8')), 'a failure arrow on disk')
    await l.shot('61-seq-graph')
  })

  it('refuses an arrow that would make a loop and says why', async () => {
    await connect(1, 0)
    await until(async () => /loop/i.test(await l.page.locator('body').innerText()), 'the loop message')
    expect(await labels().count()).toBe(2)
  })

  it('Run starts it in place: the steps overlay their statuses and the sequence run is recorded', async () => {
    await active(l).locator('#seq-play').click()
    await until(() => seqRunDirs().length === 1, 'a sequence run record', 15000)
    await until(async () => (await active(l).locator('.seq-node .st').count()) > 0, 'a status chip on a box', 15000)
    await l.shot('62-seq-running')
    await until(() => seqRun().status === 'success', 'the sequence to finish', 60000)
    expect(stepStatuses()).toEqual({ 'Succeed, fail or take a while': 'success', 'Hello (Python)': 'success', 'Log a message': 'skipped' })
    await until(async () => (await active(l).locator('.seq-node .st-success').count()) === 2, 'two success chips on the boxes')
    expect(await active(l).locator('.seq-node .st-skipped').count()).toBe(1)
    // each step ran as an ordinary run, tagged with the sequence
    const runs = fs.readdirSync(path.join(l.home, 'executions')).filter((n) => /^RUN-/.test(n))
    expect(runs.length).toBe(2)
    const meta = JSON.parse(fs.readFileSync(path.join(l.home, 'executions', runs[0], 'metadata.json'), 'utf8'))
    expect(meta.sequence).toMatchObject({ name: 'Pipeline' })
  })

  it('the sequence-run page shows the steps and their statuses', async () => {
    await active(l).locator('#seq-live').click()
    await waitKind(l, 'sequence-run')
    await until(async () => /Succeed, fail or take a while/.test(await active(l).innerText()), 'steps listed')
    const text = await active(l).innerText()
    expect(text).toMatch(/Success/)
    expect(text).toMatch(/Skipped/)
    await l.shot('63-seq-run-page')
  })

  it('Pause between steps holds the next step back until Resume', async () => {
    await l.page.locator('.vtab', { hasText: /Pipeline/ }).first().click()
    await waitKind(l, 'sequence')
    const play = active(l).locator('#seq-play')
    await play.click() // Run again (the first step takes ~3 s)
    await until(() => seqRunDirs().length === 2, 'second sequence run', 15000)
    await until(async () => /Pause/i.test(await play.innerText()), 'the button turns into Pause', 15000)
    await play.click()
    await until(() => seqRun().paused === true, 'the run is paused')
    await until(() => stepStatuses()['Succeed, fail or take a while'] === 'success', 'the running step to finish', 20000)
    await sleep(2500)
    expect(stepStatuses()['Hello (Python)']).toBe('pending') // not started while paused
    await l.shot('64-seq-paused')
    await until(async () => /Resume/i.test(await play.innerText()), 'the button says Resume')
    await play.click()
    await until(() => seqRun().status === 'success', 'finished after Resume', 60000)
    expect(stepStatuses()['Hello (Python)']).toBe('success')
  })
})
