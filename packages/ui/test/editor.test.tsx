import { render, waitFor } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import { CodeEditor, editorFactory, languageFor, type Disposable, type EditorAdapter } from '../src/editor'
import { setTheme } from '../src/core/theme'

class FakeAdapter implements EditorAdapter {
  readonly kind = 'fake'
  log: string[] = []
  value = ''
  change: ((v: string) => void) | null = null
  async mount(_el: HTMLElement, o: { value: string; language: string; theme: string; breakpoints?: boolean }) { this.value = o.value; this.log.push(`mount ${o.language} ${o.theme} bp=${!!o.breakpoints}`) }
  getValue() { return this.value }
  setValue(v: string) { this.value = v; this.log.push(`value ${v}`) }
  onChange(cb: (v: string) => void): Disposable { this.change = cb; return { dispose() {} } }
  setLanguage(l: string) { this.log.push(`language ${l}`) }
  setTheme(t: string) { this.log.push(`theme ${t}`) }
  setReadOnly(r: boolean) { this.log.push(`readOnly ${r}`) }
  setMarkers() {}
  setLineDecorations() {}
  setBreakpoints() {}
  getBreakpoints() { return [] }
  onBreakpointsChange(): Disposable { return { dispose() {} } }
  onCursorLine(): Disposable { return { dispose() {} } }
  revealLine() {}
  focus() {}
  layout() {}
  disposed = false
  dispose() { this.disposed = true }
}

describe('CodeEditor', () => {
  it('mounts the adapter from the factory, reports it ready, forwards prop changes and changes of the text', async () => {
    const fake = new FakeAdapter()
    editorFactory.create = async () => fake
    let ready: EditorAdapter | null = null
    let text = ''
    const view = render(<CodeEditor value="print(1)" language="python" breakpoints onReady={(a) => (ready = a)} onChange={(v) => (text = v)} />)
    await waitFor(() => expect(ready).toBe(fake))
    expect(fake.log[0]).toMatch(/^mount python (dark|light) bp=true$/)
    fake.change?.('print(2)')
    expect(text).toBe('print(2)')

    view.rerender(<CodeEditor value="echo hi" language="shell" readOnly onReady={() => {}} />)
    await waitFor(() => expect(fake.log).toContain('value echo hi'))
    expect(fake.log).toEqual(expect.arrayContaining(['language shell', 'readOnly true']))

    setTheme('light', false)
    await waitFor(() => expect(fake.log).toContain('theme light'))
    view.unmount()
    await waitFor(() => expect(fake.disposed).toBe(true)) // effect cleanups run after the DOM update
  })

  it('disposes an adapter that finished loading after the component was already removed', async () => {
    const fake = new FakeAdapter()
    editorFactory.create = () => new Promise((r) => setTimeout(() => r(fake), 30))
    const view = render(<CodeEditor value="" language="python" />)
    view.unmount()
    await waitFor(() => expect(fake.disposed).toBe(true))
  })

  it('maps file extensions to editor languages', () => {
    expect([languageFor('py'), languageFor('.sh'), languageFor('backup.bat'), languageFor('x.PS1'), languageFor('c.yml'), languageFor('zzz')])
      .toEqual(['python', 'shell', 'bat', 'powershell', 'yaml', 'plaintext'])
  })
})
