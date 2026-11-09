# @scripthub/ui

The ScriptHub workbench: menu bar, activity bar, side panel, tab strip, editor area, bottom panel, status bar,
command palette. Preact + `@preact/signals`, styled by the old app's `workbench.css` (same class names) plus
`styles/extra.css`. It talks to the engine only through `@scripthub/client` (typed protocol calls and events).

```
src/
  core/        state and services (tabs, layout, theme, commands, hotkeys, toasts, confirm, hooks, api)
  shell/       the chrome: MenuBar, ActivityBar, SidePanel (Explorer, SequencesSide, RunsSide), TabStrip,
               EditorArea, BottomPanel, StatusBar, Palette, Overlays
  panels/      one folder per page kind; each registers exactly one component
  editor/      EditorAdapter interface, CodeEditor component, Monaco implementation (lazy)
  components/  Icon sprite and small shared pieces
```

Run: `npm run dev` (Electron + hot reload), `npm run dev:ui` (the UI alone in a browser with demo data),
`npm run test:ui`, `npm run smoke`.

## Panel contract

A *panel* is the page shown in one editor tab. The shell never imports a panel; each panel file registers itself:

```tsx
// packages/ui/src/panels/<kind>/index.tsx   (replace ONLY your own file)
import { registerPanel, api, useApi, openTab, toast, type PanelProps } from '../../core'

function MyPanel({ tab, active }: PanelProps) {
  const { data, error, reload } = useApi('scripts.get', { id: tab.id! }, [tab.id])
  return <div class="page">…</div>
}
registerPanel('script', MyPanel, { fill: true, bottom: SavedValues, bottomTitle: 'Saved values' })
```

**Kinds** (`PanelKind`): `home` `script` `run` `history` `settings` `sequences` `sequence` `sequence-run`
`project-open` `folder` `new-script` `library`. Every kind has a real panel; each lives in `src/panels/<kind>/`.

**Props**

| prop | meaning |
|---|---|
| `tab.id` | script id (`script`), run id (`run`), sequence slug (`sequence`), `SEQ-…` run id (`sequence-run`); empty for single pages |
| `tab.params` | what the tab was opened with (below); the tab list is persisted, so params must be JSON |
| `tab.title`, `tab.icon`, `tab.key` | `key` = `<kind>:<id>` and is unique |
| `active` | `false` while another tab is shown. Panels stay mounted (state survives); **pause polling when inactive** (`usePoll(fn, ms, active)` does) |

**Options** (third argument of `registerPanel`)

- `fill: true`: full-bleed page without padding; the panel scrolls itself (editors, diagrams, consoles).
- `bottom` / `bottomTitle`: content of the collapsible bottom panel (Ctrl+J) while a tab of this kind is active
  (e.g. the saved-values grid under a script). It receives the same `PanelProps`.

**Params agreed between pages** (JSON only: the tab list is persisted). A page that is already open gets new params
merged in, so a caller that wants the page to react again passes a fresh `nonce`.

- `script`: `{ run?: 'normal'|'trace'|'debug', nonce? }`. When set, the page starts a run once when it mounts (Home's
  Quick run). A new `nonce` asks again. `{ view?: string }` may remember the right-hand tab.
- `run`: `{ scriptId? }` (to highlight the script in the explorer).
- `new-script`: `{ from?: scriptId }` prefills that script's folder.
- `project-open`: `{ path?: string }` (a file chosen in the native dialog: call `project.open`) or `{ sample?: string }`
  (a sample project: call `project.openSample`); `nonce` re-triggers. With neither, show your own chooser.

- `script`: also `{ view: 'overview' | 'parameters' | 'run' }` (the right-hand tab, also for a page that is open) and
  `{ preset: '@<n>' | '<slug>' }` ("Run again": fills the run form with the n-th recent run or that preset; asked once,
  the page clears it).
- `history`: `{ kind: 'scripts' | 'sequences', script?: '<script id>' | 'seq:<slug>' }` shows exactly that filter (the
  other filters are cleared); without them the remembered filters stay.
- `sequence-run`: `{ sequence?: '<slug>' }` (the side panel highlights it).
- `settings`: `{ section?: string }` jumps to a section.

**Changing tabs**: `openTab({ kind, id?, title?, params?, icon? }, { background? })`, `closeTab(key)`, `activateTab(key)`,
`renameTab(key, title)`. Opening an existing `kind:id` activates it and merges `params`.

**Closing tabs and the close guard.** Every way of closing a tab (the ×, middle-click, Ctrl+W, the tab menu's Close /
Close others / Close all) goes through `closeTab`, which returns a promise (`true` = closed). A page that must not lose
work registers a guard while it is mounted:

```tsx
useCloseGuard(tab.key, () => {
  if (!dirty.current) return true                      // answers at once: the tab closes synchronously
  return (async () => {                                // asks: closeTab waits for the answer
    const a = await ask({ title: 'Unsaved changes', message: 'Save before closing?', confirmLabel: 'Save', altLabel: "Don't save" })
    return a === 'ok' ? await save() : a === 'alt'     // false keeps the tab open
  })()
})
```

A guard that throws keeps the tab (nothing is lost); a second close while the question is open does not ask twice;
Close others / all keep the tabs whose guard says no. A page that moves to another id after finishing a save uses
`forceCloseTab(key)` (no question). Panels that close themselves when done (`folder`, `new-script`) need no guard.

## What `core` gives a panel

| | |
|---|---|
| `api['runs.start']({…})` | typed protocol call (arguments and result typed by `@scripthub/protocol`); rejects with `ApiError` (`.code`, `.message`) |
| `onEvent('run.output', cb)` / `useEvent(name, cb)` | engine events: `scan.progress`, `run.status`, `run.output`, `debug.state`, `sequence.status`, `workspace.changed`, `runs.changed` (a run or sequence run started / finished anywhere, with the new `counts`: the status bar and the Runs lists use it instead of polling). Watch a run with `runs.watch` (live output, **no polling**) and `runs.unwatch` |
| `useApi(name, args, deps, enabled?)` | `{ data, error, loading, reload }`; ignores stale answers |
| `usePoll(fn, ms, active)` | interval that pauses while hidden or inactive |
| `useCommand('run.run', cb, active)` | page commands from the shell: `run.run` `{ mode, tab }` (Ctrl+Enter, `r`, Run menu; sent to `script` and `sequence` tabs), `tree.collapse` |
| `toast.success/error/info/warning(text)` | flash messages (success and info hide themselves) |
| `await confirm({ message, danger? })` | replaces `data-confirm` (boolean) |
| `await ask({ message, confirmLabel?, altLabel?, cancelLabel? })` | the same dialog with a third choice: `'ok'` (Enter) / `'alt'` / `'cancel'` (Escape) |
| `useCloseGuard(tab.key, fn)` | ask before this tab closes; see above |
| `await saveFile(name, text, type?)` | save a text file: the native Save dialog in the desktop app (`host.saveFile`), the browser's download otherwise; `{ ok, cancelled?, path? }`, never throws |
| `shell` (signal) | explorer tree, folders, sequences, counts: `shell.value?.tree`; `refreshShell()` after you change them |
| `runCommand(id, args?)`, `defineCommand({…})` | the command registry used by menus, palette and keys |
| `bottomOn`, `side2On`, `sideOn`, `theme` (signals) | layout state; `side2On` is the right-hand column of script pages (Ctrl+Alt+B) |
| `hostCall('host.…')` | desktop-only calls (native dialogs); rejects in a browser |
| `readJson/writeJson(key)` | localStorage that never throws |

Use the old class names (`panel`, `panel-head`, `table`, `btn`, `st st-success`, `lang lang-py`, `empty`, `stat`, `quick`…).
Colors come from CSS variables (`--accent`, `--bad`, …); never hard-code them: both themes follow the variables.

## Editor

`editor/EditorAdapter.ts` is the host-neutral interface (value, language, theme, markers, **line decorations** for
parameter-to-line marking and the current trace/debug line, **breakpoint gutter**). `<CodeEditor/>` mounts Monaco
(bundled, lazy-loaded, no CDN) and calls `onReady(adapter)`:

```tsx
<CodeEditor value={text} language={languageFor(script.ext)} breakpoints onChange={setText}
  onReady={(ed) => { ed.setLineDecorations('params', [{ line: 12, kind: 'param', hover: 'param: days' }]);
                     ed.onBreakpointsChange((lines) => api['runs.debug']({ id, action: 'breakpoints', lines })) }} />
```

Owners (`'params'`, `'debug'`, …) group decorations so a feature replaces only its own set. A VS Code host would
implement `EditorAdapter` by opening the file in VS Code's editor.

## Shell behaviour worth knowing

- Tabs are saved per workspace (`scripthub.openTabs.<open folder | files>` in localStorage); switching folder switches
  the tab set. Tabs of scripts that no longer exist are closed after a scan.
- In the Electron app the **native menu** is used and the HTML menu bar is hidden (`host.info.nativeMenu`); both run the
  same commands. Drop a folder on the window to open it.
- Keyboard: `g o/l/q/h/s/n/f` chords, `r` / `Ctrl+Enter` run, `Ctrl+K` palette (`>` = commands), `Ctrl+B` side panel,
  `Ctrl+J` bottom panel, `Ctrl+W` close tab, `F10` menu bar, `?` help sheet. Plain keys are ignored while typing.
