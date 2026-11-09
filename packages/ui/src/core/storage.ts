/** localStorage that never throws (private windows, blocked storage, jsdom). */
export function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeStore(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* not persisted */
  }
}

export function readJson<T>(key: string, fallback: T): T {
  const raw = readStore(key)
  if (raw === null) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export const writeJson = (key: string, value: unknown): void => writeStore(key, JSON.stringify(value))
