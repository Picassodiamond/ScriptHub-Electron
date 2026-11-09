/**
 * The engine side of the protocol: one handler per call in `calls`, delegating to the Engine's services.
 * This is the view-level glue of the Python app (runner/*_views.py, context.py) without any HTML.
 * Expected failures are thrown as ApiError(code, message); everything else is a bug and propagates.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  ApiError, callNames, calls, parseArgs, type Api, type CallName, type Events, type ParsedArgs, type EventName,
} from '@scripthub/protocol'
import type * as T from '@scripthub/protocol'
import { validateConfig, ValidationError } from '../validators.js'
import type { Discovery, Script } from '../discovery.js'
import { ALL_PLATFORMS, defaultPlatforms, languageOf, MAX_DEPTH, PLATFORM_LABELS, relativePath } from '../discovery.js'
import type { Engine, HostServices } from '../engine.js'
import * as executor from '../executor.js'
import * as history from '../history.js'
import { pathId } from '../ids.js'
import * as metadata from '../metadata.js'
import * as parameters from '../parameters.js'
import { PresetError, savableValues } from '../presets.js'
import { validRunId as validSeqRunId } from '../sequenceRunner.js'
import { ConflictError, EditError, isWithin } from '../scriptEditor.js'
import * as sequences from '../sequences.js'
import { SequenceError } from '../sequences.js'
import * as sshHosts from '../sshHosts.js'
import { human, KEYS } from '../runtimeData.js'
import { slugName } from '../projectFiles.js'
import { atomicWriteText } from '../fsutil.js'
import { paramsOf, runMode } from '../runs.js'
import type { EngineWithPorts, NewScriptPort, ProjectsPort } from './ports.js'
import {
  activeRuns, ago, APP_VERSION, decorate, fieldsDto, LANGUAGES, mapToText, posix, readTextLimited, scriptDto, splitText, textToEnv, textToMap,
} from './util.js'
import { debugStateOf, runStatusOf, Watcher } from './watch.js'

export { ApiError }

export type Impl = {
  [K in CallName]: (args: ParsedArgs<K>) => Promise<Api[K]['result']> | Api[K]['result']
}

export interface Handlers {
  /** One function per protocol call (arguments already validated). */
  table: Impl
  /** Validate `args` against the call's zod schema, then run the handler. Throws ApiError. */
  call(name: string, args: unknown): Promise<unknown>
  /** Stop timers and watches. */
  dispose(): void
}

type Emit = <E extends EventName>(event: E, payload: Events[E]) => void
type Dict = Record<string, any>

const PER_PAGE = 20
const SEQ = 'seq:'
const INT_SETTINGS: Array<[keyof T.SettingsForm, string]> = [
  ['max_concurrent_executions', 'Max concurrent executions'],
  ['max_concurrent_per_host', 'Max concurrent executions per host'],
  ['default_timeout', 'Default timeout'],
  ['polling_interval', 'Polling interval'],
  ['history_retention_days', 'History retention'],
  ['log_retention_days', 'Log retention'],
  ['ssh_connect_timeout', 'SSH connect timeout'],
]

export function registerHandlers(engine: Engine, host: HostServices, emit: Emit): Handlers {
  const ports = engine as unknown as EngineWithPorts
  const initiator = host.clientId ?? 'local'

  let watcher: Watcher
  const sequenceStatusOf = (id: string): Events['sequence.status'] | null => {
    const data = engine.sequencer.readRun(id)
    if (!data) return null
    return seqRunStatus(engine.sequencer.liveView(data))
  }
  watcher = new Watcher(engine, emit as any, sequenceStatusOf)

  // A run or a sequence run started / finished anywhere: push the new counts instead of letting the UI poll.
  let lastRuns = new Set<string>()
  let lastSeqs = new Set<string>()
  const pushRuns = (): void => {
    const now = new Set(engine.manager.liveIds())
    const seqs = new Set(engine.sequencer.activeRuns().map((r) => String(r.id)))
    const started = [...now].filter((id) => !lastRuns.has(id))
    const finished = [...lastRuns].filter((id) => !now.has(id))
    const seqStarted = [...seqs].filter((id) => !lastSeqs.has(id))
    const seqFinished = [...lastSeqs].filter((id) => !seqs.has(id))
    lastRuns = now
    lastSeqs = seqs
    if (!started.length && !finished.length && !seqStarted.length && !seqFinished.length) return
    emit('runs.changed', { counts: engine.manager.counts(), started, finished, sequences: { started: seqStarted, finished: seqFinished } })
  }
  engine.manager.onChanged(pushRuns)
  engine.sequencer.onChanged(pushRuns)

  // ------------------------------------------------------------ helpers ---
  const err = (code: string, message: string, details?: unknown): never => {
    throw new ApiError(code, message, details)
  }
  const needScript = async (id: string): Promise<Script> => {
    const s = await engine.discovery.getScript(id)
    return s ?? err('not_found', 'Unknown script')
  }
  const needMeta = (id: string): Dict => {
    if (!history.validRunId(id)) return err('not_found', 'Unknown execution')
    return engine.history.readMeta(id) ?? err('not_found', 'Unknown execution')
  }
  const needSequence = (slug: string): sequences.SequenceData => {
    if (!sequences.validSlug(slug)) return err('not_found', 'Unknown sequence')
    try {
      return engine.sequences.load(slug)
    } catch (e) {
      if (e instanceof SequenceError) return err('not_found', e.message)
      throw e
    }
  }
  const needSeqRun = (id: string): Dict => {
    if (!validSeqRunId(id)) return err('not_found', 'Unknown sequence run')
    const data = engine.sequencer.readRun(id)
    return data ? engine.sequencer.liveView(data) : err('not_found', 'Unknown sequence run')
  }
  const editingOn = (): boolean => !!engine.config.load().enable_script_editing
  const needEditing = (): void => {
    if (!editingOn()) err('forbidden', 'Editing scripts is turned off in Settings.')
  }
  const ref = (s: Script) => ({ id: s.id, path: s.path })
  const changed = (reason: string, detail?: Dict): void => emit('workspace.changed', { reason, detail })
  const kickScan = (): void => watcher.watchScan()
  const hosts = (s: Script): string[] => engine.runs.hostsFor(s)
  const defaultHost = (s: Script): string => engine.runs.defaultHost(s)
  const currentId = async (s: Script): Promise<string> => (await engine.discovery.getScript(s.pathId))?.id ?? s.id

  // ----------------------------------------------------------- scripts ---
  const infoForm = (data: Dict, s: Script): T.InfoForm => {
    let plats = data.platforms
    if (!(Array.isArray(plats) && plats.length)) plats = defaultPlatforms(s.extension)
    return {
      name: data.name ?? '', description: data.description ?? '', category: data.category ?? '', interpreter: data.interpreter ?? '',
      platforms: plats, host: data.host ?? 'local', working_directory: data.working_directory ?? '',
      environment: mapToText(data.environment),
    }
  }

  const typeInfo = (): Record<string, T.ParamTypeInfo> =>
    Object.fromEntries(Object.entries(parameters.TYPES).map(([k, t]) => [k, { label: t.label, allowed: [...t.allowed].sort() }]))

  /** Validate and write metadata; returns errors (empty = saved). */
  const saveMeta = async (s: Script, next: Dict): Promise<string[]> => {
    try {
      const clean = parameters.validateMetadata(next)
      engine.metadata.saveRaw(s.path, s.id, clean, !!s.idConflict)
    } catch (e) {
      if (e instanceof ValidationError) return [...e.errors]
      if ((e as any)?.code) return [`Could not save metadata: ${(e as Error).message}`]
      throw e
    }
    engine.discovery.updateFile(s.path)
    return []
  }

  const renewCopiedId = async (s: Script): Promise<Script> => {
    if (!s.idConflict) return s
    const { data, error } = engine.metadata.loadRaw(s.path, s.id)
    if (error) return s
    try {
      engine.metadata.saveRaw(s.path, s.id, data, true)
    } catch {
      return s
    }
    engine.discovery.updateFile(s.path)
    return (await engine.discovery.getScript(s.pathId)) ?? s
  }

  const sourceOf = (s: Script): T.ScriptSource => {
    if (!isWithin(s.path, s.root)) return { text: '', lines: [], truncated: false, error: 'Script is outside its configured directory.', language: '', size: 0, metaText: '' }
    const [text, truncated, error] = readTextLimited(s.path)
    let metaText = ''
    if (s.metaSource !== null && !metadata.embedded({ path: s.path, metaSource: s.metaSource })) metaText = readTextLimited(s.metaSource)[0]
    let size = 0
    try { size = fs.statSync(s.path).size } catch { /* gone */ }
    return { text, lines: error ? [] : splitText(text), truncated, error, language: LANGUAGES[s.extension] ?? '', size, metaText }
  }

  const editorOf = (s: Script) => {
    if (!editingOn()) return { info: null as T.EditorInfo | null, error: null as string | null }
    try {
      return { info: engine.editor.readForEdit(s.path, s.root) as T.EditorInfo, error: null }
    } catch (e) {
      if (e instanceof EditError) return { info: null, error: e.message }
      throw e
    }
  }

  // ------------------------------------------------------------- tree ---
  const treeOf = async (): Promise<T.TreeGroup[]> => {
    const [scripts] = await engine.discovery.scan()
    const last = engine.history.lastRunByScript(200)
    const groups: T.TreeGroup[] = []
    const byCat = new Map<string, T.TreeGroup>()
    for (const s of scripts) {
      const status = last[s.id]?.status ?? null
      const item: T.TreeItem = {
        id: s.id, name: s.name, ext: s.extension.slice(1), relative: relativePath(s), category: s.category, runnable: s.metaValid,
        status, statusLabel: status ? history.STATUS_LABELS[status] ?? status : '',
      }
      if (!byCat.has(s.category)) {
        const g = { name: s.category, scripts: [] as T.TreeItem[] }
        byCat.set(s.category, g)
        groups.push(g)
      }
      byCat.get(s.category)!.scripts.push(item)
    }
    return groups
  }
  const sequenceList = (): T.SequenceSummary[] => {
    const favs = engine.workspace.sequenceFavorites()
    return engine.sequences.list().map((s) => ({ ...s, favorite: favs.includes(s.slug) }))
      .sort((a, b) => Number(!a.favorite) - Number(!b.favorite) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  }

  // -------------------------------------------------------- sequences ---
  const sourceLabel = (step: sequences.Step, s: Script | null): [string, string] => {
    if (step.preset) {
      if (s) {
        const p = engine.presets.getPreset(ref(s), step.preset)
        if (p) return [`Preset: ${p.name ?? step.preset}`, '']
      }
      return [`Preset: ${step.preset}`, 'not found']
    }
    return [Object.keys(step.values ?? {}).length ? 'Saved with the step' : 'Defaults', '']
  }

  const graphPayload = (data: sequences.SequenceData, scripts?: Array<Script | null>): T.SequenceGraph => {
    const resolved = scripts ?? data.steps.map((st) => engine.sequences.resolve(st) as Script | null)
    const steps: T.GraphStep[] = []
    const passwords: T.SequenceGraph['passwords'] = []
    data.steps.forEach((step, i) => {
      const s = resolved[i]
      const n = i + 1
      let [label, problem] = sourceLabel(step, s)
      if (s && !s.metaValid) problem = 'invalid metadata'
      const p = s ? s.path : step.path
      steps.push({
        id: step.id, n, script: s ? s.id : step.script, name: s ? s.name : step.name || step.script,
        ext: path.extname(p).replace(/^\./, '').toLowerCase(), path: p,
        host: s ? engine.sequencer.stepHost(step, s) : step.host || 'default', source: label,
        problem: problem || (s ? '' : 'script not found'), x: step.x, y: step.y, join: step.join,
        incoming: sequences.incoming(data, step.id).length,
      })
      if (s)
        for (const prm of engine.sequencer.passwordParams(s))
          passwords.push({ input: `pw_${step.id}_${prm.name}`, label: prm.label, step: n, script: s.name, required: !!prm.required })
    })
    return { steps, links: data.links.map((k) => ({ ...k })), passwords }
  }

  const liveRuns = (slug?: string, limit?: number): Dict[] => engine.sequencer.listRuns(slug, limit).map((r) => engine.sequencer.liveView(r))

  const runGraph = (data: Dict): T.RunGraph => ({
    steps: data.steps.map((s: Dict) => ({
      id: s.id, n: s.index, script: s.script_id || '', name: s.script_name || '', ext: s.ext || '', path: s.script_path || '',
      host: s.host || '', x: s.x, y: s.y, join: s.join ?? 'all', status: s.status, status_label: s.status_label,
      run_id: s.run_id ?? null, error: s.error ?? null, hold: !!s.hold, held: !!s.held,
    })),
    links: data.links ?? [],
  })
  function seqRunStatus(data: Dict): T.SequenceRunStatus {
    return {
      id: data.id, status: data.status, status_label: data.status_label, active: data.active, paused: data.paused,
      error: data.error ?? null, duration: data.duration, done: data.done, total: data.steps.length, graph: runGraph(data),
    }
  }

  const stepScriptParams = (s: Script): any[] => (s.metaValid ? (s.meta.parameters ?? []).filter((p: any) => p.type !== 'password') : [])

  // ------------------------------------------------------- history ---
  const when = (d: Dict): string => d.started_at || d.queued_at || d.finished_at || ''
  const seqHaystack = (d: Dict): string =>
    [d.id ?? '', d.name ?? '', d.sequence ?? '', d.status ?? '', history.STATUS_LABELS[d.status] ?? '', d.error ?? '', d.initiator ?? '', 'sequence',
      ...(d.steps ?? []).map((s: Dict) => s.script_name ?? '')].join(' ').toLowerCase()

  const matching = (f: Dict, dateFrom: string | null, dateTo: string | null, status: string): Array<['script' | 'sequence', Dict]> => {
    const seqSlug = f.script.startsWith(SEQ) ? f.script.slice(SEQ.length) : ''
    const scriptId = seqSlug ? '' : f.script
    const rows: Array<['script' | 'sequence', Dict]> = []
    if (f.kind !== 'sequences') {
      let [runs] = engine.historyOps.queryRuns({ q: f.q, scriptId, status, dateFrom, dateTo, page: 1, perPage: 1e9 })
      if (seqSlug) {
        const mine = new Set(engine.sequencer.listRuns(seqSlug).map((d) => d.id))
        runs = runs.filter((m) => mine.has((m.sequence ?? {}).run))
      }
      for (const m of runs) rows.push(['script', m])
    }
    if (f.kind !== 'scripts' && !scriptId) {
      for (const d of engine.sequencer.listRuns(seqSlug || undefined)) {
        if (status && d.status !== status) continue
        if (dateFrom || dateTo) {
          const t = engine.sequencer.referenceTime(d)
          const day = t ? history.localDate(t) : null
          if (!day || (dateFrom && day < dateFrom) || (dateTo && day > dateTo)) continue
        }
        if (f.q && !seqHaystack(d).includes(String(f.q).toLowerCase())) continue
        rows.push(['sequence', d])
      }
    }
    rows.sort((a, b) => {
      const ka = `${when(a[1])}\0${a[1].id ?? ''}`
      const kb = `${when(b[1])}\0${b[1].id ?? ''}`
      return ka < kb ? 1 : ka > kb ? -1 : 0
    })
    return rows
  }

  const historyRow = (kind: 'script' | 'sequence', data: Dict): Dict => {
    if (kind === 'sequence') return { ...engine.sequencer.liveView(data), kind: 'sequence' }
    const seq = data.sequence
    return {
      ...decorate(engine, data), kind: 'script', active: history.isActive(data), logs_deleted: !!data.logs_deleted,
      seq: seq && typeof seq === 'object' && seq.run ? seq : null,
      started_display: String(data.started_at || data.queued_at || '').replace('T', ' '),
    }
  }
  const runningPanel = (): T.RunningPanel => {
    const active = activeRuns(engine)
    const activeSeqs = engine.sequencer.activeRuns()
    return { active, activeSeqs, activeTotal: active.length + activeSeqs.length }
  }

  // ------------------------------------------------------- settings ---
  const settingsForm = (cfg: Dict): T.SettingsForm => {
    const form: Dict = {}
    for (const [k] of INT_SETTINGS) form[k] = cfg[k]
    return {
      ...form, enable_script_editing: !!cfg.enable_script_editing, ssh_executable: cfg.ssh_executable,
      environment: mapToText(cfg.environment), interpreters: mapToText(cfg.interpreters), remote_interpreters: mapToText(cfg.remote_interpreters),
    } as T.SettingsForm
  }
  const dataRows = () => engine.runtimeData.overview().map((r) => ({ ...r, size: human(r.bytes) }))

  // ------------------------------------------------------ the table ---
  const table: Impl = {
    // ---- app
    'app.info': () => ({
      version: APP_VERSION, runtimeDir: engine.dirs.runtime, runtimeMode: engine.mode, platform: process.platform,
      editingEnabled: editingOn(), pollingInterval: engine.config.load().polling_interval,
      samplesDir: path.join(path.dirname(engine.samplesDir), 'sample_scripts'),
    }),
    'app.shell': async () => {
      const tree = await treeOf()
      const folder = engine.workspace.overview()
      const cfg = engine.config.load()
      const palette = tree.flatMap((g) => g.scripts.map((s) => ({ id: s.id, name: s.name, cat: s.category, ext: s.ext, path: s.relative, run: s.runnable })))
      const list = sequenceList()
      return {
        tree, palette, folder: folder as T.WorkspaceOverview,
        folderPalette: [...folder.favorites, ...folder.recent].filter((x) => x.exists && !x.is_open).map((x) => ({ path: x.path, name: x.name, favorite: x.favorite })),
        sequences: list.filter((s) => !s.error).map((s) => ({ slug: s.slug, name: s.name })), sequenceList: list,
        scan: engine.discovery.status(), runs: engine.history.listRuns({ limit: 40 }).map((m) => decorate(engine, m)),
        counts: engine.manager.counts(), editingEnabled: !!cfg.enable_script_editing, pollingInterval: cfg.polling_interval, version: APP_VERSION,
      }
    },
    'app.recover': () => engine.recover(),
    'app.reveal': async ({ kind, id }) => {
      if (!host.reveal) return { ok: false }
      host.reveal(kind === 'script' ? (await needScript(id)).path : (needMeta(id), engine.history.runDir(id)))
      return { ok: true }
    },

    // ---- workspace
    'workspace.overview': () => engine.workspace.overview() as T.WorkspaceOverview,
    'workspace.open': async ({ paths }) => {
      const opened: string[] = []
      const errors: string[] = []
      for (const p of paths) {
        try {
          opened.push(engine.workspace.openFolder(p))
        } catch (e: any) {
          errors.push(e.message)
        }
      }
      if (!opened.length) return { opened, errors, scripts: 0, problems: [], finished: true, scriptId: null }
      const [scripts, problems, finished] = await engine.discovery.rescan()
      if (!finished) kickScan()
      changed('open', { opened })
      let scriptId: string | null = null
      if (opened.every((p) => fs.statSync(p).isFile())) {
        const found = await engine.discovery.getScript(pathId(fs.realpathSync.native(opened[0])))
        scriptId = found?.id ?? null
      }
      return { opened, errors, scripts: scripts.length, problems, finished, scriptId }
    },
    'workspace.closeFolder': async () => {
      engine.workspace.closeFolder()
      const [scripts] = await engine.discovery.rescan()
      changed('close')
      return { scripts: scripts.length }
    },
    'workspace.closeFile': async ({ path: p, all }) => {
      let closed: boolean
      if (all) {
        engine.workspace.closeAllFiles()
        closed = true
      } else closed = engine.workspace.closeFile(p ?? '')
      await engine.discovery.rescan()
      changed('close-file')
      return { closed }
    },
    'workspace.favorite': ({ path: p, on }) => {
      const stored = engine.workspace.setFavorite(p, on)
      changed('favorite')
      return { path: stored }
    },
    'workspace.forget': ({ path: p }) => {
      engine.workspace.forget(p)
      changed('forget')
      return { ok: true }
    },
    'workspace.browse': ({ path: p }) => engine.workspace.browse(p),
    'workspace.scanStatus': () => engine.discovery.status(),
    'workspace.rescan': async () => {
      const [scripts, problems, finished] = await engine.discovery.rescan()
      if (!finished) kickScan()
      return { count: scripts.length, problems, finished }
    },
    'workspace.pickFolder': async () => (host.pickFolder ? host.pickFolder() : null),
    'workspace.pickFiles': async () => (host.pickFiles ? host.pickFiles() : []),

    // ---- scripts
    'scripts.list': async () => {
      const [scripts, problems] = await engine.discovery.scan()
      const last = engine.history.lastRunByScript()
      const dtos = scripts.map((s) => {
        const run = last[s.id]
        const dto = scriptDto(s)
        dto.lastRun = run
          ? { id: run.id, status: run.status, label: history.STATUS_LABELS[run.status] ?? run.status, ago: ago(run.finished_at || run.started_at || run.queued_at) }
          : null
        return dto
      })
      const cmp = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase())
      const langs = new Map<string, string>()
      for (const s of scripts) langs.set(s.language, s.languageLabel)
      return {
        scripts: dtos, problems,
        categories: [...new Set(scripts.map((s) => s.category))].sort(cmp),
        languages: [...langs].sort((a, b) => cmp(a[1], b[1])),
        platforms: ALL_PLATFORMS.filter((k) => scripts.some((s) => s.platforms.includes(k))).map((k) => [k, PLATFORM_LABELS[k]] as [string, string]),
        interpreters: [...new Set(scripts.map((s) => s.interpreter).filter(Boolean))].sort(),
      }
    },
    'scripts.tree': () => treeOf(),
    'scripts.get': async ({ id }) => {
      const s = await needScript(id)
      const { data, error } = engine.metadata.loadRaw(s.path, s.id)
      const saved = engine.presets.listPresets(ref(s))
      const recent = engine.presets.recentRuns(ref(s))
      const form = infoForm(data, s)
      return {
        script: scriptDto(s), runs: engine.history.listRuns({ limit: 8, scriptId: s.id }).map((m) => decorate(engine, m)),
        presets: saved, recent, savedCount: saved.length + recent.length, form, params: Array.isArray(data.parameters) ? data.parameters : [],
        typeInfo: typeInfo(), platformChoices: Object.entries(PLATFORM_LABELS), hosts: sshHosts.allowedHosts([form.host]), loadError: error,
      }
    },
    'scripts.saveInfo': async ({ id, form }) => {
      const s = await needScript(id)
      const { data, error } = engine.metadata.loadRaw(s.path, s.id)
      const [environment, errors] = textToEnv(form.environment)
      if (error) errors.push(error + ' Fix the metadata block at the top of the script first.')
      if (errors.length) return { ok: false, errors }
      const next: Dict = { ...data }
      for (const k of ['name', 'description', 'category', 'interpreter'] as const) {
        const v = form[k].trim()
        if (v) next[k] = v
        else delete next[k]
      }
      next.parameters = Array.isArray(data.parameters) ? data.parameters : []
      const chosen = ALL_PLATFORMS.filter((p) => form.platforms.includes(p))
      const dflt = defaultPlatforms(s.extension)
      if (chosen.length && JSON.stringify(chosen) !== JSON.stringify(dflt)) next.platforms = chosen
      else delete next.platforms
      const h = form.host.trim() || 'local'
      if (h !== 'local') next.host = h
      else delete next.host
      const wd = form.working_directory.trim()
      if (wd) next.working_directory = wd
      else delete next.working_directory
      if (Object.keys(environment).length) next.environment = environment
      else delete next.environment
      const errs = await saveMeta(s, next)
      return errs.length ? { ok: false, errors: errs } : { ok: true, id: await currentId(s) }
    },
    'scripts.saveParameters': async ({ id, parameters: list }) => {
      const s = await needScript(id)
      const { data, error } = engine.metadata.loadRaw(s.path, s.id)
      if (error) return { ok: false, errors: [error + ' Fix the metadata block at the top of the script first.'] }
      const errs = await saveMeta(s, { ...data, parameters: list })
      return errs.length ? { ok: false, errors: errs } : { ok: true, id: await currentId(s) }
    },
    'scripts.source': async ({ id }) => sourceOf(await needScript(id)),
    'scripts.doc': async ({ id }) => {
      const s = await needScript(id)
      const ed = editorOf(s)
      return {
        source: sourceOf(s), editor: ed.info, editorError: ed.error, versions: ed.info ? (engine.backups.versions(s.id) as T.BackupVersionDto[]) : [],
        grid: engine.presets.grid(ref(s), paramsOf(s)), file: engine.presets.fileInfo(ref(s)),
      }
    },
    'scripts.filePath': async ({ id }) => {
      const s = await needScript(id)
      if (!isWithin(s.path, s.root)) err('forbidden', 'Script is outside its configured directory')
      return { path: s.path, name: path.basename(s.path) }
    },
    'scripts.setEnabledEditing': ({ enabled }) => {
      const cfg = engine.config.load()
      cfg.enable_script_editing = enabled
      engine.config.save(cfg)
      changed('settings')
      return { enabled }
    },

    // ---- editor
    'editor.read': async ({ id }) => {
      needEditing()
      const s = await needScript(id)
      const ed = editorOf(s)
      return { info: ed.info, error: ed.error, versions: engine.backups.versions(s.id) as T.BackupVersionDto[] }
    },
    'editor.save': async ({ id, text, baseHash, force }) => {
      needEditing()
      let s = await needScript(id)
      let result
      try {
        result = engine.editor.saveScript(s.path, s.root, text, baseHash, { force: !!force, sid: s.id })
      } catch (e) {
        if (e instanceof ConflictError) return { ok: false, conflict: true, error: e.message }
        if (e instanceof EditError) return { ok: false, conflict: false, error: e.message }
        throw e
      }
      s = await renewCopiedId(s)
      engine.discovery.updateFile(s.path)
      s = (await engine.discovery.getScript(s.pathId)) ?? s
      changed('script-saved', { id: s.id })
      return { ok: true, changed: result.changed, warning: result.warning, id: s.id }
    },
    'editor.restore': async ({ id, version, previous }) => {
      needEditing()
      let s = await needScript(id)
      try {
        engine.editor.restoreBackup(s.path, s.root, { sid: s.id, version: previous ? '' : version ?? '' })
      } catch (e) {
        if (e instanceof EditError) return { ok: false, error: e.message }
        throw e
      }
      engine.discovery.updateFile(s.path)
      s = (await engine.discovery.getScript(s.pathId)) ?? s
      changed('script-saved', { id: s.id })
      return { ok: true, id: s.id }
    },
    'editor.versions': async ({ id }) => engine.backups.versions((await needScript(id)).id) as T.BackupVersionDto[],
    'editor.versionText': async ({ id, version }) => {
      needEditing()
      const s = await needScript(id)
      try {
        return { text: new TextDecoder('utf-8').decode(engine.backups.read(s.id, version)) }
      } catch (e) {
        return err('not_found', e instanceof Error ? e.message : 'That version no longer exists.')
      }
    },

    // ---- newScript
    'newScript.options': async ({ from }) => {
      needEditing()
      const root = engine.workspace.current()
      if (!root || !fs.existsSync(root))
        err('no_folder', engine.workspace.currentIsFile() ? 'Only script files are open; open a folder to create new scripts in it.' : 'Open a script folder first; new scripts are saved in it.')
      const cfg = engine.config.load()
      const [scripts] = await engine.discovery.scan()
      const exts = [...new Set([...Object.keys(cfg.interpreters), ...Object.keys(cfg.remote_interpreters)])].sort()
      const subs = new Set(scripts.map((s) => posix(path.dirname(relativePath(s)))))
      subs.delete('.')
      const form = { language: '.py', filename: '', subfolder: '', name: '', category: '' }
      const base = from ? await engine.discovery.getScript(from) : null
      if (base) {
        const sub = posix(path.dirname(relativePath(base)))
        Object.assign(form, { language: base.extension, subfolder: sub === '.' ? '' : sub, category: base.metaValid ? base.meta.category ?? '' : '' })
      }
      const lc = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase())
      return {
        languages: exts.map((e) => [e, languageOf(e)[1]] as [string, string]), folder: root!, subFolders: [...subs].sort(lc),
        categories: [...new Set(scripts.map((s) => s.category).filter(Boolean))].sort(lc), maxDepth: MAX_DEPTH, form,
      }
    },
    'newScript.create': async ({ language, filename, subfolder, name, category }) => {
      needEditing()
      const port: NewScriptPort | undefined = ports.newScript
      if (!port) return err('unavailable', 'Creating scripts is not available yet.')
      const blocked = port.blocked()
      if (blocked) return err('no_folder', blocked)
      let made: { path: string; id: string }
      try {
        made = await port.create({ language, filename, subfolder, name, category })
      } catch (e: any) {
        return { ok: false, errors: [e.message] }
      }
      changed('script-created')
      return { ok: true, id: made.id, path: made.path }
    },

    // ---- runs
    'runs.form': async ({ scriptId, preset }) => {
      const s = await needScript(scriptId)
      const base = {
        script: scriptDto(s), blocked: null as string | null, fields: [] as Dict[], hosts: [] as string[], host: 'local', source: null as T.SavedSource | null,
        warnings: [] as string[], presets: [] as T.PresetSummary[], recent: [] as Dict[], hasPassword: false, modesSupported: false,
      }
      if (!s.metaValid) return { ...base, blocked: s.metaError ?? 'Invalid metadata' }
      const params = paramsOf(s)
      const hs = hosts(s)
      const loaded = engine.runs.loadSaved(s, params, preset ?? '', hs, defaultHost(s))
      return {
        ...base, fields: fieldsDto(parameters.buildFields(params, loaded.raw, {})), hosts: hs, host: loaded.host, source: loaded.source,
        warnings: loaded.warnings, presets: engine.presets.listPresets(ref(s)), recent: engine.presets.recentRuns(ref(s)),
        hasPassword: params.some((p) => p.type === 'password'), modesSupported: engine.runs.modesSupported(s),
      }
    },
    'runs.start': async ({ scriptId, host: h, values, fromPreset, mode, token }) => {
      const s = await needScript(scriptId)
      if (!s.metaValid) return err('invalid', 'This script cannot be run until its metadata is fixed.')
      const params = paramsOf(s)
      const raw = { ...parameters.defaultsRaw(params), ...(values ?? {}) }
      const r = engine.runs.start(s, { host: h, raw, fromPreset, mode: runMode({ mode }), token, initiator })
      if (r.ok) return { ok: true, runId: r.runId }
      return {
        ok: false, errors: r.errors, hostError: r.hostError, host: r.host, source: r.source as T.SavedSource | null, warnings: r.warnings,
        fields: fieldsDto(parameters.buildFields(params, r.raw, r.errors)),
      }
    },
    'runs.console': ({ id }) => {
      const meta = engine.history.canonicalScript(needMeta(id))
      const params: Dict = meta.parameters ?? {}
      const trace = meta.trace || null
      let traceLines: string[] | null = null
      if (trace) {
        try {
          const lines = fs.readFileSync(path.join(engine.history.runDir(id), 'trace_source'), 'utf8').split(/\r?\n/)
          if (lines.length && lines[lines.length - 1] === '') lines.pop()
          traceLines = lines
        } catch {
          traceLines = null
        }
      }
      const ext = path.extname(meta.script_path ?? '').toLowerCase()
      const empty = (v: any) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)
      return {
        run: meta, statusLabel: history.STATUS_LABELS[meta.status] ?? meta.status, active: history.isActive(meta),
        paramRows: Object.entries(params).map(([k, v]) => [k, empty(v) ? '—' : Array.isArray(v) ? v.join(', ') : String(v)] as [string, string]),
        trace, debug: !!meta.debug, traceLines, traceLang: LANGUAGES[ext] ?? '',
      }
    },
    'runs.status': ({ id, out, err: errOffset }) => runStatusOf(engine, id, needMeta(id), out, errOffset) as T.RunStatus,
    'runs.stop': ({ id }) => {
      const meta = needMeta(id)
      return { stopped: engine.manager.cancel(id), active: history.isActive(meta) }
    },
    'runs.stopTrace': ({ id }) => {
      needMeta(id)
      return { ok: engine.manager.stopTrace(id) }
    },
    'runs.debug': ({ id, action, lines }) => {
      needMeta(id)
      if (engine.manager.debugState(id) === null)
        return err('conflict', 'This execution is not being debugged, or it has finished.')
      const ok = engine.manager.debugCommand(id, action, action === 'breakpoints' ? [...new Set(lines ?? [])].sort((a, b) => a - b) : [])
      const debug = engine.manager.debugState(id) as unknown as T.DebugState | null
      return ok ? { ok, debug } : { ok, debug, error: 'The debugger did not accept the command (the run may be queued, detached or ending).' }
    },
    'runs.logPath': ({ id, stream }) => {
      needMeta(id)
      const p = engine.history.logPath(id, stream)
      if (!fs.existsSync(p)) return err('not_found', 'No output captured')
      return { path: p, name: `${id}-${stream}.log` }
    },
    'runs.watch': ({ id, out, err: e }) => {
      needMeta(id)
      watcher.watchRun(id, out, e)
      return { ok: true }
    },
    'runs.unwatch': ({ id }) => {
      watcher.unwatchRun(id)
      return { ok: true }
    },
    'runs.recent': ({ limit }) => engine.history.listRuns({ limit }).map((m) => decorate(engine, m)),
    'runs.running': () => runningPanel(),
    'runs.query': ({ q, kind, script, status, dateFrom, dateTo, page }) => {
      engine.historyOps.maybeApplyRetention()
      const f = { q: q.trim(), kind: ['scripts', 'sequences'].includes(kind.trim()) ? kind.trim() : '', script: script.trim(), status: status.trim(), date_from: dateFrom.trim(), date_to: dateTo.trim() }
      const st = history.ALL_STATUSES.includes(f.status) ? f.status : ''
      const rows = matching(f, history.parseDate(f.date_from), history.parseDate(f.date_to), st)
      const total = rows.length
      const pages = Math.max(1, Math.ceil(total / PER_PAGE))
      const pg = Math.min(page, pages)
      const cfg = engine.config.load()
      const seen = new Map<string, string>(engine.sequences.list().filter((s) => !s.error).map((s) => [s.slug, s.name]))
      for (const d of engine.sequencer.listRuns()) if (d.sequence && !seen.has(d.sequence)) seen.set(d.sequence, d.name || d.sequence)
      return {
        runs: rows.slice((pg - 1) * PER_PAGE, pg * PER_PAGE).map(([k, d]) => historyRow(k, d)), f,
        scripts: engine.historyOps.scriptChoices(),
        sequenceChoices: [...seen].map(([k, v]) => [SEQ + k, v] as [string, string]).sort((a, b) => a[1].toLowerCase().localeCompare(b[1].toLowerCase())),
        statuses: history.ALL_STATUSES.map((s) => [s, history.STATUS_LABELS[s]] as [string, string]),
        total, page: pg, pages, first: total ? (pg - 1) * PER_PAGE + 1 : 0, last: Math.min(pg * PER_PAGE, total),
        filtered: Object.values(f).some(Boolean), historyDays: cfg.history_retention_days, logDays: cfg.log_retention_days, running: runningPanel(),
      }
    },
    'runs.delete': ({ id }) => {
      needMeta(id)
      return { deleted: engine.historyOps.deleteRun(id) }
    },
    'runs.deleteOlder': ({ days }) => ({ runs: engine.historyOps.deleteOlderThan(days), sequences: engine.sequencer.deleteOlderThan(days) }),
    'runs.applyRetention': () => engine.historyOps.applyRetention(),

    // ---- presets
    'presets.list': async ({ scriptId }) => {
      const s = await needScript(scriptId)
      return { presets: engine.presets.listPresets(ref(s)), recent: engine.presets.recentRuns(ref(s)) }
    },
    'presets.save': async ({ scriptId, name, host: h, values }) => {
      const s = await needScript(scriptId)
      const params = paramsOf(s)
      const hs = hosts(s)
      const useHost = h && hs.includes(h) ? h : defaultHost(s)
      const raw = { ...parameters.defaultsRaw(params), ...values }
      const clean = name.split(/\s+/).filter(Boolean).join(' ').toLowerCase()
      const updated = engine.presets.listPresets(ref(s)).some((p) => p.name.toLowerCase() === clean)
      try {
        return { ok: true, slug: engine.presets.savePreset(ref(s), name, params, raw, useHost), updated }
      } catch (e) {
        if (e instanceof PresetError) return { ok: false, error: e.message }
        throw e
      }
    },
    'presets.rename': async ({ scriptId, slug, newName }) => {
      const s = await needScript(scriptId)
      try {
        return { ok: true, slug: engine.presets.renamePreset(ref(s), slug, newName) }
      } catch (e) {
        if (e instanceof PresetError) return { ok: false, error: e.message }
        throw e
      }
    },
    'presets.delete': async ({ scriptId, slug }) => {
      const s = await needScript(scriptId)
      try {
        return { removed: engine.presets.deletePreset(ref(s), slug) }
      } catch (e) {
        if (e instanceof PresetError) return err('invalid', e.message)
        throw e
      }
    },
    'presets.grid': async ({ scriptId }) => {
      const s = await needScript(scriptId)
      return engine.presets.grid(ref(s), paramsOf(s))
    },

    // ---- sequences
    'sequences.list': () => ({ sequences: sequenceList(), runs: liveRuns(undefined, 15) }),
    'sequences.get': ({ slug }) => {
      const data = needSequence(slug)
      const scripts = data.steps.map((st) => engine.sequences.resolve(st) as Script | null)
      engine.sequences.refresh(slug, data, scripts)
      const runs = liveRuns(slug, 10)
      const active = runs.find((r) => r.active)
      return {
        seq: data, graph: graphPayload(data, scripts), runs, activeRun: active ? active.id : null,
        token: crypto.randomUUID().replaceAll('-', ''), maxSteps: sequences.STEPS_MAX,
      }
    },
    'sequences.create': ({ name }) => {
      try {
        const slug = engine.sequences.create(name)
        changed('sequences')
        return { ok: true, slug }
      } catch (e: any) {
        if (e instanceof SequenceError) return { ok: false, error: e.message }
        return { ok: false, error: `Could not save the sequence: ${e?.message ?? e}` }
      }
    },
    'sequences.rename': ({ slug, name }) => {
      needSequence(slug)
      try {
        engine.sequences.rename(slug, name)
        changed('sequences')
        return { ok: true }
      } catch (e) {
        if (e instanceof SequenceError) return { ok: false, error: e.message }
        throw e
      }
    },
    'sequences.delete': ({ slug }) => {
      if (!sequences.validSlug(slug)) return err('not_found', 'Unknown sequence')
      if (!engine.sequences.delete(slug)) return err('not_found', 'Unknown sequence')
      engine.workspace.setSequenceFavorite(slug, false)
      changed('sequences')
      return { deleted: true }
    },
    'sequences.favorite': ({ slug, on }) => {
      if (!sequences.validSlug(slug) || !engine.sequences.get(slug)) return err('not_found', 'Unknown sequence')
      engine.workspace.setSequenceFavorite(slug, on)
      changed('sequences')
      return { ok: true }
    },
    'sequences.graph': ({ slug }) => graphPayload(needSequence(slug)),
    'sequences.graphOp': async ({ slug, op }) => {
      needSequence(slug)
      const out: { id?: string } = {}
      try {
        if (op.op === 'add') {
          const script = await engine.discovery.getScript(op.script)
          if (!script) throw new SequenceError('That script is not in the open folder (rescan, then try again).')
          const recent = script.metaValid ? engine.presets.getRecent(ref(script), 0) : null
          const params = script.metaValid ? script.meta.parameters ?? [] : []
          const values = savableValues(params, (recent as Dict | null)?.values ?? {})
          out.id = engine.sequences.addStep(slug, engine.sequences.newStep(script, values, '', op.x ?? 0, op.y ?? 0))
        } else if (op.op === 'move') engine.sequences.moveSteps(slug, op.positions as Record<string, [number, number]>)
        else if (op.op === 'remove') engine.sequences.removeStep(slug, op.id)
        else if (op.op === 'link') engine.sequences.link(slug, op.from, op.to, op.when ?? 'success')
        else engine.sequences.unlink(slug, op.from, op.to)
      } catch (e) {
        if (e instanceof SequenceError) return { ok: false, error: e.message, graph: graphPayload(engine.sequences.load(slug)) }
        throw e
      }
      return { ok: true, ...out, graph: graphPayload(engine.sequences.load(slug)) }
    },
    'sequences.step': ({ slug, stepId }) => {
      const data = needSequence(slug)
      let i: number
      try {
        i = sequences.find(data, stepId)
      } catch {
        return err('not_found', 'Unknown step')
      }
      const step = data.steps[i]
      const s = engine.sequences.resolve(step) as Script | null
      const base: T.StepForm = {
        seq: data, step, n: i + 1, script: s ? scriptDto(s) : null, incoming: sequences.incoming(data, stepId).length, fields: [], warnings: [],
        presets: [], source: step.preset || 'values', hosts: [], defaultHost: 'local', host: step.host, join: step.join, hasPassword: false,
        problem: !s ? 'script not found' : !s.metaValid ? 'invalid metadata' : null,
      }
      if (!s || !s.metaValid) return base
      const [raw, warnings, e] = engine.sequencer.stepRaw(step, s)
      if (e) warnings.push(`Values: ${e.charAt(0).toUpperCase()}${e.slice(1)}; the defaults are shown.`)
      const dh = defaultHost(s)
      return {
        ...base, fields: fieldsDto(parameters.buildFields(stepScriptParams(s), raw, {})), warnings, presets: engine.presets.listPresets(ref(s)),
        hosts: sshHosts.allowedHosts([dh, step.host]), defaultHost: dh, hasPassword: (s.meta.parameters ?? []).some((p: any) => p.type === 'password'),
      }
    },
    'sequences.saveStep': ({ slug, stepId, source, host: h, join: j, values }) => {
      const data = needSequence(slug)
      let step: sequences.Step
      try {
        step = data.steps[sequences.find(data, stepId)]
      } catch {
        return err('not_found', 'Unknown step')
      }
      const s = engine.sequences.resolve(step) as Script | null
      if (!s || !s.metaValid) return { ok: false, errors: {}, error: "This step's script cannot be configured (not found or invalid metadata)." }
      const params = stepScriptParams(s)
      const join = j && (sequences.JOIN as readonly string[]).includes(j) ? j : j ? 'all' : step.join
      const dh = defaultHost(s)
      if (h && !sshHosts.allowedHosts([dh, step.host]).includes(h)) return { ok: false, errors: {}, error: 'Choose one of the listed hosts.' }
      try {
        if (source === 'values') {
          const raw = { ...parameters.defaultsRaw(params), ...(values ?? {}) }
          const [, errors] = parameters.cleanValues(params, raw)
          if (Object.keys(errors).length) return { ok: false, errors, error: null }
          engine.sequences.updateStep(slug, stepId, { preset: '', values: savableValues(params, raw), host: h, join: join as sequences.Join })
        } else {
          if (!engine.presets.listPresets(ref(s)).some((p) => p.slug === source)) return { ok: false, errors: {}, error: 'That preset was not found.' }
          engine.sequences.updateStep(slug, stepId, { preset: source, values: {}, host: h, join: join as sequences.Join })
        }
      } catch (e) {
        if (e instanceof SequenceError) return { ok: false, errors: {}, error: e.message }
        throw e
      }
      return { ok: true }
    },
    'sequences.start': ({ slug, only, passwords, token }) => {
      let data = needSequence(slug)
      if (only) {
        const step = data.steps.find((st) => st.id === only)
        if (!step) return { ok: false, errors: ['That step is no longer in the sequence.'] }
        data = { ...data, steps: [step], links: [] }
      }
      const { items, errors } = engine.sequencer.prepare(data, passwords ?? {})
      if (errors.length) return { ok: false, errors }
      const rid = engine.sequencer.start(data, items, initiator, token ?? null)
      watcher.watchSequence(rid)
      return { ok: true, run: rid, token: crypto.randomUUID().replaceAll('-', '') }
    },
    'sequences.runs': ({ slug, limit }) => liveRuns(slug, limit),
    'sequences.run': ({ id }) => {
      const data = needSeqRun(id)
      return { run: data, graph: runGraph(data), seqExists: engine.sequences.get(data.sequence ?? '') !== null }
    },
    'sequences.runStatus': ({ id }) => seqRunStatus(needSeqRun(id)),
    'sequences.stop': ({ id }) => control(id, (r) => engine.sequencer.cancel(r)),
    'sequences.pause': ({ id }) => control(id, (r) => engine.sequencer.pause(r)),
    'sequences.resume': ({ id }) => control(id, (r) => engine.sequencer.resume(r)),
    'sequences.hold': ({ id, step, on }) => {
      needSeqRun(id)
      const ok = engine.sequencer.hold(id, step, on)
      return ok ? { ok } : { ok, error: 'That step has already started, or the run is over.' }
    },
    'sequences.deleteRun': ({ id }) => {
      needSeqRun(id)
      return { deleted: engine.sequencer.deleteRun(id) }
    },
    'sequences.watchRun': ({ id }) => {
      needSeqRun(id)
      watcher.watchSequence(id)
      return { ok: true }
    },
    'sequences.unwatchRun': ({ id }) => {
      watcher.unwatchSequence(id)
      return { ok: true }
    },

    // ---- settings
    'settings.get': () => ({
      form: settingsForm(engine.config.load()), sshHosts: sshHosts.listHosts(), dataRows: dataRows(), dataLocation: engine.runtimeData.location(),
    }),
    'settings.save': async ({ form }) => {
      const cfg = engine.config.load()
      const next: Dict = { ...cfg }
      const errors: string[] = []
      next.enable_script_editing = form.enable_script_editing
      for (const [k, label] of INT_SETTINGS) {
        const text = String(form[k]).trim()
        if (/^[-+]?\d+$/.test(text)) next[k] = parseInt(text, 10)
        else errors.push(`${label} must be a whole number.`) // the old value stays so the other checks still run
      }
      next.ssh_executable = form.ssh_executable.trim()
      const [env, envErrors] = textToEnv(form.environment)
      const [interp, iErrors] = textToMap(form.interpreters, 'Interpreters')
      const [remote, rErrors] = textToMap(form.remote_interpreters, 'Remote interpreters')
      next.environment = env
      next.interpreters = interp
      next.remote_interpreters = remote
      errors.push(...envErrors, ...iErrors, ...rErrors)
      try {
        validateConfig(next) // always validate so every problem is reported at once
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e
        errors.push(...e.errors)
      }
      if (errors.length) return { ok: false, errors }
      const saved = engine.config.save(next)
      await engine.discovery.rescan(1.0) // interpreters may have changed
      changed('settings')
      return { ok: true, form: settingsForm(saved) }
    },
    'settings.testHost': async ({ host: h }) => {
      if (h === sshHosts.LOCAL || !sshHosts.listHosts().includes(h)) return { ok: false, message: 'Unknown SSH host.' }
      const [ok, detail] = await sshHosts.testConnection(h, engine.config.load())
      return { ok, message: ok ? `${h}: connected (${detail})` : `${h}: ${detail}` }
    },
    'settings.dataOverview': () => dataRows(),
    'settings.clear': ({ kind }) => {
      const messages: string[] = []
      const errors: string[] = []
      for (const key of kind === 'all' ? KEYS : [kind]) {
        try {
          messages.push(engine.runtimeData.clear(key))
        } catch (e: any) {
          errors.push(e.message)
        }
      }
      changed('data-cleared', { kind })
      return { messages, errors }
    },

    // ---- project
    'project.samples': () => (ports.projects?.sampleProjects() ?? []) as T.SampleProject[],
    'project.export': ({ name, destination }) => {
      const p = needProjects()
      if (!engine.workspace.current()) err('no_folder', "Open a folder first: a project file holds the open folder's scripts and files.")
      const made = guard(() => p.saveCurrent(name))
      guard(() => atomicWriteText(destination, made.bytes))
      return { path: destination, report: { ...made.report, summary: made.summary, fileName: made.fileName } }
    },
    'project.open': ({ path: file }) => {
      const p = needProjects()
      return preview(p, guard(() => p.saveUploadFromFile(file)), path.basename(file))
    },
    'project.openSample': ({ name }) => {
      const p = needProjects()
      return preview(p, guard(() => p.importSample(name)), name + '.scripthub')
    },
    'project.install': async ({ token, destination }) => {
      const p = needProjects()
      const result = guard(() => p.install(p.uploadPath(token), destination))
      p.forgetUpload(token)
      try {
        engine.workspace.openFolder(result.folder)
        await engine.discovery.rescan()
      } catch (e: any) {
        result.warnings = [...result.warnings, e.message]
      }
      changed('project-installed', { folder: result.folder })
      return result
    },
    'project.cancel': ({ token }) => {
      ports.projects?.forgetUpload(token)
      return { ok: true }
    },
    'project.close': async () => {
      engine.workspace.closeFolder()
      engine.workspace.closeAllFiles()
      await engine.discovery.rescan()
      changed('close')
      return { ok: true }
    },
  }

  // ---- helpers that need `table` / ports in scope
  function control(id: string, action: (id: string) => boolean): { ok: boolean; error?: string } {
    needSeqRun(id)
    const ok = action(id)
    return ok ? { ok } : { ok, error: 'This sequence is not running.' }
  }
  function needProjects(): ProjectsPort {
    return ports.projects ?? err('unavailable', 'Project files are not available yet.')
  }
  function guard<R>(fn: () => R): R {
    try {
      return fn()
    } catch (e: any) {
      if (e instanceof ApiError) throw e
      throw new ApiError('invalid', e?.message ?? String(e))
    }
  }
  function preview(p: ProjectsPort, token: string, fileName: string): T.ProjectPreview {
    let info: Dict
    try {
      info = p.inspect(p.uploadPath(token))
    } catch (e: any) {
      p.forgetUpload(token)
      throw new ApiError('invalid', e?.message ?? String(e))
    }
    return { token, fileName, preview: info, destination: p.defaultDestination(info.name), folderName: slugName(info.name) }
  }

  const known = new Set<string>(callNames)
  return {
    table,
    async call(name: string, args: unknown) {
      if (!known.has(name)) throw new ApiError('unknown_call', `Unknown call: ${name}`)
      let parsed: unknown
      try {
        parsed = parseArgs(name as CallName, args)
      } catch (e: any) {
        throw new ApiError('invalid', 'Invalid arguments: ' + (e?.issues ? e.issues.map((i: any) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') : e?.message), e?.issues)
      }
      return (table[name as CallName] as (a: unknown) => unknown)(parsed)
    },
    dispose: () => watcher.dispose(),
  }
}

// referenced so the unused-import check stays quiet when ports are not wired
void calls
void executor
export type { Discovery }
