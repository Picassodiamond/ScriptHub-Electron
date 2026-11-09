/** Dark/light theme: the saved choice (same key as the old app), else the operating system's, following it live. */
import { signal } from '@preact/signals'
import { readStore, writeStore } from './storage'

export type Theme = 'dark' | 'light'
const KEY = 'sr.theme'

const osTheme = (): Theme => (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')

function initial(): Theme {
  const saved = readStore(KEY)
  return saved === 'light' || saved === 'dark' ? saved : osTheme()
}

export const theme = signal<Theme>(initial())

function apply(t: Theme): void {
  document.documentElement.setAttribute('data-theme', t)
}

export function setTheme(t: Theme, persist = true): void {
  theme.value = t
  apply(t)
  if (persist) writeStore(KEY, t)
}

export const toggleTheme = (): void => setTheme(theme.value === 'dark' ? 'light' : 'dark')

/** Apply the theme and follow the operating system until the user picks one. */
export function initTheme(): void {
  apply(theme.value)
  if (typeof matchMedia === 'function') {
    matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => {
      const saved = readStore(KEY)
      if (saved !== 'light' && saved !== 'dark') setTheme(osTheme(), false)
    })
  }
}
