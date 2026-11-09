/**
 * The Monaco implementation of EditorAdapter. Monaco is bundled locally (no CDN); this module is only loaded when a page
 * mounts an editor (`import('./monacoAdapter')`), so the app starts without it.
 */
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import type { Disposable, EditorAdapter, EditorMarker, EditorOptions, EditorTheme, LineDecoration } from './EditorAdapter'

;(self as any).MonacoEnvironment = {
  getWorker: (_id: string, label: string) => (label === 'json' ? new JsonWorker() : new EditorWorker()),
}

const css = (name: string, dflt: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || dflt

/** Define Monaco themes from the app's CSS tokens, so the editor matches the page in both themes. */
function defineThemes(): void {
  for (const t of ['dark', 'light'] as const) {
    monaco.editor.defineTheme(`scripthub-${t}`, {
      base: t === 'dark' ? 'vs-dark' : 'vs',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': css('--code-bg', t === 'dark' ? '#11141a' : '#fbfbfc'),
        'editor.foreground': css('--code-text', t === 'dark' ? '#d6dbe4' : '#1f2430'),
        'editorLineNumber.foreground': css('--code-num', '#4f5767'),
        'editorLineNumber.activeForeground': css('--text-2', '#a7afbd'),
        'editor.lineHighlightBackground': t === 'dark' ? '#ffffff0a' : '#0f172a0a',
        'editor.selectionBackground': t === 'dark' ? '#4f8cff52' : '#1f63e033',
        'editorGutter.background': css('--code-bg', '#11141a'),
        'editorWidget.background': css('--panel', '#161a21'),
      },
    })
  }
}

const SEVERITY = { info: monaco.MarkerSeverity.Info, warning: monaco.MarkerSeverity.Warning, error: monaco.MarkerSeverity.Error }
const LINE_CLASS: Record<LineDecoration['kind'], string> = {
  param: 'ed-line-param', current: 'ed-line-current', trace: 'ed-line-trace', highlight: 'ed-line-highlight', error: 'ed-line-error',
}

export class MonacoAdapter implements EditorAdapter {
  readonly kind = 'monaco'
  private editor: monaco.editor.IStandaloneCodeEditor | null = null
  private owners = new Map<string, monaco.editor.IEditorDecorationsCollection>()
  /** What each owner asked for: Monaco drops decorations when the whole text is replaced, so they are put back. */
  private specs = new Map<string, monaco.editor.IModelDeltaDecoration[]>()
  private bps = new Set<number>()
  private bpListeners = new Set<(lines: number[]) => void>()
  private resize: ResizeObserver | null = null

  async mount(el: HTMLElement, o: EditorOptions): Promise<void> {
    defineThemes()
    const editor = monaco.editor.create(el, {
      value: o.value, language: o.language, readOnly: !!o.readOnly, theme: `scripthub-${o.theme}`, automaticLayout: false,
      glyphMargin: !!o.breakpoints, minimap: { enabled: false }, scrollBeyondLastLine: false, renderLineHighlight: 'line',
      fontFamily: css('--mono', 'Consolas, monospace'), fontSize: 13, lineHeight: 21, tabSize: 4, wordWrap: o.wordWrap ? 'on' : 'off',
      smoothScrolling: true, cursorSmoothCaretAnimation: 'on', padding: { top: 8, bottom: 8 }, fixedOverflowWidgets: true,
    })
    this.editor = editor
    if (o.breakpoints) {
      editor.onMouseDown((e) => {
        if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !e.target.position) return
        const line = e.target.position.lineNumber
        if (this.bps.has(line)) this.bps.delete(line)
        else this.bps.add(line)
        this.paintBreakpoints()
        this.emitBreakpoints()
      })
    }
    this.resize = new ResizeObserver(() => this.layout())
    this.resize.observe(el)
  }

  private ed(): monaco.editor.IStandaloneCodeEditor {
    if (!this.editor) throw new Error('The editor is not mounted.')
    return this.editor
  }

  getValue(): string { return this.ed().getValue() }
  setValue(v: string): void {
    if (this.ed().getValue() === v) return
    this.ed().setValue(v)
    for (const [owner, specs] of this.specs) this.owners.get(owner)?.set(specs)
  }
  onChange(cb: (value: string) => void): Disposable { return this.ed().onDidChangeModelContent(() => cb(this.ed().getValue())) }

  setLanguage(language: string): void {
    const model = this.ed().getModel()
    if (model) monaco.editor.setModelLanguage(model, language)
  }
  setTheme(theme: EditorTheme): void {
    defineThemes() // the CSS tokens may have changed with the theme
    monaco.editor.setTheme(`scripthub-${theme}`)
  }
  setReadOnly(readOnly: boolean): void { this.ed().updateOptions({ readOnly }) }

  setMarkers(owner: string, markers: EditorMarker[]): void {
    const model = this.ed().getModel()
    if (!model) return
    monaco.editor.setModelMarkers(model, owner, markers.map((m) => ({
      startLineNumber: m.line, endLineNumber: m.line, startColumn: m.column ?? 1, endColumn: m.endColumn ?? model.getLineMaxColumn(m.line),
      message: m.message, severity: SEVERITY[m.severity ?? 'error'],
    })))
  }

  setLineDecorations(owner: string, decorations: LineDecoration[]): void {
    const specs: monaco.editor.IModelDeltaDecoration[] = decorations.map((d) => ({
      range: new monaco.Range(d.line, 1, d.line, 1),
      options: {
        isWholeLine: true, className: LINE_CLASS[d.kind], glyphMarginClassName: d.glyph === 'current' ? 'ed-glyph-current' : undefined,
        hoverMessage: d.hover ? { value: d.hover } : undefined,
      },
    }))
    this.setLineDecorationsRaw(owner, specs)
  }

  private paintBreakpoints(): void {
    this.setLineDecorationsRaw('breakpoints', [...this.bps].map((line) => ({
      range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'ed-glyph-bp' },
    })))
  }
  private setLineDecorationsRaw(owner: string, specs: monaco.editor.IModelDeltaDecoration[]): void {
    this.specs.set(owner, specs)
    const existing = this.owners.get(owner)
    if (existing) existing.set(specs)
    else this.owners.set(owner, this.ed().createDecorationsCollection(specs))
  }
  private emitBreakpoints(): void {
    const lines = this.getBreakpoints()
    for (const cb of this.bpListeners) cb(lines)
  }

  setBreakpoints(lines: number[]): void {
    this.bps = new Set(lines)
    this.paintBreakpoints()
  }
  getBreakpoints(): number[] { return [...this.bps].sort((a, b) => a - b) }
  onBreakpointsChange(cb: (lines: number[]) => void): Disposable {
    this.bpListeners.add(cb)
    return { dispose: () => this.bpListeners.delete(cb) }
  }

  onCursorLine(cb: (line: number) => void): Disposable { return this.ed().onDidChangeCursorPosition((e) => cb(e.position.lineNumber)) }
  revealLine(line: number, center = true): void {
    if (center) this.ed().revealLineInCenterIfOutsideViewport(line)
    else this.ed().revealLine(line)
  }
  focus(): void { this.editor?.focus() }
  layout(): void { this.editor?.layout() }
  dispose(): void {
    this.resize?.disconnect()
    this.editor?.dispose()
    this.editor?.getModel()?.dispose()
    this.editor = null
    this.owners.clear()
    this.specs.clear()
  }
}

export const createMonacoAdapter = (): EditorAdapter => new MonacoAdapter()
