/**
 * The lower tab strip: the temporary tabs of the active upper tab (its runs). The first entry is the page itself; the
 * button at the right end chooses how a run is shown: full width, side by side, or stacked.
 */
import { Icon } from '../components/Icon'
import {
  RUN_VIEWS, activateTab, activeKey, activeUpperKey, childrenOf, closeTab, runView, tabs, tabStatus, type RunView, type Tab,
} from '../core'

const VIEW_META: Record<RunView, { icon: string; title: string }> = {
  full: { icon: 'panel', title: 'Run shown full width' },
  side: { icon: 'layout', title: 'Run shown beside the page' },
  stack: { icon: 'layout-rows', title: 'Run shown under the page' },
}

/** `RUN-20261109-003` -> `run 003`, `SEQ-20261109-003` -> `seq 003`; anything else keeps its title. */
export function childLabel(t: Tab): string {
  const m = /^(RUN|SEQ)-\d+-(\d+)$/.exec(t.id ?? '')
  return m ? `${m[1] === 'RUN' ? 'run' : 'seq'} ${m[2]}` : t.title
}

const STATUS_ICON: Record<string, string> = { running: 'pulse', ok: 'check', failed: 'x', paused: 'pause', other: 'clock' }

export function RunStrip() {
  const owner = activeUpperKey.value
  const kids = childrenOf(owner)
  if (!owner || !kids.length) return null
  const o = tabs.value.find((t) => t.key === owner)
  const statuses = tabStatus.value
  const onKid = kids.some((k) => k.key === activeKey.value)
  const view = runView.value
  const next = RUN_VIEWS[(RUN_VIEWS.indexOf(view) + 1) % RUN_VIEWS.length]
  const pageLabel = o?.kind === 'script' ? 'Script' : o?.kind === 'sequence' ? 'Diagram' : 'Page'
  return (
    <div class="runstrip" role="tablist" aria-label={`Runs of ${o?.title ?? 'this page'}`} data-testid="run-strip">
      <div
        role="tab" tabIndex={0} class={`rtab rtab-page ${activeKey.value === owner ? 'is-active' : ''}`} aria-selected={activeKey.value === owner}
        title={o?.title} onClick={() => activateTab(owner, { exact: true })}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateTab(owner, { exact: true }) } }}
      >
        <Icon name={o?.kind === 'sequence' ? 'sequence' : 'code'} small /> {pageLabel}
      </div>
      {kids.map((k) => {
        const st = statuses[k.key]
        const label = childLabel(k)
        return (
          <div
            key={k.key} role="tab" tabIndex={0} aria-selected={k.key === activeKey.value} title={`${k.title} · ${k.id ?? ''}`}
            class={`rtab ${k.key === activeKey.value ? 'is-active' : ''}`} data-status={st}
            onClick={() => activateTab(k.key)}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); void closeTab(k.key) } }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateTab(k.key) } }}
          >
            {st && <span class={`rtab-st is-${st}`}><Icon name={STATUS_ICON[st]} small /></span>}
            <span class="rtab-title">{label}</span>
            <button type="button" class="vtab-x" aria-label={`Close ${label}`} title="Close" tabIndex={-1} onClick={(e) => { e.stopPropagation(); void closeTab(k.key) }}>
              <Icon name="x" />
            </button>
          </div>
        )
      })}
      <span class="spacer" />
      {onKid && (
        <button
          type="button" class="btn btn-ghost btn-icon btn-sm rtab-view" id="run-view" data-view={view}
          title={`${VIEW_META[view].title}. Click for: ${VIEW_META[next].title.toLowerCase()}`}
          aria-label={`${VIEW_META[view].title}; switch view`} onClick={() => { runView.value = next }}
        >
          <Icon name={VIEW_META[view].icon} />
        </button>
      )}
    </div>
  )
}
