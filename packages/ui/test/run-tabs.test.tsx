import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import '../src/panels'
import { startApp } from '../src/bootstrap'
import { runSplit, runView } from '../src/core/layout'
import {
  MAX_CHILDREN, activateTab, activeKey, activeUpperKey, childrenOf, closeOthers, closeTab, loadWorkspaceTabs, moveTab, openTab, persistTabs, tabs, upperTabs,
} from '../src/core/tabs'
import { App } from '../src/shell/App'

const S1 = 'script:aaaaaaaaaaaa'
const S2 = 'script:bbbbbbbbbbbb'
const rid = (n: number) => `RUN-20261109-${String(n).padStart(3, '0')}`
const run = (n: number, scriptId: string, extra: object = {}) => openTab({ kind: 'run', id: rid(n), title: 'Hello', params: { scriptId, ...extra } })

let stop: (() => void) | null = null
beforeEach(() => {
  runView.value = 'full'
  runSplit.value = 50
  loadWorkspaceTabs('t')
})
afterEach(() => { stop?.(); stop = null })

describe('run tabs are the lower tabs of their script', () => {
  it('opens a run under its script, and the script tab if it is not open', () => {
    openTab({ kind: 'script', id: 'aaaaaaaaaaaa', title: 'Hello World' })
    run(1, 'aaaaaaaaaaaa')
    run(2, 'bbbbbbbbbbbb') // script not open: opened in the background
    expect(upperTabs.value.map((t) => t.key)).toEqual(['home:', S1, S2])
    expect(childrenOf(S1).map((t) => t.id)).toEqual([rid(1)])
    expect(childrenOf(S2).map((t) => t.id)).toEqual([rid(2)])
    expect(activeKey.value).toBe(`run:${rid(2)}`)
    expect(activeUpperKey.value).toBe(S2)
  })

  it('a run without a script goes under the page in front', () => {
    openTab({ kind: 'sequence', id: 'nightly', title: 'Nightly' })
    openTab({ kind: 'run', id: rid(5), title: 'step' })
    expect(childrenOf('sequence:nightly').map((t) => t.id)).toEqual([rid(5)])
  })

  it('a sequence run moves under its sequence once the page knows which one it is', () => {
    openTab({ kind: 'sequence', id: 'nightly', title: 'Nightly' })
    openTab({ kind: 'script', id: 'aaaaaaaaaaaa' }) // in front now
    openTab({ kind: 'sequence-run', id: 'SEQ-20261109-001' })
    expect(childrenOf(S1).length).toBe(1)
    openTab({ kind: 'sequence-run', id: 'SEQ-20261109-001', params: { sequence: 'nightly' } }, { background: true })
    expect(childrenOf(S1).length).toBe(0)
    expect(childrenOf('sequence:nightly').map((t) => t.id)).toEqual(['SEQ-20261109-001'])
  })

  it('clicking an upper tab returns to what was shown in it last', () => {
    openTab({ kind: 'script', id: 'aaaaaaaaaaaa' })
    run(1, 'aaaaaaaaaaaa')
    openTab({ kind: 'script', id: 'bbbbbbbbbbbb' })
    activateTab(S1)
    expect(activeKey.value).toBe(`run:${rid(1)}`)
    activateTab(S1, { exact: true })
    expect(activeKey.value).toBe(S1)
    activateTab('home:')
    activateTab(S1)
    expect(activeKey.value).toBe(S1)
  })

  it('keeps at most MAX_CHILDREN run tabs and drops the oldest that is not in front', () => {
    openTab({ kind: 'script', id: 'aaaaaaaaaaaa' })
    for (let n = 1; n <= MAX_CHILDREN + 3; n++) run(n, 'aaaaaaaaaaaa')
    const ids = childrenOf(S1).map((t) => t.id)
    expect(ids.length).toBe(MAX_CHILDREN)
    expect(ids[0]).toBe(rid(4))
    expect(ids[ids.length - 1]).toBe(rid(MAX_CHILDREN + 3))
  })

  it('closing a run tab shows its neighbour, closing the script closes its runs', async () => {
    openTab({ kind: 'script', id: 'aaaaaaaaaaaa' })
    run(1, 'aaaaaaaaaaaa')
    run(2, 'aaaaaaaaaaaa')
    await closeTab(`run:${rid(2)}`)
    expect(activeKey.value).toBe(`run:${rid(1)}`)
    await closeTab(`run:${rid(1)}`)
    expect(activeKey.value).toBe(S1)
    run(3, 'aaaaaaaaaaaa')
    await closeTab(S1)
    expect(tabs.value.map((t) => t.key)).toEqual(['home:'])
  })

  it('Close others keeps the run tabs of the tab that stays, and reordering keeps runs with their script', async () => {
    openTab({ kind: 'script', id: 'aaaaaaaaaaaa' })
    run(1, 'aaaaaaaaaaaa')
    openTab({ kind: 'script', id: 'bbbbbbbbbbbb' })
    run(2, 'bbbbbbbbbbbb')
    moveTab(2, 1) // script B before script A
    expect(tabs.value.map((t) => t.key)).toEqual(['home:', S2, `run:${rid(2)}`, S1, `run:${rid(1)}`])
    await closeOthers(`run:${rid(1)}`)
    expect(tabs.value.map((t) => t.key)).toEqual([S1, `run:${rid(1)}`])
  })

  it('persists the runs with their owner and drops a run whose owner is gone', () => {
    const off = persistTabs()
    openTab({ kind: 'script', id: 'aaaaaaaaaaaa' })
    run(1, 'aaaaaaaaaaaa')
    off()
    const saved = JSON.parse(localStorage.getItem('scripthub.openTabs.t') ?? '{}')
    expect(saved.tabs.find((t: any) => t.kind === 'run').owner).toBe(S1)
    localStorage.setItem('scripthub.openTabs.u', JSON.stringify({ tabs: [{ kind: 'run', id: rid(9), owner: 'script:gone' }], active: null }))
    loadWorkspaceTabs('u')
    expect(tabs.value.some((t) => t.kind === 'run')).toBe(false)
  })
})

describe('the lower strip and the run view', () => {
  async function mount() {
    render(<App />)
    stop = await startApp()
    await waitFor(() => expect(screen.getAllByText('Hello World').length).toBeGreaterThan(0))
  }

  it('shows only the upper tabs in the upper strip and the runs in the lower one', async () => {
    await mount()
    openTab({ kind: 'script', id: 'aaaaaaaaaaaa', title: 'Hello World' })
    run(1, 'aaaaaaaaaaaa')
    run(2, 'aaaaaaaaaaaa')
    await waitFor(() => expect(screen.getByTestId('run-strip')).toBeTruthy())
    const upper = Array.from(document.querySelectorAll('.tabstrip .vtab')).map((e) => e.textContent?.trim())
    expect(upper.some((t) => /run/i.test(t ?? ''))).toBe(false)
    const lower = Array.from(document.querySelectorAll('.runstrip .rtab')).map((e) => e.textContent?.trim())
    expect(lower[0]).toBe('Script')
    expect(lower).toContain('run 001')
    expect(lower).toContain('run 002')
  })

  it('has no lower strip for a page without runs', async () => {
    await mount()
    expect(screen.queryByTestId('run-strip')).toBeNull()
  })

  it('shows the run alone, beside, or under the page, and remembers the choice', async () => {
    await mount()
    openTab({ kind: 'script', id: 'aaaaaaaaaaaa', title: 'Hello World' })
    run(1, 'aaaaaaaaaaaa')
    await waitFor(() => expect(screen.getByTestId('run-strip')).toBeTruthy())
    const host = () => document.getElementById('main-body') as HTMLElement
    expect(host().classList.contains('is-split')).toBe(false)
    const visible = () => Array.from(document.querySelectorAll('.tab-panel:not([hidden])')).map((e) => e.getAttribute('data-kind'))
    expect(visible()).toEqual(['run'])

    fireEvent.click(document.getElementById('run-view')!) // full -> side
    await waitFor(() => expect(host().classList.contains('split-side')).toBe(true))
    expect(visible().sort()).toEqual(['run', 'script'])
    expect(document.querySelector('.split-divider')).toBeTruthy()

    fireEvent.click(document.getElementById('run-view')!) // side -> stack
    await waitFor(() => expect(host().classList.contains('split-stack')).toBe(true))

    // the page itself: no split, the toggle is hidden
    fireEvent.click(document.querySelector('.rtab-page')!)
    await waitFor(() => expect(host().classList.contains('is-split')).toBe(false))
    expect(document.getElementById('run-view')).toBeNull()
  })

  it('resizes the split with the keyboard', async () => {
    await mount()
    runView.value = 'side'
    openTab({ kind: 'script', id: 'aaaaaaaaaaaa', title: 'Hello World' })
    run(1, 'aaaaaaaaaaaa')
    await waitFor(() => expect(screen.getByTestId('run-strip')).toBeTruthy())
    const div = await waitFor(() => {
      const d = document.querySelector('.split-divider') as HTMLElement
      expect(d).toBeTruthy()
      return d
    })
    fireEvent.keyDown(div, { key: 'ArrowRight' })
    expect(runSplit.value).toBe(53)
    fireEvent.keyDown(div, { key: 'ArrowLeft' })
    fireEvent.keyDown(div, { key: 'ArrowLeft' })
    expect(runSplit.value).toBe(47)
  })
})
