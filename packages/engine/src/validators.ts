/** Validation of application configuration. Port of runner/validators.py. */

const EXT_RE = /^\.[A-Za-z0-9_]{1,10}$/
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export class ValidationError extends Error {
  errors: string[]
  constructor(errors: Iterable<string>) {
    const list = [...errors]
    super(list.join('; '))
    this.name = 'ValidationError'
    this.errors = list
  }
}

const isObj = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v)

function toInt(data: Record<string, any>, k: string, lo: number, hi: number, errors: string[], label: string): number | null {
  const v = data[k]
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    errors.push(`${label} must be a whole number.`)
    return null
  }
  if (v < lo || v > hi) {
    errors.push(`${label} must be between ${lo} and ${hi}.`)
    return null
  }
  return v
}

function interpreterMap(raw: unknown, errors: string[], extLabel: string, cmdLabel: (e: string) => string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [ext, cmd] of Object.entries(raw as Record<string, unknown>)) {
    const e = ext.toLowerCase()
    if (!EXT_RE.test(e)) errors.push(`${extLabel}: ${JSON.stringify(ext)}${extLabel.startsWith('Invalid file') ? ' (use e.g. .py).' : '.'}`)
    else if (typeof cmd !== 'string' || !cmd.trim()) errors.push(cmdLabel(e))
    else out[e] = cmd.trim()
  }
  return out
}

/** A cleaned copy of `data`, or throws ValidationError. */
export function validateConfig(data: Record<string, any>): Record<string, any> {
  const errors: string[] = []
  const clean: Record<string, any> = { ...data }

  const dirs = data.script_directories ?? []
  if (!Array.isArray(dirs)) errors.push('script_directories must be a list.')
  else if ('script_directories' in data) {
    const seen = new Set<string>()
    const out: string[] = []
    for (const d of dirs) {
      if (typeof d !== 'string' || !d.trim()) {
        errors.push('Every script directory must be a non-empty path.')
        continue
      }
      const t = d.trim()
      if (!seen.has(t)) {
        seen.add(t)
        out.push(t)
      }
    }
    clean.script_directories = out
  }

  if (!isObj(data.interpreters) || !Object.keys(data.interpreters).length)
    errors.push('interpreters must map at least one file extension to an interpreter.')
  else
    clean.interpreters = interpreterMap(data.interpreters, errors, 'Invalid file extension', (e) =>
      `Interpreter for ${e} must be a non-empty command or path.`)

  if (!isObj(data.remote_interpreters)) errors.push('remote_interpreters must map file extensions to interpreters.')
  else
    clean.remote_interpreters = interpreterMap(data.remote_interpreters, errors, 'Invalid remote file extension', (e) =>
      `Remote interpreter for ${e} must be non-empty.`)

  if (typeof data.ssh_executable !== 'string' || !data.ssh_executable.trim())
    errors.push('ssh_executable must be a command or path.')
  else clean.ssh_executable = data.ssh_executable.trim()

  if (!isObj(data.environment)) errors.push('environment must be an object of NAME: value pairs.')
  else {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(data.environment)) {
      if (!ENV_NAME_RE.test(k)) errors.push(`Invalid environment variable name: ${JSON.stringify(k)}.`)
      else if (typeof v !== 'string' || v.includes('\0')) errors.push(`Environment variable ${k} must have a text value.`)
      else env[k] = v
    }
    clean.environment = env
  }

  delete clean.enable_adhoc // the Ad-hoc screen was removed
  if (typeof data.enable_script_editing !== 'boolean') errors.push('enable_script_editing must be true or false.')

  const limits: Array<[string, number, number, string]> = [
    ['max_concurrent_executions', 1, 64, 'Max concurrent executions'],
    ['max_concurrent_per_host', 1, 64, 'Max concurrent executions per host'],
    ['ssh_connect_timeout', 1, 300, 'SSH connect timeout (seconds)'],
    ['default_timeout', 1, 7 * 86400, 'Default timeout (seconds)'],
    ['history_retention_days', 1, 36500, 'History retention (days)'],
    ['log_retention_days', 1, 36500, 'Log retention (days)'],
    ['polling_interval', 500, 60000, 'Polling interval (ms)'],
  ]
  for (const [k, lo, hi, label] of limits) clean[k] = toInt(data, k, lo, hi, errors, label)

  if (errors.length) throw new ValidationError(errors)
  return clean
}
