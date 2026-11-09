/**
 * The Engine: wires every service together for one data folder. Hosts (Electron, later VS Code)
 * create one Engine and call its services; nothing here knows about a window or a UI.
 */
import path from 'node:path'
import { Backups } from './backups.js'
import { ConfigStore } from './config.js'
import { Discovery } from './discovery.js'
import { History, HistoryOps } from './history.js'
import { Ids } from './ids.js'
import { MetadataStore } from './metadata.js'
import * as parameters from './parameters.js'
import { dataDirs, ensureRuntimeDirs, runtimeLocation, type DataDirs, type RuntimeMode } from './paths.js'
import { NewScript } from './newScript.js'
import { Presets } from './presets.js'
import { ProjectFiles } from './projectFiles.js'
import { ExecutionManager, FileRunStore } from './processManager.js'
import { RunService } from './runs.js'
import { RuntimeData } from './runtimeData.js'
import { ScriptEditor } from './scriptEditor.js'
import { SequenceRunner } from './sequenceRunner.js'
import { Sequences } from './sequences.js'
import { Workspace } from './workspace.js'

/** What the host provides; the engine never opens a dialog or a window itself. */
export interface HostServices {
  /** Folder picker (null = cancelled or unavailable). */
  pickFolder?(): Promise<string | null>
  pickFiles?(): Promise<string[]>
  notify?(title: string, body: string): void
  /** Show a file or folder in the system file manager. */
  reveal?(target: string): void
  /** Who started a run (recorded as `initiator`). */
  clientId?: string
}

export interface EngineOptions {
  /** Data folder; default: SCRIPTHUB_HOME, a portable `runtime` next to `appDir`, or the user data folder. */
  runtimeDir?: string
  /** The program's folder (relative settings paths and the portable data folder resolve against it). */
  appDir?: string
  /** Folder with the sample_projects/*.scripthub files (default: <appDir>/samples/sample_projects). */
  samplesDir?: string
  appVersion?: string
  mode?: RuntimeMode
  pythonExecutable?: string
  host?: HostServices
}

export class Engine {
  readonly dirs: DataDirs
  readonly mode: RuntimeMode
  /** Folder with the sample_projects/*.scripthub files; the sample scripts are its sibling `sample_scripts`. */
  readonly samplesDir: string
  readonly host: HostServices
  readonly ids: Ids
  readonly config: ConfigStore
  readonly workspace: Workspace
  readonly backups: Backups
  readonly metadata: MetadataStore
  readonly discovery: Discovery
  readonly history: History
  readonly historyOps: HistoryOps
  readonly presets: Presets
  readonly manager: ExecutionManager
  readonly sequences: Sequences
  readonly runs: RunService
  readonly sequencer: SequenceRunner
  readonly editor: ScriptEditor
  readonly runtimeData: RuntimeData
  readonly projects: ProjectFiles
  readonly newScript: NewScript

  constructor(opts: EngineOptions = {}) {
    const appDir = opts.appDir ?? process.cwd()
    const loc = opts.runtimeDir
      ? { dir: opts.runtimeDir, mode: opts.mode ?? ('env' as RuntimeMode) }
      : runtimeLocation({ portableDir: path.join(appDir, 'runtime') })
    this.dirs = dataDirs(loc.dir)
    this.mode = loc.mode
    this.samplesDir = opts.samplesDir ?? path.join(appDir, 'samples', 'sample_projects')
    this.host = opts.host ?? {}
    ensureRuntimeDirs(this.dirs)

    this.ids = new Ids(this.dirs)
    this.config = new ConfigStore(this.dirs)
    this.workspace = new Workspace(this.dirs, this.config, appDir)
    this.backups = new Backups(this.dirs)
    this.metadata = new MetadataStore(this.dirs, { ids: this.ids, backups: this.backups })
    this.discovery = new Discovery({ ids: this.ids, metadata: this.metadata, workspace: this.workspace, config: this.config })
    this.history = new History(this.dirs, this.ids)
    this.presets = new Presets(this.dirs, parameters as any)
    this.manager = new ExecutionManager({
      store: new FileRunStore(this.dirs), getConfig: () => this.config.load(), pythonExecutable: opts.pythonExecutable,
    })
    this.sequences = new Sequences(this.dirs, this.ids, this.discovery.lookup())
    this.runs = new RunService({ config: this.config, manager: this.manager, presets: this.presets, pythonExecutable: opts.pythonExecutable })
    this.sequencer = new SequenceRunner({
      dirs: this.dirs, manager: this.manager, history: this.history, sequences: this.sequences, presets: this.presets, runs: this.runs,
    })
    this.historyOps = new HistoryOps(this.history, {
      config: () => this.config.load() as any,
      sequenceRunsOlderThan: (days, now) => this.sequencer.deleteOlderThan(days, now),
    })
    this.editor = new ScriptEditor(this.backups, { python: opts.pythonExecutable })
    this.runtimeData = new RuntimeData({
      dirs: this.dirs, history: this.history, historyOps: this.historyOps, mode: this.mode,
      sequenceRuns: {
        list: () => this.sequencer.listRuns(),
        delete: (id: string) => this.sequencer.deleteRun(id),
        active: () => this.sequencer.activeRuns().length > 0,
      } as any,
      onWorkspaceCleared: () => void this.discovery.rescan(0),
    })
    this.projects = new ProjectFiles({
      dirs: this.dirs, config: this.config, discovery: this.discovery, workspace: this.workspace, sequences: this.sequences,
      presets: this.presets, appDir, samplesDir: this.samplesDir,
      appVersion: opts.appVersion,
    } as any)
    this.newScript = new NewScript({ workspace: this.workspace, config: this.config, discovery: this.discovery } as any)
  }

  /** Startup housekeeping: runs and sequence runs left over by a stopped app become Interrupted. */
  recover(): { runs: string[]; sequences: string[] } {
    return { runs: this.manager.recoverInterrupted(), sequences: this.sequencer.recoverInterrupted() }
  }
}
