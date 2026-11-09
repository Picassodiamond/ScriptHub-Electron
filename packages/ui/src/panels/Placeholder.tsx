import { Icon } from '../components/Icon'
import type { Tab } from '../core'

/** Shown for a page kind whose panel has not been built yet. The file that replaces it is named on screen. */
export function Placeholder({ tab, file, what }: { tab: Tab; file: string; what: string }) {
  return (
    <div class="placeholder empty" data-placeholder={tab.kind}>
      <Icon name={tab.icon} />
      <h2>{tab.title}</h2>
      <p><span class="badge badge-warn">placeholder</span></p>
      <p>The <code>{tab.kind}</code> page is not built yet: {what}.</p>
      <p class="small muted">It is implemented by replacing <code>{file}</code>.</p>
      {Object.keys(tab.params).length > 0 && <pre class="small muted" style="text-align:left;overflow:auto">{JSON.stringify(tab.params, null, 2)}</pre>}
    </div>
  )
}
