/**
 * The command palette (Ctrl+K): scripts, sequences, folders and commands in one list. Type to filter; `>` shows
 * commands only; ↑↓ move, Enter runs, Esc closes.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Icon, Lang } from '../components/Icon'
import { allCommands, keyHint, openTab, paletteOpen, runCommand, shell } from '../core'

interface Entry { group: string; label: string; hint: string; icon?: string; ext?: string; run(): void; rank: number }

function highlight(text: string, q: string) {
  if (!q) return text
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return text
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>
}

function entries(): Entry[] {
  const s = shell.value
  const out: Entry[] = []
  for (const c of allCommands()) {
    if (!c.palette) continue
    out.push({ group: 'Commands', label: c.title, hint: c.keys?.[0] ? keyHint(c.keys[0]) : c.group, icon: 'command', run: () => void runCommand(c.id), rank: 3 })
  }
  for (const p of s?.palette ?? []) out.push({ group: 'Scripts', label: p.name, hint: `${p.cat} · ${p.path}`, ext: p.ext, run: () => openTab({ kind: 'script', id: p.id, title: p.name }), rank: 0 })
  for (const q of s?.sequences ?? []) out.push({ group: 'Sequences', label: q.name, hint: 'sequence', icon: 'sequence', run: () => openTab({ kind: 'sequence', id: q.slug, title: q.name }), rank: 1 })
  for (const f of s?.folderPalette ?? []) out.push({ group: 'Folders', label: f.name, hint: f.path, icon: f.favorite ? 'star' : 'folder', run: () => void runCommand('file.openPath', { path: f.path }), rank: 2 })
  return out
}

export function Palette() {
  const open = paletteOpen.value
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)

  useEffect(() => {
    if (open) {
      setQ('')
      setSel(0)
      setTimeout(() => input.current?.focus(), 0)
    }
  }, [open])

  const results = useMemo(() => {
    if (!open) return []
    let needle = q.trim().toLowerCase()
    const commandsOnly = needle.startsWith('>')
    if (commandsOnly) needle = needle.slice(1).trim()
    const words = needle.split(/\s+/).filter(Boolean)
    const match = (e: Entry) => words.every((w) => `${e.label} ${e.hint}`.toLowerCase().includes(w))
    return entries()
      .filter((e) => (!commandsOnly || e.group === 'Commands') && match(e))
      .sort((a, b) => {
        const sa = a.label.toLowerCase().startsWith(needle) ? 0 : 1
        const sb = b.label.toLowerCase().startsWith(needle) ? 0 : 1
        return sa - sb || a.rank - b.rank || a.label.localeCompare(b.label)
      })
      .slice(0, 60)
  }, [open, q, shell.value])

  useEffect(() => setSel(0), [q])
  useEffect(() => {
    list.current?.querySelector('.is-sel')?.scrollIntoView?.({ block: 'nearest' })
  }, [sel])

  if (!open) return null
  const close = () => { paletteOpen.value = false }
  const run = (e?: Entry) => {
    if (!e) return
    close()
    e.run()
  }
  const needle = q.trim().replace(/^>\s*/, '')
  let lastGroup = ''

  return (
    <div class="overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Search and commands">
        <div class="pal-input">
          <Icon name="search" />
          <input
            ref={input} type="text" placeholder="Search scripts, sequences, folders and commands…  (> for commands)" autocomplete="off" aria-label="Command palette"
            value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(results.length - 1, s + 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
              else if (e.key === 'Enter') { e.preventDefault(); run(results[sel]) }
              else if (e.key === 'Escape') { e.preventDefault(); close() }
            }}
          />
        </div>
        <ul class="pal-list" role="listbox" ref={list}>
          {results.map((r, i) => {
            const head = r.group !== lastGroup ? <li class="pal-group" role="presentation">{r.group}</li> : null
            lastGroup = r.group
            return (
              <>
                {head}
                <li key={`${r.group}:${r.label}:${i}`} role="option" aria-selected={i === sel} class={`pal-item ${i === sel ? 'is-sel' : ''}`}
                  onMouseMove={() => setSel(i)} onClick={() => run(r)}>
                  <span class="pal-ic">{r.ext ? <Lang ext={r.ext} /> : <Icon name={r.icon ?? 'file'} small />}</span>
                  <span class="pal-text">{highlight(r.label, needle)}</span>
                  <span class="pal-hint">{r.hint}</span>
                </li>
              </>
            )
          })}
          {!results.length && <li class="pal-empty">Nothing matches “{needle}”.</li>}
        </ul>
        <div class="pal-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>Esc</kbd> close</span></div>
      </div>
    </div>
  )
}
