/** Plain, JSON-serialisable shapes that cross the protocol (no class instances, no functions). */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
export type Dict = Record<string, any>

// ---------------------------------------------------------------- scripts ---
export interface ScriptDto {
  id: string
  name: string
  path: string
  root: string
  relative: string
  location: string
  category: string
  description: string
  extension: string
  /** extension without the dot */
  ext: string
  interpreter: string
  language: string
  languageLabel: string
  platforms: string[]
  platformLabels: string[]
  metaValid: boolean
  metaError: string | null
  parameterCount: number
  idConflict: string
  pathId: string
  /** last run, when known */
  lastRun?: { id: string; status: string; label: string; ago: string } | null
}

export interface TreeItem {
  id: string
  name: string
  ext: string
  relative: string
  category: string
  runnable: boolean
  status: string | null
  statusLabel: string
}
export interface TreeGroup { name: string; scripts: TreeItem[] }
export interface PaletteItem { id: string; name: string; cat: string; ext: string; path: string; run: boolean }

export interface ScanStatus {
  scanning: boolean
  version: number
  count: number
  folder?: string
  dirs?: number
  found?: number
  current?: string
  elapsed?: number
  first?: boolean
}

export interface WorkspaceItem { path: string; name: string; exists: boolean; is_file: boolean; favorite: boolean; is_open: boolean }
export interface WorkspaceOverview {
  folder: WorkspaceItem | null
  files: WorkspaceItem[]
  favorites: WorkspaceItem[]
  recent: WorkspaceItem[]
}
export interface BrowseResult {
  path: string
  parent: string
  dirs: Array<{ path: string; name: string }>
  files: Array<{ path: string; name: string }>
  more?: boolean
  places: Array<{ path: string; name: string }>
  crumbs: Array<{ path: string; name: string }>
  error: string
}

export interface SequenceSummary { slug: string; name: string; steps: number; saved_at: string; saved_display: string; error: string; favorite: boolean }

/** Everything the workbench chrome needs (explorer, palette, side lists, status bar). */
export interface ShellState {
  tree: TreeGroup[]
  palette: PaletteItem[]
  folder: WorkspaceOverview
  folderPalette: Array<{ path: string; name: string; favorite: boolean }>
  sequences: Array<{ slug: string; name: string }>
  sequenceList: SequenceSummary[]
  scan: ScanStatus
  runs: Dict[]
  counts: { running: number; queued: number }
  editingEnabled: boolean
  pollingInterval: number
  version: string
}

export interface LibraryState {
  scripts: ScriptDto[]
  problems: string[]
  categories: string[]
  languages: Array<[string, string]>
  platforms: Array<[string, string]>
  interpreters: string[]
}

export interface InfoForm {
  name: string
  description: string
  category: string
  interpreter: string
  platforms: string[]
  host: string
  working_directory: string
  environment: string
}

export interface ParamTypeInfo { label: string; allowed: string[] }

export interface ScriptDetail {
  script: ScriptDto
  runs: Dict[]
  presets: PresetSummary[]
  recent: Dict[]
  savedCount: number
  form: InfoForm
  params: Dict[]
  typeInfo: Record<string, ParamTypeInfo>
  platformChoices: Array<[string, string]>
  hosts: string[]
  /** metadata that could not be read; the form is then read-only until the block is fixed */
  loadError: string | null
}

export type SaveResult = { ok: true; id: string } | { ok: false; errors: string[] }

export interface ScriptSource {
  text: string
  lines: string[]
  truncated: boolean
  error: string | null
  language: string
  size: number
  metaText: string
}

export interface ScriptDoc {
  source: ScriptSource
  /** present when editing is on and the file can be edited */
  editor: EditorInfo | null
  editorError: string | null
  versions: BackupVersionDto[]
  grid: { columns: Dict[]; rows: Dict[] }
  file: { path?: string; name?: string }
}

// ------------------------------------------------------------------ editor ---
export interface EditorInfo { text: string; hash: string; newline: string; bom: boolean; size: number; writable: boolean }
export interface BackupVersionDto { name: string; when: string; size: number; file: string }
export type EditorSaveResult =
  | { ok: true; changed: boolean; warning: string | null; id: string }
  | { ok: false; conflict: boolean; error: string }

// ------------------------------------------------------------------ presets ---
export interface PresetSummary { slug: string; name: string; saved_at: string; host: string }
export interface SavedSource { kind: 'defaults' | 'recent' | 'preset'; key: string; label: string; run_id?: string; slug?: string }

// -------------------------------------------------------------------- runs ---
export type RunMode = 'normal' | 'trace' | 'debug'

export interface RunForm {
  script: ScriptDto
  /** set when the metadata is invalid: the form cannot be shown */
  blocked: string | null
  fields: Dict[]
  hosts: string[]
  host: string
  source: SavedSource | null
  warnings: string[]
  presets: PresetSummary[]
  recent: Dict[]
  hasPassword: boolean
  modesSupported: boolean
}

export type StartRunResult =
  | { ok: true; runId: string }
  | { ok: false; errors: Record<string, string>; hostError: string | null; host: string; source: SavedSource | null; warnings: string[]; fields: Dict[] }

export interface TraceState { line: number | null; stopped: boolean }
export interface DebugState { state: string; line: number | null; scopes: Dict[]; stack: Dict[]; breakpoints: number[]; [k: string]: any }

export interface RunStatus {
  status: string
  status_label: string
  active: boolean
  exit_code: number | null
  started_at: string | null
  finished_at: string | null
  queued_at: string | null
  duration: string
  duration_seconds: number | null
  queue_position: number | null
  error: string | null
  pid: number | null
  stdout: string
  stdout_next: number
  stderr: string
  stderr_next: number
  trace: TraceState | null
  debug: DebugState | null
}

export interface RunConsole {
  run: Dict
  statusLabel: string
  active: boolean
  paramRows: Array<[string, string]>
  trace: Dict | null
  debug: boolean
  traceLines: string[] | null
  traceLang: string
}

export interface HistoryPage {
  runs: Dict[]
  f: { q: string; kind: string; script: string; status: string; date_from: string; date_to: string }
  scripts: Array<[string, string]>
  sequenceChoices: Array<[string, string]>
  statuses: Array<[string, string]>
  total: number
  page: number
  pages: number
  first: number
  last: number
  filtered: boolean
  historyDays: number
  logDays: number
  running: RunningPanel
}
export interface RunningPanel { active: Dict[]; activeSeqs: Dict[]; activeTotal: number }

// --------------------------------------------------------------- sequences ---
export interface GraphStep {
  id: string; n: number; script: string; name: string; ext: string; path: string; host: string; source: string
  problem: string; x: number; y: number; join: string; incoming: number
}
export interface GraphLink { from: string; to: string; when: 'success' | 'failure' | 'always' }
export interface SequenceGraph {
  steps: GraphStep[]
  links: GraphLink[]
  passwords: Array<{ input: string; label: string; step: number; script: string; required: boolean }>
}
export interface SequenceDetail {
  seq: Dict
  graph: SequenceGraph
  runs: Dict[]
  activeRun: string | null
  token: string
  maxSteps: number
}
export type GraphOpResult = { ok: true; id?: string; graph: SequenceGraph } | { ok: false; error: string; graph: SequenceGraph }

export interface RunGraph {
  steps: Array<{ id: string; n: number; script: string; name: string; ext: string; path: string; host: string; x: number; y: number; join: string; status: string; status_label: string; run_id: string | null; error: string | null; hold: boolean; held: boolean }>
  links: GraphLink[]
}
export interface SequenceRunStatus {
  id: string; status: string; status_label: string; active: boolean; paused: boolean; error: string | null
  duration: string; done: number; total: number; graph: RunGraph
}
export type SequenceStartResult = { ok: true; run: string; token: string } | { ok: false; errors: string[] }

export interface StepForm {
  seq: Dict
  step: Dict
  n: number
  script: ScriptDto | null
  incoming: number
  fields: Dict[]
  warnings: string[]
  presets: PresetSummary[]
  source: string
  hosts: string[]
  defaultHost: string
  host: string
  join: string
  hasPassword: boolean
  problem: string | null
}
export type SaveStepResult = { ok: true } | { ok: false; errors: Record<string, string>; error: string | null }

// ---------------------------------------------------------------- settings ---
export interface SettingsForm {
  max_concurrent_executions: number | string
  max_concurrent_per_host: number | string
  default_timeout: number | string
  polling_interval: number | string
  history_retention_days: number | string
  log_retention_days: number | string
  ssh_connect_timeout: number | string
  enable_script_editing: boolean
  ssh_executable: string
  /** NAME=value lines */
  environment: string
  /** .ext=command lines */
  interpreters: string
  remote_interpreters: string
}
export interface SettingsState {
  form: SettingsForm
  sshHosts: string[]
  dataRows: Array<{ key: string; label: string; help: string; bytes: number; files: number; size: string }>
  dataLocation: { path: string; how: string }
}
export type SaveSettingsResult = { ok: true; form: SettingsForm } | { ok: false; errors: string[] }

// ----------------------------------------------------------------- project ---
export interface SampleProject { name: string; [k: string]: any }
export interface ProjectPreview { token: string; fileName: string; preview: Dict; destination: string; folderName: string }
export interface ProjectInstallResult { folder: string; files: number; sequences: string[]; presets: number; kept: string[]; warnings: string[] }
export interface ProjectExportResult { path: string; report: Dict }

// --------------------------------------------------------------------- app ---
export interface AppInfo {
  version: string
  runtimeDir: string
  runtimeMode: string
  platform: string
  editingEnabled: boolean
  pollingInterval: number
  /** Folder with the sample scripts (the Home panel opens it). */
  samplesDir: string
}
export interface NewScriptOptions {
  languages: Array<[string, string]>
  folder: string
  subFolders: string[]
  categories: string[]
  maxDepth: number
  form: { language: string; filename: string; subfolder: string; name: string; category: string }
}
export type NewScriptResult = { ok: true; id: string; path: string } | { ok: false; errors: string[] }
