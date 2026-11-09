/** Where ScriptHub keeps its state ("runtime/"): same layout and rules as the Python app. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type RuntimeMode = 'env' | 'portable' | 'user'

export interface DataDirs {
  runtime: string
  configFile: string
  executions: string
  presets: string
  locks: string
  metadataOverride: string
  backups: string
  sequences: string
  sequenceRuns: string
  imports: string
  workspaceFile: string
  scriptIdsFile: string
}

export function dataDirs(runtime: string): DataDirs {
  const r = path.resolve(runtime)
  return {
    runtime: r,
    configFile: path.join(r, 'config.json'),
    executions: path.join(r, 'executions'),
    presets: path.join(r, 'presets'),
    locks: path.join(r, 'locks'),
    metadataOverride: path.join(r, 'metadata_overrides'),
    backups: path.join(r, 'backups'),
    sequences: path.join(r, 'sequences'),
    sequenceRuns: path.join(r, 'sequence_runs'),
    imports: path.join(r, 'imports'),
    workspaceFile: path.join(r, 'workspace.json'),
    scriptIdsFile: path.join(r, 'script_ids.json'),
  }
}

export interface LocationOptions {
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  /** A "runtime" folder next to the program; used when it exists (portable mode). */
  portableDir?: string
  homeDir?: string
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** SCRIPTHUB_HOME, else an existing portable folder, else the user data folder. */
export function runtimeLocation(opts: LocationOptions = {}): { dir: string; mode: RuntimeMode } {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const home = opts.homeDir ?? os.homedir()
  const given = (env.SCRIPTHUB_HOME ?? '').trim()
  if (given) {
    const expanded = given.startsWith('~') ? path.join(home, given.slice(1)) : given
    return { dir: path.resolve(expanded), mode: 'env' }
  }
  if (opts.portableDir && isDir(opts.portableDir)) return { dir: opts.portableDir, mode: 'portable' }
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    return { dir: path.join(base, 'ScriptHub'), mode: 'user' }
  }
  if (platform === 'darwin') return { dir: path.join(home, 'Library', 'Application Support', 'ScriptHub'), mode: 'user' }
  const base = env.XDG_DATA_HOME || path.join(home, '.local', 'share')
  return { dir: path.join(base, 'scripthub'), mode: 'user' }
}

export function ensureRuntimeDirs(d: DataDirs): void {
  for (const dir of [d.runtime, d.executions, d.presets, d.locks]) fs.mkdirSync(dir, { recursive: true })
}
