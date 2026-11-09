import { beforeEach, onTestFailed } from 'vitest'
/** UI helpers shared by the flows: they act like a user (clicks, typing) and read the real DOM / disk. */
import fs from 'node:fs'
import path from 'node:path'
import { until, type Launched } from './harness'

export const active = (l: Launched) => l.page.locator('.tab-panel:not([hidden])')
export const treeItem = (l: Launched, name: string) => l.page.locator('#tree .tree-item', { hasText: name })
export const kind = (l: Launched) => active(l).getAttribute('data-kind')

export async function waitKind(l: Launched, k: string, ms = 20000): Promise<void> {
  await until(async () => (await kind(l)) === k, `a ${k} page (now ${await kind(l).catch(() => '?')})`, ms)
}

/** The side panel may show Runs or Sequences; the second activity-bar button is the explorer. */
export async function showExplorer(l: Launched): Promise<void> {
  if ((await l.page.locator('#tree').count()) === 0) await l.page.locator('.act').nth(1).click()
  await l.page.locator('#tree').waitFor()
}

/** Click a script in the explorer and wait for its page. */
export async function openScript(l: Launched, name: string): Promise<void> {
  await showExplorer(l)
  await treeItem(l, name).first().click()
  await waitKind(l, 'script')
  // an already open script page may still be showing: wait for the tab of THIS script to be the active one
  await until(async () => (await l.page.locator('.vtab.is-active .vtab-title').first().innerText()).includes(name), `the ${name} tab to be active`)
  await active(l).locator('button.tab[data-view]').first().waitFor()
  await until(async () => (await active(l).locator('.doc-tab .tab-name').first().innerText()).length > 0, 'script file tab')
}

export async function rightTab(l: Launched, view: 'overview' | 'parameters' | 'run'): Promise<void> {
  const b = active(l).locator(`button.tab[data-view="${view}"]`)
  await b.click()
  await until(async () => ((await b.getAttribute('class')) ?? '').includes('is-active'), `${view} tab`)
}

/** Fill a Run-form parameter by name. */
export async function setParam(l: Launched, name: string, value: string): Promise<void> {
  const el = active(l).locator(`[name="p_${name}"]`).first()
  const tag = await el.evaluate((e) => e.tagName)
  if (tag === 'SELECT') await el.selectOption(value)
  else await el.fill(value)
}

export const pressRun = (l: Launched) => active(l).locator('button[data-run="true"]').click()

export async function selectMode(l: Launched, mode: 'normal' | 'trace' | 'debug'): Promise<void> {
  await active(l).locator(`label.seg-btn:has(input[name="mode"][value="${mode}"])`).click()
}

/** The run console that is now showing; waits for it to exist. */
export async function runConsole(l: Launched) {
  await waitKind(l, 'run')
  const c = active(l).locator('.run-console')
  await c.waitFor()
  return c
}

export async function waitStatus(l: Launched, status: string, ms = 30000): Promise<void> {
  const c = active(l).locator('.run-console')
  await until(async () => (await c.getAttribute('data-status')) === status, `run status ${status}`, ms)
}

export async function stdout(l: Launched): Promise<string> {
  return active(l).locator('.run-console .vlog').first().innerText()
}

// ------------------------------------------------------------------ disk ---
export function runFolders(l: Launched): string[] {
  try { return fs.readdirSync(path.join(l.home, 'executions')).filter((n) => /^RUN-/.test(n)).sort() } catch { return [] }
}
export const readRunMeta = (l: Launched, id: string) => JSON.parse(fs.readFileSync(path.join(l.home, 'executions', id, 'metadata.json'), 'utf8'))
export const readRunLog = (l: Launched, id: string, s: 'stdout' | 'stderr') => fs.readFileSync(path.join(l.home, 'executions', id, `${s}.log`), 'utf8')

/** Print what is on screen (for a failing step). */
export async function dump(l: Launched, label = ''): Promise<void> {
  const t = await active(l).innerText().catch(() => '(no panel)')
  console.log(`--- ${label} [${await kind(l).catch(() => '?')}]\n${t.slice(0, 1500)}`)
}

/** Confirm dialog buttons of the shell (confirm()/ask()). */
export async function confirmDialog(l: Launched, button: RegExp = /^(OK|Yes|Stop|Delete|Restore|Discard|Overwrite|Close|Confirm)/i): Promise<void> {
  const dlg = l.page.locator('[role="dialog"], .modal, .dialog').last()
  await dlg.waitFor({ timeout: 10000 })
  await dlg.getByRole('button', { name: button }).last().click()
}

/** On any failing test: screenshot + text of the visible panel, so a red test explains itself. */
export function diagnoseFailures(get: () => Launched): void {
  beforeEach((ctx) => {
    onTestFailed(async () => {
      const l = get()
      const name = ctx.task.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)
      await l.shot(`FAIL-${name}`).catch(() => {})
      await dump(l, ctx.task.name).catch(() => {})
      console.log('tabs:', await l.page.locator('.vtab').allInnerTexts().catch(() => []))
      console.log('main log:', l.logs.join('').split('\n').slice(-15).join('\n'))
    })
  })
}
