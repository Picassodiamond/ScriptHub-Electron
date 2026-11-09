/**
 * Every request the UI can make: name, zod argument schema and result type.
 * `Api[name]` = { args, result }. Arguments are validated by the engine side; results are typed only.
 */
import { z } from 'zod'
import type * as T from './dto.js'

/** `c<Result>()(argsSchema)` declares a call. */
const c = <R>() => <A extends z.ZodType>(args: A) => ({ args, result: undefined as unknown as R })

const id = z.string().min(1)
const dict = z.record(z.string(), z.any())
const none = z.object({})
const runMode = z.enum(['normal', 'trace', 'debug'])
const slug = z.string().min(1)

const graphOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), script: id, x: z.number().optional(), y: z.number().optional() }),
  z.object({ op: z.literal('move'), positions: z.record(z.string(), z.tuple([z.number(), z.number()])) }),
  z.object({ op: z.literal('remove'), id }),
  z.object({ op: z.literal('link'), from: id, to: id, when: z.enum(['success', 'failure', 'always']).optional() }),
  z.object({ op: z.literal('unlink'), from: id, to: id }),
])

const infoForm = z.object({
  name: z.string().default(''),
  description: z.string().default(''),
  category: z.string().default(''),
  interpreter: z.string().default(''),
  platforms: z.array(z.string()).default([]),
  host: z.string().default('local'),
  working_directory: z.string().default(''),
  environment: z.string().default(''),
})

const settingsForm = z.object({
  max_concurrent_executions: z.union([z.string(), z.number()]),
  max_concurrent_per_host: z.union([z.string(), z.number()]),
  default_timeout: z.union([z.string(), z.number()]),
  polling_interval: z.union([z.string(), z.number()]),
  history_retention_days: z.union([z.string(), z.number()]),
  log_retention_days: z.union([z.string(), z.number()]),
  ssh_connect_timeout: z.union([z.string(), z.number()]),
  enable_script_editing: z.boolean(),
  ssh_executable: z.string(),
  environment: z.string(),
  interpreters: z.string(),
  remote_interpreters: z.string(),
})

export const calls = {
  // ---- app
  'app.info': c<T.AppInfo>()(none),
  'app.shell': c<T.ShellState>()(none),
  'app.recover': c<{ runs: string[]; sequences: string[] }>()(none),
  /** Show a script's or a run's file in the system file manager (desktop only). */
  'app.reveal': c<{ ok: boolean }>()(z.object({ kind: z.enum(['script', 'run']), id })),

  // ---- workspace
  'workspace.overview': c<T.WorkspaceOverview>()(none),
  'workspace.open': c<{ opened: string[]; errors: string[]; scripts: number; problems: string[]; finished: boolean; scriptId: string | null }>()(
    z.object({ paths: z.array(z.string()).min(1) })),
  'workspace.closeFolder': c<{ scripts: number }>()(none),
  'workspace.closeFile': c<{ closed: boolean }>()(z.object({ path: z.string().optional(), all: z.boolean().optional() })),
  'workspace.favorite': c<{ path: string }>()(z.object({ path: id, on: z.boolean() })),
  'workspace.forget': c<{ ok: boolean }>()(z.object({ path: id })),
  'workspace.browse': c<T.BrowseResult>()(z.object({ path: z.string().default('') })),
  'workspace.scanStatus': c<T.ScanStatus>()(none),
  'workspace.rescan': c<{ count: number; problems: string[]; finished: boolean }>()(none),
  /** The system folder / file dialogs, through the host (null / [] when cancelled or unavailable). */
  'workspace.pickFolder': c<string | null>()(none),
  'workspace.pickFiles': c<string[]>()(none),

  // ---- scripts
  'scripts.list': c<T.LibraryState>()(none),
  'scripts.tree': c<T.TreeGroup[]>()(none),
  'scripts.get': c<T.ScriptDetail>()(z.object({ id })),
  'scripts.saveInfo': c<T.SaveResult>()(z.object({ id, form: infoForm })),
  'scripts.saveParameters': c<T.SaveResult>()(z.object({ id, parameters: z.array(dict) })),
  'scripts.source': c<T.ScriptSource>()(z.object({ id })),
  /** Centre of the script pages: source, editor state, saved-values grid. */
  'scripts.doc': c<T.ScriptDoc>()(z.object({ id })),
  /** Path of the script file for a download (the host saves/copies it). */
  'scripts.filePath': c<{ path: string; name: string }>()(z.object({ id })),
  /** Settings > Features. */
  'scripts.setEnabledEditing': c<{ enabled: boolean }>()(z.object({ enabled: z.boolean() })),

  // ---- editor
  'editor.read': c<{ info: T.EditorInfo | null; error: string | null; versions: T.BackupVersionDto[] }>()(z.object({ id })),
  'editor.save': c<T.EditorSaveResult>()(z.object({ id, text: z.string(), baseHash: z.string(), force: z.boolean().optional() })),
  'editor.restore': c<{ ok: true; id: string } | { ok: false; error: string }>()(
    z.object({ id, version: z.string().optional(), previous: z.boolean().optional() })),
  'editor.versions': c<T.BackupVersionDto[]>()(z.object({ id })),
  /** The text of one saved version (for the side-by-side diff in Versions…). */
  'editor.versionText': c<{ text: string }>()(z.object({ id, version: id })),

  // ---- newScript
  'newScript.options': c<T.NewScriptOptions>()(z.object({ from: z.string().optional() })),
  'newScript.create': c<T.NewScriptResult>()(
    z.object({ language: z.string(), filename: z.string(), subfolder: z.string().default(''), name: z.string().default(''), category: z.string().default('') })),

  // ---- runs
  'runs.form': c<T.RunForm>()(z.object({ scriptId: id, preset: z.string().optional() })),
  'runs.start': c<T.StartRunResult>()(
    z.object({ scriptId: id, host: z.string().optional(), values: dict.optional(), fromPreset: z.string().optional(), mode: runMode.optional(), token: z.string().optional() })),
  'runs.console': c<T.RunConsole>()(z.object({ id })),
  'runs.status': c<T.RunStatus>()(z.object({ id, out: z.number().int().min(0).default(0), err: z.number().int().min(0).default(0) })),
  'runs.stop': c<{ stopped: boolean; active: boolean }>()(z.object({ id })),
  'runs.stopTrace': c<{ ok: boolean }>()(z.object({ id })),
  'runs.debug': c<{ ok: boolean; debug: T.DebugState | null; error?: string }>()(
    z.object({ id, action: z.enum(['step', 'continue', 'pause', 'detach', 'breakpoints']), lines: z.array(z.number().int().min(1).max(10_000_000)).max(1000).optional() })),
  'runs.logPath': c<{ path: string; name: string }>()(z.object({ id, stream: z.enum(['stdout', 'stderr']) })),
  /** Start receiving run.status / run.output / debug.state events for a run, from these offsets. */
  'runs.watch': c<{ ok: boolean }>()(z.object({ id, out: z.number().int().min(0).default(0), err: z.number().int().min(0).default(0) })),
  'runs.unwatch': c<{ ok: boolean }>()(z.object({ id })),
  'runs.recent': c<T.Dict[]>()(z.object({ limit: z.number().int().min(1).max(200).default(40) })),
  'runs.running': c<T.RunningPanel>()(none),
  'runs.query': c<T.HistoryPage>()(
    z.object({ q: z.string().default(''), kind: z.string().default(''), script: z.string().default(''), status: z.string().default(''), dateFrom: z.string().default(''), dateTo: z.string().default(''), page: z.number().int().min(1).default(1) })),
  'runs.delete': c<{ deleted: boolean }>()(z.object({ id })),
  'runs.deleteOlder': c<{ runs: number; sequences: number }>()(z.object({ days: z.number().int().min(0).max(36500) })),
  'runs.applyRetention': c<{ runs_removed: number; logs_removed: number; sequences_removed: number }>()(none),

  // ---- presets
  'presets.list': c<{ presets: T.PresetSummary[]; recent: T.Dict[] }>()(z.object({ scriptId: id })),
  'presets.save': c<{ ok: true; slug: string; updated: boolean } | { ok: false; error: string }>()(
    z.object({ scriptId: id, name: z.string(), host: z.string().optional(), values: dict })),
  'presets.rename': c<{ ok: true; slug: string } | { ok: false; error: string }>()(z.object({ scriptId: id, slug, newName: z.string() })),
  'presets.delete': c<{ removed: boolean }>()(z.object({ scriptId: id, slug })),
  'presets.grid': c<{ columns: T.Dict[]; rows: T.Dict[] }>()(z.object({ scriptId: id })),

  // ---- sequences
  'sequences.list': c<{ sequences: T.SequenceSummary[]; runs: T.Dict[] }>()(none),
  'sequences.get': c<T.SequenceDetail>()(z.object({ slug })),
  'sequences.create': c<{ ok: true; slug: string } | { ok: false; error: string }>()(z.object({ name: z.string() })),
  'sequences.rename': c<{ ok: true } | { ok: false; error: string }>()(z.object({ slug, name: z.string() })),
  'sequences.delete': c<{ deleted: boolean }>()(z.object({ slug })),
  'sequences.favorite': c<{ ok: boolean }>()(z.object({ slug, on: z.boolean() })),
  'sequences.graph': c<T.SequenceGraph>()(z.object({ slug })),
  'sequences.graphOp': c<T.GraphOpResult>()(z.object({ slug, op: graphOp })),
  'sequences.step': c<T.StepForm>()(z.object({ slug, stepId: id })),
  'sequences.saveStep': c<T.SaveStepResult>()(
    z.object({ slug, stepId: id, source: z.string().default('values'), host: z.string().default(''), join: z.string().optional(), values: dict.optional() })),
  'sequences.start': c<T.SequenceStartResult>()(
    z.object({ slug, only: z.string().optional(), passwords: z.record(z.string(), z.record(z.string(), z.string())).optional(), token: z.string().optional() })),
  'sequences.runs': c<T.Dict[]>()(z.object({ slug: z.string().optional(), limit: z.number().int().min(1).max(500).default(15) })),
  'sequences.run': c<{ run: T.Dict; graph: T.RunGraph; seqExists: boolean }>()(z.object({ id })),
  'sequences.runStatus': c<T.SequenceRunStatus>()(z.object({ id })),
  'sequences.stop': c<{ ok: boolean; error?: string }>()(z.object({ id })),
  'sequences.pause': c<{ ok: boolean; error?: string }>()(z.object({ id })),
  'sequences.resume': c<{ ok: boolean; error?: string }>()(z.object({ id })),
  'sequences.hold': c<{ ok: boolean; error?: string }>()(z.object({ id, step: id, on: z.boolean().default(true) })),
  'sequences.deleteRun': c<{ deleted: boolean }>()(z.object({ id })),
  'sequences.watchRun': c<{ ok: boolean }>()(z.object({ id })),
  'sequences.unwatchRun': c<{ ok: boolean }>()(z.object({ id })),

  // ---- settings
  'settings.get': c<T.SettingsState>()(none),
  'settings.save': c<T.SaveSettingsResult>()(z.object({ form: settingsForm })),
  'settings.testHost': c<{ ok: boolean; message: string }>()(z.object({ host: id })),
  'settings.dataOverview': c<T.SettingsState['dataRows']>()(none),
  'settings.clear': c<{ messages: string[]; errors: string[] }>()(z.object({ kind: z.string() })),

  // ---- project (.scripthub files)
  'project.samples': c<T.SampleProject[]>()(none),
  /** Build the project file of the open folder and write it to `destination` (chosen by the host). */
  'project.export': c<T.ProjectExportResult>()(z.object({ name: z.string().optional(), destination: id })),
  /** Register a project file (chosen by the host dialog) and return its preview. */
  'project.open': c<T.ProjectPreview>()(z.object({ path: id })),
  'project.openSample': c<T.ProjectPreview>()(z.object({ name: id })),
  'project.install': c<T.ProjectInstallResult>()(z.object({ token: id, destination: id })),
  'project.cancel': c<{ ok: boolean }>()(z.object({ token: id })),
  'project.close': c<{ ok: boolean }>()(none),
} as const

export type CallName = keyof typeof calls
export type Api = { [K in CallName]: { args: z.input<(typeof calls)[K]['args']>; result: (typeof calls)[K]['result'] } }
export type ParsedArgs<K extends CallName> = z.output<(typeof calls)[K]['args']>
export const callNames = Object.keys(calls) as CallName[]

/** Validate and normalise the arguments of a call (throws ZodError). */
export function parseArgs<K extends CallName>(name: K, args: unknown): ParsedArgs<K> {
  return calls[name].args.parse(args ?? {}) as ParsedArgs<K>
}
