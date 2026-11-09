/**
 * Starting a run: validated form values -> ExecutionSpec -> the execution manager, plus the saved-values
 * loader behind the Run form. Port of the non-view parts of runner/execution_views.py.
 */
import type { ConfigStore } from './config.js'
import type { Script } from './discovery.js'
import * as executor from './executor.js'
import { ExecutionError, type ExecutionSpec } from './executor.js'
import * as parameters from './parameters.js'
import type { ExecutionManager } from './processManager.js'
import type { Presets } from './presets.js'
import * as sshHosts from './sshHosts.js'

export type RunMode = 'normal' | 'trace' | 'debug'
export const RUN_MODES: RunMode[] = ['normal', 'trace', 'debug']

/** normal | trace | debug from a submitted form (the old `trace=1` checkbox still works). */
export function runMode(post: { mode?: string; trace?: string }): RunMode {
  if (post.mode && (RUN_MODES as string[]).includes(post.mode)) return post.mode as RunMode
  return post.trace === '1' ? 'trace' : 'normal'
}

export const paramsOf = (script: Script): any[] => (script.metaValid ? script.meta.parameters ?? [] : [])

/** Python's shlex.join. */
export const shlexJoin = (parts: string[]): string => parts.map(sshHosts.shlexQuote).join(' ')

export interface SavedSource {
  kind: 'defaults' | 'recent' | 'preset'
  key: string
  label: string
  run_id?: string
  slug?: string
}

export interface LoadedValues {
  raw: Record<string, any>
  host: string
  source: SavedSource
  warnings: string[]
}

export type StartResult =
  | { ok: true; runId: string }
  | { ok: false; errors: Record<string, string>; hostError: string | null; raw: Record<string, any>; host: string; source: SavedSource | null; warnings: string[] }

export class RunService {
  constructor(private deps: { config: ConfigStore; manager: ExecutionManager; presets: Presets; pythonExecutable?: string }) {}

  /** Turn validated values into an ExecutionSpec. Throws ExecutionError. */
  buildSpec(script: Script, host: string, params: any[], values: Record<string, any>, opts: { token?: string | null; trace?: boolean; debug?: boolean } = {}): ExecutionSpec {
    const cfg = this.deps.config.load()
    const interpreter = executor.resolveInterpreter(script.meta.interpreter, script.extension, host, cfg)
    const [argv, envFromParams] = parameters.buildArguments(params, values)
    const [masked] = parameters.buildArguments(params, values, true)
    const env = { ...cfg.environment, ...(script.meta.environment ?? {}), ...envFromParams }
    if (opts.debug && !executor.debugSupported(script.extension, interpreter)) throw new ExecutionError(executor.DEBUG_UNSUPPORTED)
    const trace = !!opts.trace || !!opts.debug
    if (trace && !executor.traceSupported(script.extension, interpreter))
      throw new ExecutionError('Line tracing is available for Python and Bash scripts only.')
    const shown = host === sshHosts.LOCAL
      ? shlexJoin([interpreter, script.path, ...masked])
      : `ssh ${host}: ${interpreter} - ${shlexJoin(masked)}`.trimEnd()
    return executor.makeSpec({
      scriptId: script.id, scriptName: script.name, scriptPath: script.path, extension: script.extension, interpreter, host, argv, env,
      cwd: script.meta.working_directory || null, timeout: cfg.default_timeout, parameters: parameters.redact(params, values),
      displayCommand: shown, token: opts.token ?? null, trace: trace ? {} : null, debug: !!opts.debug,
    })
  }

  checkHost(script: Script, host: string, hosts: string[]): string | null {
    if (!hosts.includes(host)) return 'Choose one of the listed hosts.'
    if (executor.BATCH_EXTENSIONS.includes(script.extension) && host !== sshHosts.LOCAL) return 'Batch files can only run on this computer (local).'
    return null
  }

  defaultHost(script: Script): string {
    return script.meta.host ?? sshHosts.LOCAL
  }

  hostsFor(script: Script): string[] {
    return sshHosts.allowedHosts([this.defaultHost(script)])
  }

  /** Whether Trace / Debug are offered (Python and Bash scripts with their default interpreter). */
  modesSupported(script: Script): boolean {
    try {
      const interp = executor.resolveInterpreter(script.meta.interpreter, script.extension, this.defaultHost(script), this.deps.config.load())
      return executor.traceSupported(script.extension, interp)
    } catch (e) {
      if (e instanceof ExecutionError) return false
      throw e
    }
  }

  /**
   * Values for the Run form. `key`: '' = automatic (last run, else defaults), '-' = defaults,
   * '@<n>' = n-th recent run, otherwise a preset slug.
   */
  loadSaved(script: Script, params: any[], key: string, hosts: string[], defaultHost: string): LoadedValues {
    const { presets } = this.deps
    let raw = parameters.defaultsRaw(params)
    let host = defaultHost
    let warnings: string[] = []
    let stored: any = null
    let source: SavedSource = { kind: 'defaults', key: '-', label: 'Defaults' }
    const ref = { id: script.id, path: script.path }
    if (key === '' || key.startsWith('@')) {
      let index = 0
      if (key) {
        index = /^-?\d+$/.test(key.slice(1)) ? parseInt(key.slice(1), 10) : -1
      }
      stored = presets.getRecent(ref, index)
      if (stored) {
        const when = String(stored.saved_at ?? '').replace('T', ' ').slice(0, 16)
        const name = index === 0 ? 'Last run' : stored.run_id || `Run ${index + 1}`
        source = { kind: 'recent', key: `@${index}`, label: name + (when ? ` · ${when}` : ''), run_id: stored.run_id ?? '' }
      } else if (key) warnings.push('Those saved values were not found; showing the defaults.')
    } else if (key !== '-') {
      stored = presets.getPreset(ref, key)
      if (!stored) warnings.push('That preset was not found; showing the defaults.')
      else source = { kind: 'preset', key, label: stored.name ?? key, slug: key }
    }
    if (stored) {
      ;[raw, warnings] = presets.applyPreset(params, stored)
      if (hosts.includes(stored.host)) host = stored.host
    }
    return { raw, host, source, warnings }
  }

  /**
   * Validate and hand the run to the manager (the Run form's submit). `fromPreset` (a preset slug or '@<n>')
   * runs saved values as they are. Failures come back as data for the form to show.
   */
  start(script: Script, input: { host?: string; raw?: Record<string, any>; fromPreset?: string; mode?: RunMode; token?: string | null; initiator?: string }): StartResult {
    const params = paramsOf(script)
    const defaultHost = this.defaultHost(script)
    const hosts = this.hostsFor(script)
    let source: SavedSource | null = null
    let warnings: string[] = []
    let raw: Record<string, any>
    let host: string
    if (input.fromPreset) {
      const loaded = this.loadSaved(script, params, input.fromPreset, hosts, defaultHost)
      ;({ raw, host, source, warnings } = loaded)
      if (warnings.length) return { ok: false, errors: {}, hostError: null, raw, host, source, warnings } // not found: show the form
    } else {
      host = input.host ?? defaultHost
      raw = input.raw ?? parameters.defaultsRaw(params)
    }
    const [values, errors] = parameters.cleanValues(params, raw)
    let hostError = this.checkHost(script, host, hosts)
    let spec: ExecutionSpec | null = null
    const mode = input.mode ?? 'normal'
    if (!Object.keys(errors).length && !hostError) {
      try {
        spec = this.buildSpec(script, host, params, values, { token: input.token, trace: mode === 'trace', debug: mode === 'debug' })
      } catch (e) {
        if (!(e instanceof ExecutionError)) throw e
        hostError = e.message
      }
    }
    if (!spec) return { ok: false, errors, hostError, raw, host, source, warnings }
    const runId = this.deps.manager.submit(spec, input.initiator ?? 'local')
    try {
      this.deps.presets.recordRun({ id: script.id, path: script.path }, params, raw, host, runId, input.initiator ?? 'local')
    } catch {
      /* remembering the values is best effort */
    }
    return { ok: true, runId }
  }
}
