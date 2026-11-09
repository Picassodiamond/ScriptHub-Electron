/**
 * The code editor as the UI needs it, independent of Monaco. The Electron app implements it with Monaco (monacoAdapter.ts);
 * a VS Code host would implement it by opening the file in VS Code's own editor. Panels only use this interface.
 *
 * Lines are 1-based. "Owners" name a group of markers/decorations (e.g. 'params', 'trace', 'debug'), so one feature can
 * replace its own set without touching the others.
 */
export interface Disposable { dispose(): void }

export type EditorTheme = 'dark' | 'light'

export interface EditorOptions {
  value: string
  /** A language id (see languageFor) */
  language: string
  readOnly?: boolean
  theme: EditorTheme
  /** Show a gutter where a click toggles a breakpoint. */
  breakpoints?: boolean
  wordWrap?: boolean
}

export interface EditorMarker { line: number; message: string; severity?: 'info' | 'warning' | 'error'; column?: number; endColumn?: number }

/** Whole-line decoration: parameter-to-line marking, the current trace/debug line, etc. */
export interface LineDecoration {
  line: number
  kind: 'param' | 'current' | 'trace' | 'highlight' | 'error'
  /** Shown on hover (e.g. the parameter name). */
  hover?: string
  /** Gutter glyph: an arrow for the line being debugged. */
  glyph?: 'current'
}

export interface EditorAdapter {
  readonly kind: 'monaco' | 'vscode' | string
  mount(el: HTMLElement, options: EditorOptions): Promise<void>

  getValue(): string
  setValue(value: string): void
  onChange(cb: (value: string) => void): Disposable

  setLanguage(language: string): void
  setTheme(theme: EditorTheme): void
  setReadOnly(readOnly: boolean): void

  setMarkers(owner: string, markers: EditorMarker[]): void
  setLineDecorations(owner: string, decorations: LineDecoration[]): void

  /** Breakpoints set in the gutter (when `breakpoints` is on). */
  setBreakpoints(lines: number[]): void
  getBreakpoints(): number[]
  onBreakpointsChange(cb: (lines: number[]) => void): Disposable

  onCursorLine(cb: (line: number) => void): Disposable
  revealLine(line: number, center?: boolean): void
  focus(): void
  layout(): void
  dispose(): void
}

const BY_EXT: Record<string, string> = {
  py: 'python', pyw: 'python', sh: 'shell', bash: 'shell', bat: 'bat', cmd: 'bat', ps1: 'powershell', yaml: 'yaml', yml: 'yaml', json: 'json',
}

/** The editor language for a file extension (with or without the dot) or a file name. */
export function languageFor(extOrName: string): string {
  const ext = extOrName.includes('.') ? extOrName.split('.').pop()! : extOrName
  return BY_EXT[ext.toLowerCase()] ?? 'plaintext'
}
