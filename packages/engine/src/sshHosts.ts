/**
 * SSH helpers. SSH itself is configured outside the app (~/.ssh/config, keys, agent); we only list host
 * aliases and shell out to the system `ssh`. Port of runner/ssh_hosts.py (plus the shlex bits it relies on).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Config } from './config.js'

export const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,254}$/
export const LOCAL = 'local'

// ------------------------------------------------------------------ shlex ---
/** Python's shlex.split. posix=false keeps quote characters in tokens (Windows paths). */
export function shlexSplit(text: string, opts: { posix?: boolean; comments?: boolean } = {}): string[] {
  const posix = opts.posix ?? true
  const comments = opts.comments ?? false
  const tokens: string[] = []
  let cur = ''
  let inWord = false
  let quoted = false
  let i = 0
  const push = () => {
    if (inWord || (posix && quoted)) tokens.push(cur)
    cur = ''
    inWord = false
    quoted = false
  }
  while (i < text.length) {
    const c = text[i]
    if (/\s/.test(c)) {
      push()
      i++
    } else if (comments && c === '#') {
      break
    } else if (c === "'" || c === '"') {
      const end = (() => {
        let j = i + 1
        while (j < text.length) {
          if (posix && c === '"' && text[j] === '\\' && (text[j + 1] === '"' || text[j + 1] === '\\')) {
            j += 2
            continue
          }
          if (text[j] === c) return j
          j++
        }
        return -1
      })()
      if (end < 0) throw new Error('No closing quotation')
      const body = text.slice(i + 1, end)
      if (posix) {
        cur += c === '"' ? body.replace(/\\(["\\])/g, '$1') : body
        quoted = true
      } else cur += c + body + c
      inWord = true
      i = end + 1
    } else if (posix && c === '\\') {
      if (i + 1 >= text.length) throw new Error('No escaped character')
      cur += text[i + 1]
      inWord = true
      i += 2
    } else {
      cur += c
      inWord = true
      i++
    }
  }
  push()
  return tokens
}

/** Python's shlex.quote. */
export function shlexQuote(s: string): string {
  if (s === '') return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s
  return "'" + s.replaceAll("'", `'"'"'`) + "'"
}

// ------------------------------------------------------------------ hosts ---
function sshDir(): string {
  return path.join(os.homedir(), '.ssh')
}

function globToRegExp(pattern: string): RegExp {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*').replace(/\?/g, '[^/\\\\]')
  return new RegExp('^' + esc + '$')
}

function globFiles(pattern: string): string[] {
  const dir = path.dirname(pattern)
  const re = globToRegExp(path.basename(pattern))
  try {
    return fs.readdirSync(dir).filter((n) => re.test(n)).sort().map((n) => path.join(dir, n))
  } catch {
    return []
  }
}

function parseFile(file: string, hosts: Set<string>, depth: number, home: string): void {
  let lines: string[]
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  } catch {
    return
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    let parts: string[]
    try {
      parts = shlexSplit(line, { posix: true, comments: true })
    } catch {
      continue
    }
    if (!parts.length) continue
    const key = parts[0].toLowerCase().replace(/=+$/, '')
    if (key === 'host') {
      for (const alias of parts.slice(1)) if (!/[*?!]/.test(alias) && HOST_RE.test(alias)) hosts.add(alias)
    } else if (key === 'include' && depth < 3) {
      for (let pattern of parts.slice(1)) {
        if (pattern.startsWith('~')) pattern = path.join(home, pattern.slice(1))
        if (!path.isAbsolute(pattern)) pattern = path.join(path.join(home, '.ssh'), pattern)
        for (const m of globFiles(pattern)) parseFile(m, hosts, depth + 1, home)
      }
    }
  }
}

/** Concrete `Host` aliases from ~/.ssh/config (wildcards are skipped). */
export function listHosts(home: string = os.homedir()): string[] {
  const hosts = new Set<string>()
  parseFile(path.join(home, '.ssh', 'config'), hosts, 0, home)
  return [...hosts].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
}

export function isValidHost(host: unknown): boolean {
  return host === LOCAL || (typeof host === 'string' && HOST_RE.test(host))
}

/** 'local' plus configured aliases (plus any alias a script names itself). */
export function allowedHosts(extra: Iterable<string> = [], home?: string): string[] {
  const out = [LOCAL, ...listHosts(home)]
  for (const h of extra) if (h && !out.includes(h) && isValidHost(h)) out.push(h)
  return out
}

/** Split a command line into arguments (Windows-path friendly). */
export function splitCommand(command: string, platform: NodeJS.Platform = process.platform): string[] {
  const win = platform === 'win32'
  let parts = shlexSplit(command, { posix: !win })
  if (win) parts = parts.map((p) => (p.length >= 2 && p[0] === p[p.length - 1] && '"\''.includes(p[0]) ? p.slice(1, -1) : p))
  return parts
}

/** The ssh command with non-interactive options. Never prompts. */
export function sshBase(cfg: Config): string[] {
  return [
    ...splitCommand(cfg.ssh_executable),
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${Math.trunc(Number(cfg.ssh_connect_timeout))}`,
  ]
}

export interface RemoteResult {
  code: number | null
  stdout: string
  stderr: string
}

export class RemoteTimeoutError extends Error {
  constructor() {
    super('timed out')
    this.name = 'RemoteTimeoutError'
  }
}

/** Run one short command on `host`. Rejects with RemoteTimeoutError, a spawn error (ENOENT), or Error('Invalid SSH host'). */
export function runRemote(host: string, remoteCommand: string, cfg: Config, timeoutSeconds = 30): Promise<RemoteResult> {
  if (!isValidHost(host) || host === LOCAL) return Promise.reject(new Error('Invalid SSH host'))
  const args = [...sshBase(cfg), '-T', '--', host, remoteCommand]
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout!.on('data', (b) => out.push(b))
    child.stderr!.on('data', (b) => err.push(b))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutSeconds * 1000)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) return reject(new RemoteTimeoutError())
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    })
  })
}

/** [ok, message] after a quick non-interactive login. */
export async function testConnection(host: string, cfg: Config): Promise<[boolean, string]> {
  let done: RemoteResult
  try {
    done = await runRemote(host, 'uname -sr 2>/dev/null || echo connected', cfg, 40)
  } catch (e: any) {
    if (e?.code === 'ENOENT') return [false, 'The ssh program was not found. Install OpenSSH or set ssh_executable.']
    if (e instanceof RemoteTimeoutError) return [false, 'Timed out waiting for the host.']
    return [false, String(e?.message ?? e)]
  }
  if (done.code === 0) return [true, done.stdout.trim().split(/\r?\n/)[0] || 'connected']
  const lines = done.stderr.trim().split(/\r?\n/).filter(Boolean)
  return [false, `ssh exited with ${done.code}: ${lines[lines.length - 1] ?? 'unknown error'}`]
}
