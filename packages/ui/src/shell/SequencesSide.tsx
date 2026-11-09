/**
 * Side panel of the Sequences pages (port of _sequences_side.html + app.js #seq-side): the sequences (favourites first,
 * inline new / rename, filter, star, delete) in a foldable pane above the scripts of the open folder, which are
 * dragged onto a diagram. The fold (`sr.seqFold`) and the divider (`sr.seqPaneH`) are remembered.
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import { Icon } from '../components/Icon'
import { activeTab, api, confirm, errorText, forceCloseTab, openTab, readStore, refreshShell, shell, toast, writeStore } from '../core'
import { Explorer } from './Explorer'

const SHOW_FILTER_FROM = 6 // like the Django panel, the filter appears once the list is longer than this

export function SequencesSide() {
  const list = shell.value?.sequenceList ?? []
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameTo, setRenameTo] = useState('')
  const [folded, setFolded] = useState(() => readStore('sr.seqFold') === '1')
  const [paneH, setPaneH] = useState<number | null>(() => {
    const n = parseInt(readStore('sr.seqPaneH') ?? '', 10)
    return n > 0 ? n : null
  })
  const root = useRef<HTMLDivElement>(null)
  const t = activeTab.value
  const current = t?.kind === 'sequence' ? t.id : t?.kind === 'sequence-run' ? (t.params?.sequence as string | undefined) : undefined

  const fold = (on: boolean) => {
    setFolded(on)
    writeStore('sr.seqFold', on ? '1' : '0')
  }

  const needle = q.trim().toLowerCase()
  const shown = list
    .filter((s) => !needle || `${s.name} ${s.slug}`.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name))

  useEffect(() => {
    root.current?.querySelector('.seq-item.is-active')?.scrollIntoView?.({ block: 'nearest' })
  }, [current])

  const startNew = () => {
    fold(false)
    setName('')
    setAdding(true)
  }

  const create = async () => {
    const n = name.trim()
    if (!n) return setAdding(false)
    try {
      const r = await api['sequences.create']({ name: n })
      if (!r.ok) return void toast.error(r.error)
      setName('')
      setAdding(false)
      await refreshShell()
      openTab({ kind: 'sequence', id: r.slug, title: n })
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  const startRename = (slug: string, current: string) => {
    setRenaming(slug)
    setRenameTo(current)
  }

  const rename = async (slug: string) => {
    const n = renameTo.trim()
    const old = list.find((s) => s.slug === slug)
    setRenaming(null)
    if (!n || n === old?.name) return
    try {
      const r = await api['sequences.rename']({ slug, name: n })
      if (!r.ok) toast.error(r.error)
      await refreshShell()
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  const favorite = async (slug: string, on: boolean) => {
    try {
      await api['sequences.favorite']({ slug, on })
      await refreshShell()
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  const remove = async (slug: string, label: string) => {
    if (!(await confirm({ title: 'Delete sequence', message: `Delete the sequence “${label}”? Its past runs stay in History.`, confirmLabel: 'Delete', danger: true }))) return
    try {
      await api['sequences.delete']({ slug })
      forceCloseTab(`sequence:${slug}`)
      await refreshShell()
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  // the divider between the sequences and the scripts
  const drag = (e: PointerEvent) => {
    if (e.button !== 0 || !root.current) return
    e.preventDefault()
    fold(false)
    const el = e.currentTarget as HTMLElement
    const box = root.current.getBoundingClientRect()
    el.setPointerCapture(e.pointerId)
    el.classList.add('is-dragging')
    let h = paneH ?? 0
    const move = (ev: PointerEvent) => {
      h = Math.round(Math.max(70, Math.min(box.height - 120, ev.clientY - box.top)))
      setPaneH(h)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.classList.remove('is-dragging')
      if (h) writeStore('sr.seqPaneH', String(h))
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  return (
    <div class="side-split" id="seq-side" ref={root} style={paneH ? { '--seq-pane-h': `${paneH}px` } : undefined}>
      <section class={`side-pane side-pane-seq ${folded ? 'is-folded' : ''}`} data-pane="seq" aria-label="Sequences">
        <div class="side-head">
          <button type="button" class="side-fold" aria-expanded={!folded} title="Show or hide the sequences" onClick={() => fold(!folded)}>
            <span class="side-title">Sequences</span><span class="tree-count">{list.length}</span>
          </button>
          <div class="side-actions">
            <button type="button" class="btn btn-ghost btn-icon btn-sm" title="New sequence" aria-label="New sequence" onClick={startNew}><Icon name="plus" /></button>
          </div>
        </div>
        <div class="side-pane-body">
          {adding && (
            <form class="seq-new-form" onSubmit={(e) => { e.preventDefault(); void create() }}>
              <input
                class="input input-sm" autofocus maxLength={60} placeholder="Name, then Enter" aria-label="Name of the new sequence" autocomplete="off" value={name}
                onInput={(e) => setName((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setAdding(false) } }}
                onBlur={() => { if (!name.trim()) setAdding(false) }}
              />
            </form>
          )}
          {list.length > SHOW_FILTER_FROM && (
            <div class="tree-filter">
              <label class="searchbox searchbox-sm">
                <Icon name="search" small />
                <input type="search" placeholder="Filter sequences" autocomplete="off" aria-label="Filter sequences" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
              </label>
            </div>
          )}
          <div class="tree seq-list">
            {shown.map((s) => {
              const label = s.error ? s.slug : s.name
              return (
                <div key={s.slug} class={`tree-item seq-item ${s.slug === current ? 'is-active' : ''} ${s.error ? 'has-error' : ''} ${renaming === s.slug ? 'is-renaming' : ''}`}>
                  {s.error ? (
                    <span class="ti-link" title={s.error}><Icon name="x" small /><span class="ti-name">{s.slug}.yaml (cannot be read)</span></span>
                  ) : (
                    <a
                      class="ti-link" href="#" title={`${s.name} · ${s.steps} step${s.steps === 1 ? '' : 's'}`}
                      onClick={(e) => { e.preventDefault(); openTab({ kind: 'sequence', id: s.slug, title: s.name }) }}
                    >
                      <Icon name="sequence" small /><span class="ti-name">{s.name}</span>
                    </a>
                  )}
                  {!s.error && renaming === s.slug && (
                    <form class="seq-rename-form" onSubmit={(e) => { e.preventDefault(); void rename(s.slug) }}>
                      <input
                        class="input input-sm" autofocus maxLength={60} aria-label={`New name of ${s.name}`} autocomplete="off" value={renameTo}
                        ref={(el) => el?.select()}
                        onInput={(e) => setRenameTo((e.target as HTMLInputElement).value)}
                        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setRenaming(null) } }}
                        onBlur={() => setRenaming(null)}
                      />
                    </form>
                  )}
                  <span class="seq-item-actions">
                    {!s.error && (
                      <>
                        <button
                          type="button" class={`seq-act seq-star ${s.favorite ? 'is-on' : ''}`} aria-pressed={s.favorite}
                          title={s.favorite ? 'Remove from favourites' : 'Add to favourites'}
                          aria-label={s.favorite ? `Remove ${s.name} from favourites` : `Add ${s.name} to favourites`}
                          onClick={() => void favorite(s.slug, !s.favorite)}
                        ><Icon name="star" /></button>
                        <button type="button" class="seq-act" title="Rename" aria-label={`Rename ${s.name}`} onClick={() => startRename(s.slug, s.name)}><Icon name="edit" /></button>
                      </>
                    )}
                    <button type="button" class="seq-act seq-del" title="Delete" aria-label={`Delete ${label}`} onClick={() => void remove(s.slug, label)}><Icon name="trash" /></button>
                  </span>
                </div>
              )
            })}
            {!list.length && (
              <p class="tree-empty">No sequences yet: <button type="button" class="link-btn" onClick={startNew}>create one</button>, then drag scripts from below onto it.</p>
            )}
            {!!list.length && !shown.length && <p class="tree-empty">No match.</p>}
          </div>
        </div>
      </section>
      <div class="side-divider" role="separator" aria-orientation="horizontal" aria-label="Resize the sequences and scripts sections" title="Drag to resize" onPointerDown={drag} />
      <section class="side-pane side-pane-scripts" data-pane="scripts" aria-label="Scripts">
        <Explorer />
      </section>
    </div>
  )
}
