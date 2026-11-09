/**
 * <CodeEditor/>: mounts an EditorAdapter (Monaco, loaded on first use) into a div, follows the app theme and size.
 * Panels get the adapter through `onReady` to set markers, decorations and breakpoints.
 */
import { useEffect, useRef } from 'preact/hooks'
import type { EditorAdapter } from './EditorAdapter'
import { theme } from '../core/theme'

export interface CodeEditorProps {
  value: string
  language: string
  readOnly?: boolean
  breakpoints?: boolean
  wordWrap?: boolean
  onChange?(value: string): void
  onReady?(adapter: EditorAdapter): void
  class?: string
}

/** Replaceable for tests (and for a host that brings its own editor). */
export const editorFactory: { create: () => Promise<EditorAdapter> } = {
  create: async () => (await import('./monacoAdapter')).createMonacoAdapter(),
}

export function CodeEditor(props: CodeEditorProps) {
  const el = useRef<HTMLDivElement>(null)
  const adapter = useRef<EditorAdapter | null>(null)
  const latest = useRef(props)
  latest.current = props

  useEffect(() => {
    let disposed = false
    let a: EditorAdapter | null = null
    void (async () => {
      const created = await editorFactory.create()
      if (disposed || !el.current) return created.dispose()
      a = created
      const p = latest.current
      await created.mount(el.current, { value: p.value, language: p.language, readOnly: p.readOnly, theme: theme.value, breakpoints: p.breakpoints, wordWrap: p.wordWrap })
      if (disposed) return created.dispose()
      adapter.current = created
      created.onChange((v) => latest.current.onChange?.(v))
      latest.current.onReady?.(created)
    })()
    return () => {
      disposed = true
      adapter.current = null
      a?.dispose()
    }
  }, [])

  useEffect(() => { adapter.current?.setValue(props.value) }, [props.value])
  useEffect(() => { adapter.current?.setLanguage(props.language) }, [props.language])
  useEffect(() => { adapter.current?.setReadOnly(!!props.readOnly) }, [props.readOnly])
  useEffect(() => { adapter.current?.setTheme(theme.value) }, [theme.value])

  return <div class={`code-editor ${props.class ?? ''}`} ref={el} style="width:100%;height:100%;min-height:120px" />
}
