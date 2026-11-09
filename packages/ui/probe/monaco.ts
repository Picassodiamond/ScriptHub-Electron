// Probe: mounts the real Monaco adapter under the production CSP inside Electron and exercises the adapter API.
// Run with: node scripts/probe-monaco.mjs
import '../src/styles/workbench.css'
import '../src/styles/extra.css'
import { MonacoAdapter } from '../src/editor/monacoAdapter'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const report = (o: unknown) => console.log('PROBE_RESULT ' + JSON.stringify(o))

try {
  const a = new MonacoAdapter()
  await a.mount(document.getElementById('ed')!, { value: 'import sys\nprint(sys.argv)\nprint("done")\n', language: 'python', theme: 'dark', breakpoints: true })
  let changed = ''
  a.onChange((v) => (changed = v))
  a.setBreakpoints([1, 3])
  a.setLineDecorations('params', [{ line: 2, kind: 'param', hover: 'argv' }])
  a.setLineDecorations('debug', [{ line: 3, kind: 'current', glyph: 'current' }])
  a.setMarkers('check', [{ line: 1, message: 'example warning', severity: 'warning' }])
  a.setValue('print(1)\nprint(2)\n')
  a.setLanguage('shell')
  a.setTheme('light')
  a.revealLine(2)
  await sleep(1500) // let workers and tokenization start
  report({
    editor: !!document.querySelector('.monaco-editor'),
    lines: document.querySelectorAll('.view-line').length,
    breakpoints: a.getBreakpoints(),
    bpGlyphs: document.querySelectorAll('.ed-glyph-bp').length,
    paramLine: document.querySelectorAll('.ed-line-param').length,
    currentLine: document.querySelectorAll('.ed-line-current').length,
    value: a.getValue(),
    changedEvent: changed,
  })
} catch (e) {
  report({ error: String((e as Error)?.stack ?? e) })
}
