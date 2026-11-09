import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launch, openFolder, sleep, until, type Launched } from './harness'
import { active, confirmDialog, diagnoseFailures, openScript, pressRun, readRunLog, rightTab, runConsole, runFolders, setParam, stdout, waitStatus } from './ui'

const GREET = [
  '# --- scripthub ---', '# name: E2E Greeter', '# parameters:', '#   - name: who', '#     type: text', '#     default: world',
  '# --- end scripthub ---', 'import sys', 'print("hello", sys.argv[1:])', '',
].join('\n')

let l: Launched
let file: string
beforeAll(async () => {
  l = await launch({ files: { 'e2e/greet.py': GREET } })
  file = path.join(l.scripts, 'e2e', 'greet.py')
  await openFolder(l, l.scripts)
})
afterAll(async () => { await l?.close() })
diagnoseFailures(() => l)

const disk = () => fs.readFileSync(file, 'utf8')
const saveBtn = () => active(l).locator('[data-save-all]')
const isDirty = async () => ((await saveBtn().getAttribute('class')) ?? '').includes('is-dirty')

async function typeIntoEditor(text: string) {
  await active(l).locator('.monaco-editor .view-lines').first().click()
  await l.page.keyboard.press('Control+End')
  await l.page.keyboard.type(text)
}
const savedBackups = () => {
  const dir = path.join(l.home, 'backups')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).flatMap((id) => fs.readdirSync(path.join(dir, id)))
}

describe('4. edit the script in the editor', () => {
  it('typing makes the page dirty; Ctrl+S writes the file and keeps a backup of the previous version', async () => {
    await openScript(l, 'E2E Greeter')
    expect(await isDirty()).toBe(false)
    await typeIntoEditor('\n# edited by e2e')
    await until(isDirty, 'dirty Save button')
    expect(await l.page.locator('.vtab.is-active').innerText()).toContain('●') // the tab shows unsaved changes
    await l.shot('30-edit-dirty')
    await l.page.keyboard.press('Control+s')
    await until(async () => !(await isDirty()), 'saved')
    expect(disk()).toContain('# edited by e2e')
    expect(disk()).toContain('# name: E2E Greeter') // the metadata block is untouched
    expect(savedBackups().length).toBeGreaterThanOrEqual(1)
    expect(await l.page.locator('.vtab.is-active').innerText()).not.toContain('●')
  })

  it('"Restore the previous version" brings the old text back (after a confirm)', async () => {
    await active(l).locator('[title="Restore the previous version"]').click()
    await confirmDialog(l, /Restore/i)
    await until(() => !disk().includes('# edited by e2e'), 'file restored on disk')
    await until(async () => !(await active(l).locator('.monaco-editor .view-lines').first().innerText()).includes('edited by e2e'), 'editor text restored')
  })

  it('an edit made elsewhere while you have unsaved changes shows a conflict, and Overwrite keeps yours', async () => {
    await typeIntoEditor('\n# mine')
    await until(isDirty, 'dirty')
    fs.appendFileSync(file, '# theirs (external editor)\n')
    await l.page.keyboard.press('Control+s')
    const overwrite = active(l).getByRole('button', { name: /Overwrite/i })
    await overwrite.waitFor({ timeout: 15000 })
    await l.shot('31-conflict')
    expect(await active(l).innerText()).toMatch(/changed|conflict/i)
    expect(disk()).not.toContain('# mine') // nothing was written yet
    await overwrite.click()
    await until(() => disk().includes('# mine'), 'overwritten with mine')
    expect(disk()).not.toContain('theirs')
    await until(async () => !(await isDirty()), 'clean again')
  })
})

describe('5. parameters and overview', () => {
  it('adds a parameter in the Parameters tab, saves once, and the script block on disk has it', async () => {
    await rightTab(l, 'parameters')
    await active(l).locator('#add-param').click()
    const card = active(l).locator('.pe-edit .pe-card')
    const field = (label: string) => card.locator('.field', { has: l.page.locator(`label:text-is("${label}")`) })
    await field('Name (used by the script)').locator('input').fill('extra')
    await field('Label').locator('input').fill('Extra')
    await field('Default value').locator('input').fill('xyz')
    await field('Flag').locator('input').fill('--extra')
    await until(isDirty, 'dirty after adding a parameter')
    await l.shot('32-params-edit')
    await l.page.keyboard.press('Control+s')
    await until(() => disk().includes('name: extra'), 'parameter written into the script block')
    expect(disk()).toMatch(/arg: --extra/)
    expect(disk()).toContain('# name: E2E Greeter')
    await until(async () => !(await isDirty()), 'clean after saving')
    expect(await active(l).locator('#param-list .pe-item').count()).toBe(2)
  })

  it('the new parameter is on the Run form and is passed to the script', async () => {
    await rightTab(l, 'run')
    expect(await active(l).locator('[name="p_extra"]').inputValue()).toBe('xyz')
    await setParam(l, 'who', 'e2e')
    await setParam(l, 'extra', 'shiny')
    await pressRun(l)
    await runConsole(l)
    await waitStatus(l, 'success')
    await until(async () => (await stdout(l)).includes('--extra'), 'argv printed')
    expect(await stdout(l)).toContain("['--who', 'e2e', '--extra', 'shiny']")
    expect(readRunLog(l, runFolders(l).at(-1)!, 'stdout')).toContain("'--extra', 'shiny'")
  })

  it('renaming in the Overview tab saves with the same Save and updates the explorer', async () => {
    await openScript(l, 'E2E Greeter')
    await rightTab(l, 'overview')
    const name = active(l).locator('[id^="ov"][id$="-name"]')
    await name.fill('E2E Renamed')
    await until(isDirty, 'dirty after rename')
    await l.page.keyboard.press('Control+s')
    await until(() => disk().includes('name: E2E Renamed'), 'new name in the block')
    await until(async () => (await l.page.locator('#tree .tree-item', { hasText: 'E2E Renamed' }).count()) === 1, 'explorer shows the new name')
    expect(await l.page.locator('#tree .tree-item', { hasText: 'E2E Greeter' }).count()).toBe(0)
  })

  it('closing the page and opening the script again shows what was saved', async () => {
    await active(l).locator('button.tab[data-view="parameters"]').click()
    await l.page.locator('.vtab.is-active .vtab-x').click()
    await openScript(l, 'E2E Renamed')
    await rightTab(l, 'parameters')
    expect(await active(l).locator('#param-list .pe-item').count()).toBe(2)
    await rightTab(l, 'overview')
    expect(await active(l).locator('[id^="ov"][id$="-name"]').inputValue()).toBe('E2E Renamed')
  })
})

describe('6. presets and the saved-values grid', () => {
  const presetDir = () => {
    const base = path.join(l.home, 'presets')
    const ids = fs.existsSync(base) ? fs.readdirSync(base) : []
    return ids.map((i) => path.join(base, i)).find((d) => fs.readdirSync(d).some((f) => f.endsWith('.yaml') && f !== 'recent'))
  }

  it('saves the current values as a named preset', async () => {
    await rightTab(l, 'run')
    await setParam(l, 'who', 'from-preset')
    await setParam(l, 'extra', 'p1')
    await active(l).locator('select[id$="-preset"]').selectOption('+')
    await active(l).locator('input[aria-label="Preset name"]').fill('nightly')
    await active(l).locator('[data-new-preset] button.btn-primary').click()
    await until(() => !!presetDir(), 'preset file on disk')
    const yaml = fs.readFileSync(path.join(presetDir()!, 'nightly.yaml'), 'utf8')
    expect(yaml).toContain('from-preset')
    expect(yaml).toContain('p1')
    await until(async () => (await active(l).locator('select[id$="-preset"]').inputValue()) === 'nightly', 'the new preset is selected')
    await l.shot('33-preset-saved')
  })

  it('loading a preset restores its values; the saved-values grid lists it and can run it', async () => {
    await setParam(l, 'who', 'changed')
    await active(l).locator('select[id$="-preset"]').selectOption('-')
    await until(async () => (await active(l).locator('[name="p_who"]').inputValue()) !== 'changed', 'defaults loaded')
    await active(l).locator('select[id$="-preset"]').selectOption('nightly')
    await until(async () => (await active(l).locator('[name="p_who"]').inputValue()) === 'from-preset', 'preset loaded')

    // the collapsible bottom panel with the comparison grid
    await l.page.getByText('Saved values', { exact: false }).first().click()
    const grid = l.page.locator('table', { hasText: 'nightly' }).first()
    await grid.waitFor({ timeout: 10000 })
    await l.shot('34-saved-values')
    const before = runFolders(l).length
    await grid.getByRole('button', { name: /^Run/ }).first().click()
    await runConsole(l)
    await waitStatus(l, 'success')
    await until(async () => (await stdout(l)).includes("'--who', 'from-preset'"), 'ran with the preset values')
    expect(runFolders(l).length).toBe(before + 1)
    await sleep(100)
  })
})
