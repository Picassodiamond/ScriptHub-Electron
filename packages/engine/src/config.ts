/** Application configuration (runtime/config.json): validated, atomic writes, .bak of the previous file. */
import fs from 'node:fs'
import type { DataDirs } from './paths.js'
import { ensureRuntimeDirs } from './paths.js'
import { atomicWriteJson, readJson } from './fsutil.js'
import { validateConfig } from './validators.js'

export type Config = Record<string, any>

export function defaultConfig(platform: NodeJS.Platform = process.platform): Config {
  const win = platform === 'win32'
  const interpreters: Record<string, string> = { '.py': win ? 'python' : 'python3', '.sh': 'bash' }
  if (win) interpreters['.bat'] = 'cmd'
  return {
    interpreters,
    remote_interpreters: { '.py': 'python3', '.sh': 'bash' },
    ssh_executable: 'ssh',
    ssh_connect_timeout: 10,
    environment: {},
    enable_script_editing: true,
    max_concurrent_executions: 3,
    max_concurrent_per_host: 3,
    default_timeout: 3600,
    history_retention_days: 90,
    log_retention_days: 30,
    polling_interval: 2000,
  }
}

export class ConfigStore {
  constructor(private dirs: DataDirs, private platform: NodeJS.Platform = process.platform) {}

  /** Defaults merged with config.json. Never throws. */
  load(): Config {
    const cfg = defaultConfig(this.platform)
    if (fs.existsSync(this.dirs.configFile)) {
      try {
        const stored = readJson(this.dirs.configFile)
        if (stored && typeof stored === 'object' && !Array.isArray(stored)) Object.assign(cfg, stored)
      } catch {
        /* unreadable: defaults */
      }
    }
    try {
      return validateConfig(cfg)
    } catch {
      return defaultConfig(this.platform)
    }
  }

  /** Validate then save atomically; throws ValidationError on bad input. */
  save(cfg: Config): Config {
    const clean = validateConfig(cfg)
    ensureRuntimeDirs(this.dirs)
    if (fs.existsSync(this.dirs.configFile)) {
      try {
        fs.writeFileSync(this.dirs.configFile + '.bak', fs.readFileSync(this.dirs.configFile))
      } catch {
        /* ignore */
      }
    }
    atomicWriteJson(this.dirs.configFile, clean)
    return clean
  }
}
