/**
 * Shared fixtures for the execution/tracing/debugger tests (port of EngineCase and FakeSshRemoteTests in
 * runner/test_execution.py). Real subprocesses, no mocks of the process layer; every case runs in its own
 * throwaway data folder and never touches a real runtime/.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect } from 'vitest'
import { defaultConfig } from '../src/config.js'
import { findWindowsShell, makeSpec, which, type ExecutionSpec } from '../src/executor.js'
import { dataDirs } from '../src/paths.js'
import { ExecutionManager, FileRunStore, FINAL_STATUSES } from '../src/processManager.js'

export const PY: string = which('python') ?? which('python3') ?? 'python'
export const PY_FWD = PY.replaceAll('\\', '/')
/** The bash to use, as a full path: on Windows a bare "bash" finds System32's WSL stub first. */
export const BASH: string | null = process.platform === 'win32' ? findWindowsShell('bash') : which('bash')
export const BASH_CMD = BASH ? `"${BASH}"` : 'bash'

export async function waitFor(predicate: () => boolean, timeoutMs = 15000, stepMs = 50): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, stepMs))
  }
  return false
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** textwrap.dedent */
export function dedent(text: string): string {
  const lines = text.split('\n')
  let common: string | null = null
  for (const l of lines) {
    if (!l.trim()) continue
    const indent = /^[ \t]*/.exec(l)![0]
    if (common === null || indent.length < common.length) common = indent
  }
  if (!common) return text
  return lines.map((l) => (l.trim() ? l.slice(common!.length) : '')).join('\n')
}

export interface CaseOptions {
  maxConcurrent?: number
  perHost?: number
  /** Install a fake `ssh` that runs the remote command in a local bash. */
  fakeSsh?: boolean
}

const made: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of made.splice(0).reverse()) await cleanup()
})

export function makeCase(opts: CaseOptions = {}) {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-test-')))
  const scripts = path.join(tmp, 'scripts dir') // a space on purpose
  fs.mkdirSync(scripts)
  const dirs = dataDirs(path.join(tmp, 'runtime'))
  const cfg: Record<string, any> = {
    ...defaultConfig(),
    max_concurrent_executions: opts.maxConcurrent ?? 3,
    max_concurrent_per_host: opts.perHost ?? 3,
  }
  const store = new FileRunStore(dirs)
  const mgr = new ExecutionManager({ store, getConfig: () => cfg, pythonExecutable: PY })
  const sshLog = path.join(tmp, 'ssh_calls.log')

  if (opts.fakeSsh) {
    const fake = path.join(tmp, 'fake_ssh.mjs')
    fs.writeFileSync(fake, [
      "import { spawnSync } from 'node:child_process'",
      "import fs from 'node:fs'",
      'const args = process.argv.slice(2)',
      "const i = args.indexOf('--')",
      "const host = args[i + 1], command = args.slice(i + 2).join(' ')",
      `fs.appendFileSync(${JSON.stringify(sshLog)}, host + ' :: ' + command + '\\n')`,
      "if (host === 'down') { process.stderr.write('ssh: connect to host down port 22: Connection refused\\n'); process.exit(255) }",
      `const r = spawnSync(${JSON.stringify(BASH)}, ['-c', command], { stdio: 'inherit' })`,
      'process.exit(r.status ?? 1)',
      '',
    ].join('\n'))
    cfg.ssh_executable = `"${process.execPath}" "${fake}"`
    cfg.remote_interpreters = { '.py': PY_FWD, '.sh': 'bash' }
  }

  made.push(async () => {
    for (const id of mgr.activeIds()) mgr.cancel(id)
    await mgr.waitIdle(20000)
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true })
        return
      } catch {
        await sleep(200)
      }
    }
  })

  const c = {
    tmp, scripts, dirs, cfg, store, mgr, sshLog,
    /** Write a script fixture (LF endings, dedented). */
    script(name: string, body: string): string {
      const p = path.join(scripts, name)
      fs.writeFileSync(p, dedent(body), 'utf8')
      return p
    },
    spec(file: string, argv: string[] = [], over: Partial<ExecutionSpec> = {}): ExecutionSpec {
      const ext = path.extname(file)
      const stem = path.basename(file, ext)
      return makeSpec({
        scriptId: stem, scriptName: stem, scriptPath: file, extension: ext, interpreter: 'python', host: 'local',
        argv, timeout: 30, allowConcurrent: true, ...over,
      })
    },
    meta(runId: string) {
      return store.readMeta(runId)!
    },
    readLog(runId: string, stream: 'stdout' | 'stderr'): string {
      try {
        return fs.readFileSync(store.logPath(runId, stream), 'utf8')
      } catch {
        return '' // not created yet
      }
    },
    async finished(runId: string, timeoutMs = 20000) {
      const ok = await waitFor(() => FINAL_STATUSES.includes(c.meta(runId).status), timeoutMs)
      expect(ok, JSON.stringify(c.meta(runId))).toBe(true)
      return c.meta(runId)
    },
    traceNumbers(runId: string): number[] {
      try {
        return fs.readFileSync(path.join(store.runDir(runId), 'trace.log'), 'utf8').split(/\s+/).filter(Boolean).map(Number)
      } catch {
        return []
      }
    },
  }
  return c
}

export type Case = ReturnType<typeof makeCase>

/** Fixtures that bash and the line numbers depend on must use LF endings. */
export function lf(file: string): string {
  fs.writeFileSync(file, fs.readFileSync(file).toString('latin1').replaceAll('\r\n', '\n'), 'latin1')
  return file
}
