/**
 * Builds and supervises the OS process for one execution. Port of runner/executor.py.
 *
 * Rules that matter for safety:
 *  - Processes are always started from an argument LIST, never through a shell (shell: false).
 *  - For remote runs the only string handed to a shell is the remote command, and every element of it
 *    passes through shlexQuote.
 *  - Batch files get a strict character check (cmd.exe re-parses arguments).
 */
import { execFile, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import type { Config } from './config.js'
import * as sshHosts from './sshHosts.js'
import * as tracing from './tracing.js'

export const LOCAL = sshHosts.LOCAL
export const BATCH_EXTENSIONS = ['.bat', '.cmd']
/** Characters cmd.exe treats specially; never allowed in batch arguments. */
const BATCH_FORBIDDEN = new Set('&|<>^%!"`\r\n\0')
export const PID_MARKER = Buffer.from('__SR_PID__', 'latin1')
/** Reads the script from stdin: the interpreter's "read program from stdin" flags. */
const STDIN_FLAGS: Record<string, string[]> = { bash: ['-s', '--'], sh: ['-s', '--'], zsh: ['-s', '--'], dash: ['-s', '--'] }
/** Runs on the remote host: report our PID, change directory, then exec the interpreter. */
export const REMOTE_WRAPPER = 'printf "__SR_PID__%s\\n" "$$"; cd -- "$1" || exit 126; shift; exec env "$@"'
export const DEBUG_UNSUPPORTED = 'Step debugging is available for Python and Bash scripts only.'

const WIN = () => process.platform === 'win32'

/** A run could not be prepared (shown to the user). */
export class ExecutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExecutionError'
  }
}

export interface ExecutionSpec {
  scriptId: string
  scriptName: string
  scriptPath: string
  extension: string
  interpreter: string
  host: string
  argv: string[]
  env: Record<string, string>
  cwd: string | null
  timeout: number
  /** A script runs one at a time (further runs wait in the queue); tests may lift it. */
  allowConcurrent: boolean
  /** Redacted copy for history. */
  parameters: Record<string, any>
  displayCommand: string
  token: string | null
  /** Line tracing: {} when requested (the manager adds "stopfile"), null when off. */
  trace: { stopfile?: string } | null
  /** Step debugging (implies tracing): the process reads control lines from stdin. */
  debug: boolean
  /** A step of a sequence: {run: "SEQ-…", step: "s1", name: "…"}, recorded with the run. */
  sequence: { run: string; step: string | number; name: string } | null
}

type SpecRequired = Pick<ExecutionSpec, 'scriptId' | 'scriptName' | 'scriptPath' | 'extension' | 'interpreter' | 'host' | 'argv'>

/** An ExecutionSpec with the Python dataclass defaults filled in. */
export function makeSpec(p: SpecRequired & Partial<ExecutionSpec>): ExecutionSpec {
  return {
    env: {}, cwd: null, timeout: 3600, allowConcurrent: false, parameters: {}, displayCommand: '',
    token: null, trace: null, debug: false, sequence: null, ...p,
  }
}

export interface Command {
  args: string[]
  stdin: Buffer | null
  env: Record<string, string>
  cwd: string | null
  remote: boolean
  /** Debugger: stdin stays open as the control channel. */
  keepStdinOpen: boolean
}

export interface BuildOptions {
  /** Used instead of a bare python/python3 interpreter (the Python app used sys.executable). */
  pythonExecutable?: string
}

export function exeStem(command: string): string {
  const base = path.basename(command.trim().replace(/^"+|"+$/g, '')).toLowerCase()
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(0, dot) : base
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** shutil.which: first match on PATH (PATHEXT on Windows), or null. */
export function which(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const win = WIN()
  const exts = win ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  const candidates = (base: string) => {
    const hasExt = win && path.extname(base) !== ''
    return hasExt ? [base, ...exts.map((e) => base + e)] : win ? exts.map((e) => base + e) : [base]
  }
  if (cmd.includes('/') || cmd.includes('\\')) {
    for (const c of candidates(cmd)) if (isFile(c)) return c
    return null
  }
  const pathVar = env.PATH ?? env.Path ?? ''
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue
    for (const c of candidates(path.join(dir.replace(/^"|"$/g, ''), cmd))) if (isFile(c)) return c
  }
  return null
}

function gitBashCandidates(): string[] {
  const bases = [process.env.ProgramW6432, process.env.ProgramFiles, 'C:\\Program Files', process.env['ProgramFiles(x86)']]
  if (process.env.LOCALAPPDATA) bases.push(path.join(process.env.LOCALAPPDATA, 'Programs'))
  const seen = new Set<string>()
  const out: string[] = []
  for (const base of bases) {
    if (!base || seen.has(base.toLowerCase())) continue
    seen.add(base.toLowerCase())
    const root = path.join(base, 'Git')
    out.push(path.join(root, 'bin', 'bash.exe'), path.join(root, 'usr', 'bin', 'bash.exe'))
  }
  return out
}

/**
 * Git Bash for a bare bash/sh on Windows: PATH first (but not WSL's System32 launcher, which cannot take C:/ paths),
 * then the usual Git for Windows folders. null when nothing is found.
 */
export function findWindowsShell(name: string): string | null {
  const found = which(name)
  if (found && !found.toLowerCase().replaceAll('/', '\\').split('\\').includes('system32')) return found
  for (const cand of gitBashCandidates()) if (isFile(cand)) return cand
  return null
}

function localInterp(interp: string[]): string[] {
  if (!WIN() || !interp.length) return interp
  const first = interp[0].replace(/^"+|"+$/g, '')
  if (path.dirname(first) !== '.' || !['bash', 'sh'].includes(exeStem(first))) return interp
  const found = findWindowsShell(exeStem(first))
  if (!found)
    throw new ExecutionError(
      'Bash was not found. Install Git for Windows (Git Bash) or add bash to PATH, or set the .sh interpreter in Settings.',
    )
  return [found, ...interp.slice(1)]
}

/** Interpreter command for this script on this host. */
export function resolveInterpreter(metaInterpreter: string | null | undefined, extension: string, host: string, cfg: Config): string {
  if (metaInterpreter) return metaInterpreter
  const table: Record<string, string> = host === LOCAL ? cfg.interpreters : cfg.remote_interpreters
  const ext = extension.toLowerCase()
  if (!(ext in table)) throw new ExecutionError(`No interpreter is configured for ${extension} files ${host === LOCAL ? 'locally' : 'on remote hosts'}.`)
  return table[ext]
}

function reprChar(c: string): string {
  if (c === '\r') return '\\r'
  if (c === '\n') return '\\n'
  if (c === '\0') return '\\x00'
  return c
}

export function checkBatchArgs(argv: string[]): void {
  for (const a of argv) {
    const bad = [...new Set(a)].filter((c) => BATCH_FORBIDDEN.has(c)).sort()
    if (bad.length) {
      throw new ExecutionError(
        `Value '${a}' contains characters that are not allowed for batch files (${bad.map(reprChar).join(' ')}). ` +
          'cmd.exe would interpret them as commands.',
      )
    }
  }
}

export function traceSupported(extension: string, interpreter: string): boolean {
  const parts = sshHosts.splitCommand(interpreter || '')
  return parts.length > 0 && tracing.kind(extension, exeStem(parts[0])) !== null
}

export function debugSupported(extension: string, interpreter: string): boolean {
  return traceSupported(extension, interpreter)
}

const asPosix = (p: string) => p.replaceAll('\\', '/')
const shownPath = (p: string) => (WIN() ? asPosix(p) : p)

function pyExe(interp: string[], stem: string, opts: BuildOptions): string[] {
  return ['python', 'python3'].includes(stem) && opts.pythonExecutable ? [opts.pythonExecutable] : interp
}

export function buildCommand(spec: ExecutionSpec, cfg: Config, opts: BuildOptions = {}): Command {
  const file = path.normalize(spec.scriptPath)
  const envExtra: Record<string, string> = { ...spec.env }
  let interp = sshHosts.splitCommand(spec.interpreter)
  if (!interp.length) throw new ExecutionError('The interpreter is empty.')
  const stem = exeStem(interp[0])
  if (stem.startsWith('python')) {
    envExtra.PYTHONUNBUFFERED ??= '1'
    envExtra.PYTHONUTF8 ??= '1'
  }

  const traced = spec.trace !== null || spec.debug
  const traceKind = traced ? tracing.kind(spec.extension, stem) : null
  if (spec.debug && traceKind === null) throw new ExecutionError(DEBUG_UNSUPPORTED)
  if (traced && traceKind === null) throw new ExecutionError('Line tracing is available for Python and Bash scripts only.')

  if (spec.host === LOCAL) {
    interp = localInterp(interp)
    if (spec.debug) return localDebug(spec, file, interp, stem, traceKind!, envExtra, opts)
    if (traceKind) return localTraced(spec, file, interp, stem, traceKind, envExtra, opts)
    let args: string[]
    if (BATCH_EXTENSIONS.includes(spec.extension)) {
      if (!WIN()) throw new ExecutionError('Batch files can only run on Windows.')
      checkBatchArgs(spec.argv)
      args = stem === 'cmd' ? ['cmd.exe', '/d', '/c', file, ...spec.argv] : [...interp, file, ...spec.argv]
    } else if (stem === 'python' || stem === 'python3') {
      args = [...pyExe(interp, stem, opts), file, ...spec.argv]
    } else if (WIN() && ['bash', 'sh', 'zsh'].includes(stem)) {
      args = [...interp, asPosix(file), ...spec.argv]
    } else {
      args = [...interp, file, ...spec.argv]
    }
    return { args, stdin: null, env: { ...(process.env as Record<string, string>), ...envExtra }, cwd: spec.cwd || path.dirname(file), remote: false, keepStdinOpen: false }
  }

  // ---- remote (SSH) ----
  if (BATCH_EXTENSIONS.includes(spec.extension)) throw new ExecutionError('Batch files can only run locally.')
  if (!sshHosts.isValidHost(spec.host)) throw new ExecutionError(`Invalid SSH host: '${spec.host}'`)
  let scriptBytes: Buffer
  try {
    scriptBytes = fs.readFileSync(file)
  } catch (e: any) {
    throw new ExecutionError(`Could not read the script: ${e.message}`)
  }
  let flags = STDIN_FLAGS[stem] ?? ['-']
  let keepOpen = false
  if (spec.debug) {
    // stdin = "<N>\n" + N bytes of script, then the debugger's control lines.
    keepOpen = true
    if (traceKind === 'python') flags = ['-c', tracing.PY_DEBUG_LAUNCHER, '-']
    else {
      scriptBytes = Buffer.concat([Buffer.from(tracing.bashDebugPrologue(1)), scriptBytes])
      flags = ['-c', tracing.BASH_DEBUG_LOADER, 'sr-debug']
    }
    scriptBytes = Buffer.concat([Buffer.from(String(scriptBytes.length) + '\n'), scriptBytes])
  } else if (traceKind === 'python') {
    flags = ['-c', tracing.PY_LAUNCHER, '-']
  } else if (traceKind === 'bash') {
    scriptBytes = Buffer.concat([tracing.bashPrologueLine(), scriptBytes])
  }
  const remoteEnv = Object.entries(envExtra).map(([k, v]) => `${k}=${v}`)
  const parts = ['sh', '-c', REMOTE_WRAPPER, 'sh', spec.cwd || '.', ...remoteEnv, ...interp, ...flags, ...spec.argv]
  const remoteCommand = parts.map(sshHosts.shlexQuote).join(' ')
  const args = [...sshHosts.sshBase(cfg), '-T', '--', spec.host, remoteCommand]
  return { args, stdin: scriptBytes, env: { ...(process.env as Record<string, string>) }, cwd: null, remote: true, keepStdinOpen: keepOpen }
}

function localDebug(spec: ExecutionSpec, file: string, interp: string[], stem: string, traceKind: string, envExtra: Record<string, string>, opts: BuildOptions): Command {
  const stopfile = spec.trace?.stopfile || ''
  const cwd = spec.cwd || path.dirname(file)
  let args: string[]
  if (traceKind === 'python') {
    args = [...pyExe(interp, stem, opts), '-c', tracing.PY_DEBUG_LAUNCHER, file, ...spec.argv]
  } else {
    const folder = stopfile ? path.dirname(stopfile) : path.dirname(file)
    const prologue = path.join(folder, 'debug_prologue.sh')
    fs.writeFileSync(prologue, tracing.bashDebugPrologueFile())
    envExtra.BASH_ENV = shownPath(prologue)
    args = [...interp, shownPath(file), ...spec.argv]
  }
  return { args, stdin: Buffer.alloc(0), env: { ...(process.env as Record<string, string>), ...envExtra }, cwd, remote: false, keepStdinOpen: true }
}

function localTraced(spec: ExecutionSpec, file: string, interp: string[], stem: string, traceKind: string, envExtra: Record<string, string>, opts: BuildOptions): Command {
  const stopfile = spec.trace?.stopfile || ''
  envExtra.SR_TRACE_STOPFILE = stopfile
  const cwd = spec.cwd || path.dirname(file)
  let args: string[]
  if (traceKind === 'python') {
    args = [...pyExe(interp, stem, opts), '-c', tracing.PY_LAUNCHER, file, ...spec.argv]
  } else {
    const prologue = stopfile ? path.join(path.dirname(stopfile), 'trace_prologue.sh') : file.replace(/\.[^.\\/]*$/, '') + '.trace.sh'
    fs.writeFileSync(prologue, tracing.bashPrologueFile(stopfile))
    envExtra.SR_TRACE_STOPFILE = stopfile ? shownPath(stopfile) : ''
    envExtra.BASH_ENV = shownPath(prologue)
    args = [...interp, shownPath(file), ...spec.argv]
  }
  return { args, stdin: null, env: { ...(process.env as Record<string, string>), ...envExtra }, cwd, remote: false, keepStdinOpen: false }
}

/** Resolves once `proc` has exited (or immediately if it already has). */
function exited(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
    proc.once('exit', () => resolve())
    proc.once('error', () => resolve())
  })
}

const hasExited = (proc: ChildProcess) => proc.exitCode !== null || proc.signalCode !== null
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Stop a local process and its children (taskkill /T /F on Windows, the process group elsewhere). */
export async function killTree(proc: ChildProcess, graceMs = 3000): Promise<void> {
  if (hasExited(proc) || !proc.pid) return
  if (WIN()) {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { timeout: 15000, windowsHide: true }, (err) => {
        if (err) try { proc.kill() } catch { /* ignore */ }
        resolve()
      })
    })
    return
  }
  try { process.kill(-proc.pid, 'SIGTERM') } catch { /* already gone */ }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline && !hasExited(proc)) await sleep(100)
  if (!hasExited(proc)) {
    try { process.kill(-proc.pid, 'SIGKILL') } catch { try { proc.kill('SIGKILL') } catch { /* ignore */ } }
  }
}

/** Ask the remote host to stop the script (best effort). */
export async function remoteStop(spec: ExecutionSpec, remotePid: unknown, cfg: Config): Promise<void> {
  if (typeof remotePid !== 'number' || !Number.isInteger(remotePid) || remotePid <= 1) return
  const n = remotePid
  const cmd =
    `pkill -TERM -P ${n} 2>/dev/null; kill -TERM ${n} 2>/dev/null; i=0; ` +
    `while kill -0 ${n} 2>/dev/null && [ $i -lt 5 ]; do sleep 1; i=$((i+1)); done; ` +
    `pkill -KILL -P ${n} 2>/dev/null; kill -KILL ${n} 2>/dev/null; true`
  try {
    await sshHosts.runRemote(spec.host, cmd, cfg, 30)
  } catch {
    /* best effort */
  }
}

export async function stop(spec: ExecutionSpec, proc: ChildProcess, remotePid: unknown, cfg: Config): Promise<void> {
  if (spec.host !== LOCAL) {
    await remoteStop(spec, remotePid, cfg)
    if (!hasExited(proc)) {
      try { proc.kill() } catch { /* ignore */ }
      await Promise.race([exited(proc), sleep(5000)])
      if (!hasExited(proc)) try { proc.kill('SIGKILL') } catch { /* ignore */ }
    }
  } else await killTree(proc)
}

export interface PumpOptions {
  /** Called with the PID if the very first line is the remote PID marker; that line is not written to the log. */
  onMarker?: ((pid: number) => void) | null
  onTrace?: ((numbers: number[]) => void) | null
  onEvent?: ((kind: 'P' | 'R' | 'V', value: any) => void) | null
}

/**
 * Copy `stream` into `file` as data arrives (unbuffered, so the UI sees output live). Resolves when the stream ends.
 */
export function pump(stream: Readable, file: string, opts: PumpOptions = {}): Promise<void> {
  fs.appendFileSync(file, '')
  let checking = !!opts.onMarker
  let pending = Buffer.alloc(0)
  const filt = opts.onTrace || opts.onEvent ? new tracing.MarkerFilter(opts.onTrace, opts.onEvent) : null
  const write = (b: Buffer) => {
    if (b.length) fs.appendFileSync(file, b)
  }
  return new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      try {
        if (checking && pending.length) write(pending)
        if (filt) write(filt.flush())
      } catch { /* ignore */ }
      resolve()
    }
    stream.on('data', (raw: Buffer) => {
      try {
        let chunk = raw
        if (filt) {
          chunk = filt.feed(chunk)
          if (!chunk.length) return
        }
        if (checking) {
          pending = Buffer.concat([pending, chunk])
          if (pending.indexOf(10) < 0 && pending.length < 256) return
          checking = false
          const nl = pending.indexOf(10)
          const first = nl < 0 ? pending : pending.subarray(0, nl)
          const rest = nl < 0 ? Buffer.alloc(0) : pending.subarray(nl + 1)
          const all = pending
          pending = Buffer.alloc(0)
          if (first.subarray(0, PID_MARKER.length).equals(PID_MARKER)) {
            const n = Number(first.subarray(PID_MARKER.length).toString('latin1').trim())
            if (Number.isInteger(n) && /^\s*\d+\s*$/.test(first.subarray(PID_MARKER.length).toString('latin1'))) opts.onMarker!(n)
            chunk = rest
          } else chunk = all
        }
        write(chunk)
      } catch { /* a log write failed: keep draining */ }
    })
    stream.on('end', finish)
    stream.on('close', finish)
    stream.on('error', finish)
  })
}

export function feedStdin(proc: ChildProcess, data: Buffer): void {
  const stdin = proc.stdin
  if (!stdin) return
  stdin.on('error', () => { /* the process may exit before reading everything */ })
  try {
    stdin.end(data)
  } catch { /* ignore */ }
}
