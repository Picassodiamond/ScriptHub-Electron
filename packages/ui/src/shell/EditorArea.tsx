/** The editor area: one mounted panel per open tab (inactive ones hidden, so their state survives). */
import { Component, type ComponentChildren } from 'preact'
import { Icon } from '../components/Icon'
import { activeKey, getPanel, openTab, tabs, type Tab } from '../core'

class Boundary extends Component<{ tab: Tab; children?: ComponentChildren }, { error: Error | null }> {
  state = { error: null as Error | null }
  componentDidCatch(error: Error) {
    console.error(`panel ${this.props.tab.kind} crashed:`, error)
    this.setState({ error })
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div class="panel-error" role="alert">
        <h2>This page failed to display</h2>
        <p class="muted">{this.state.error.message}</p>
        <button type="button" class="btn" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    )
  }
}

export function EditorArea() {
  const list = tabs.value
  return (
    <div class="main-body tab-host" id="main-body">
      {list.map((t) => {
        const entry = getPanel(t.kind)
        const active = t.key === activeKey.value
        const Panel = entry?.component
        return (
          <div key={t.key} class={`tab-panel ${entry?.options.fill ? 'is-fill' : ''}`} role="tabpanel" hidden={!active} data-kind={t.kind}>
            <Boundary tab={t}>
              {Panel ? <Panel tab={t} active={active} /> : <div class="empty"><h2>No panel for “{t.kind}”</h2></div>}
            </Boundary>
          </div>
        )
      })}
      {!list.length && (
        <div class="empty" style="margin:12vh auto">
          <Icon name="home" />
          <h2>No page is open</h2>
          <p>Open one from the explorer, or press <kbd>Ctrl</kbd> <kbd>K</kbd> to search.</p>
          <button type="button" class="btn btn-primary" onClick={() => openTab({ kind: 'home' })}>Open Home</button>
        </div>
      )}
    </div>
  )
}
