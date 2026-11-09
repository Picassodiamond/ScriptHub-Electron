/**
 * The Sequences page: create, find, rename, favourite and delete sequences, and the recent sequence runs.
 * Port of templates/runner/sequences.html (+ the management actions of _sequences_side.html, which the old page kept in the side panel).
 */
import type { SequenceSummary } from '@scripthub/protocol'
import { useState } from 'preact/hooks'
import { Icon } from '../../components/Icon'
import { api, confirm, errorText, openTab, refreshShell, registerPanel, toast, useApi, useEvent, usePoll, type PanelProps } from '../../core'
import { RunsTable } from '../sequence/RunsTable'

const open = (s: { slug: string; name: string }) => openTab({ kind: 'sequence', id: s.slug, title: s.name })

function SequencesPage({ active }: PanelProps) {
  const list = useApi('sequences.list', {}, [])
  const [name, setName] = useState('')
  const [q, setQ] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const sequences = list.data?.sequences ?? []
  const runs = list.data?.runs ?? []
  const anyActive = runs.some((r) => r.active)
  usePoll(() => void list.reload(), 3000, active && anyActive)
  useEvent('sequence.status', () => { if (active) void list.reload() })
  useEvent('workspace.changed', (p) => { if (p.reason === 'sequences') void list.reload() })

  const reload = async () => {
    await Promise.all([list.reload(), refreshShell()])
  }

  const create = async (e: Event) => {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    setBusy(true)
    try {
      const r = await api['sequences.create']({ name: n })
      if (!r.ok) return void toast.error(r.error)
      setName('')
      await reload()
      open({ slug: r.slug, name: n })
    } catch (err) {
      toast.error(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const rename = async (s: SequenceSummary, value: string) => {
    setRenaming(null)
    const v = value.trim()
    if (!v || v === s.name) return
    try {
      const r = await api['sequences.rename']({ slug: s.slug, name: v })
      if (!r.ok) return void toast.error(r.error)
      await reload()
    } catch (err) {
      toast.error(errorText(err))
    }
  }

  const favorite = async (s: SequenceSummary) => {
    try {
      await api['sequences.favorite']({ slug: s.slug, on: !s.favorite })
      await reload()
    } catch (err) {
      toast.error(errorText(err))
    }
  }

  const remove = async (s: SequenceSummary) => {
    if (!(await confirm({ title: 'Delete sequence', message: `Delete the sequence “${s.name}”? Its runs stay in History.`, danger: true, confirmLabel: 'Delete' }))) return
    try {
      await api['sequences.delete']({ slug: s.slug })
      toast.success(`Deleted “${s.name}”.`)
      await reload()
    } catch (err) {
      toast.error(errorText(err))
    }
  }

  const needle = q.trim().toLowerCase()
  const shown = sequences
    .filter((s) => !needle || s.name.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name))
  const favorites = sequences.filter((s) => s.favorite && !s.error).sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div class="page page-narrow" data-testid="sequences-page">
      <section class="panel">
        <div class="panel-head"><h2><Icon name="sequence" class="faint" /> Sequences</h2></div>
        <div class="panel-body">
          <p class="muted small">
            A sequence runs existing scripts in the order you connect them with arrows: one after another, side by side, or only when a step failed,
            each with its own values and host. Pick one below, or create one and drag scripts from the Scripts section onto it.
          </p>
          <form class="inline-form grow" onSubmit={create}>
            <input class="input" type="text" maxLength={60} placeholder="New sequence name, e.g. Nightly maintenance" required aria-label="New sequence name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            <button class="btn btn-primary" type="submit" disabled={busy || !name.trim()}><Icon name="plus" /> New sequence</button>
          </form>
        </div>
      </section>

      {favorites.length > 0 && (
        <section class="panel">
          <div class="panel-head"><h2><Icon name="star" small class="fav-mark" /> Favourites</h2></div>
          <div class="seq-cards">
            {favorites.map((s) => (
              <a class="seq-card" href="#" key={s.slug} onClick={(e) => { e.preventDefault(); open(s) }}>
                <Icon name="sequence" />
                <span class="seq-card-name">{s.name}</span>
                <span class="small muted">{s.steps} step{s.steps === 1 ? '' : 's'}{s.saved_display ? ` · saved ${s.saved_display}` : ''}</span>
              </a>
            ))}
          </div>
        </section>
      )}

      <section class="panel">
        <div class="panel-head">
          <h2>All sequences</h2>
          <span class="spacer" />
          <label class="searchbox searchbox-sm">
            <Icon name="search" small />
            <input type="search" placeholder="Filter sequences" autocomplete="off" aria-label="Filter sequences" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          </label>
        </div>
        {shown.length > 0 ? (
          <div class="table-wrap">
            <table class="table table-dense seq-list">
              <thead><tr><th class="seq-fav-col" /><th>Name</th><th class="num">Steps</th><th class="hide-sm">Saved</th><th class="seq-actions-col" /></tr></thead>
              <tbody>
                {shown.map((s) => (
                  <tr key={s.slug} data-slug={s.slug} class={s.error ? 'is-broken' : ''}>
                    <td>
                      <button type="button" class={`btn btn-ghost btn-icon btn-sm star ${s.favorite ? 'is-on' : ''}`} aria-pressed={s.favorite} title={s.favorite ? 'Remove from favourites' : 'Add to favourites'} onClick={() => void favorite(s)}>
                        <Icon name="star" small />
                      </button>
                    </td>
                    <td>
                      {renaming === s.slug ? (
                        <input
                          class="input input-sm" autofocus defaultValue={s.name} maxLength={60} aria-label={`New name of ${s.name}`}
                          onKeyDown={(e) => { if (e.key === 'Enter') void rename(s, (e.target as HTMLInputElement).value); if (e.key === 'Escape') setRenaming(null) }}
                          onBlur={(e) => void rename(s, (e.target as HTMLInputElement).value)}
                        />
                      ) : s.error ? (
                        <>
                          <span class="strong">{s.name}</span>
                          <div class="small error-text" role="alert">{s.error}</div>
                        </>
                      ) : (
                        <a class="strong" href="#" onClick={(e) => { e.preventDefault(); open(s) }}>{s.name}</a>
                      )}
                    </td>
                    <td class="num mono small">{s.error ? '—' : s.steps}</td>
                    <td class="small muted mono nowrap hide-sm">{s.saved_display}</td>
                    <td class="nowrap">
                      {!s.error && <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Rename" aria-label={`Rename ${s.name}`} onClick={() => setRenaming(s.slug)}><Icon name="edit" small /></button>}
                      <button type="button" class="btn btn-ghost btn-icon btn-sm" title="Delete" aria-label={`Delete ${s.name}`} onClick={() => void remove(s)}><Icon name="trash" small /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div class="panel-body">
            <p class="muted small">{list.loading && !list.data ? 'Loading…' : sequences.length ? 'No sequence matches the filter.' : 'No sequences yet. Create one above.'}</p>
          </div>
        )}
      </section>

      {runs.length > 0 && (
        <section class="panel">
          <div class="panel-head">
            <h2>Recent sequence runs</h2><span class="spacer" />
            <a class="small" href="#" onClick={(e) => { e.preventDefault(); openTab({ kind: 'history', params: { kind: 'sequences' } }) }}>All in History</a>
          </div>
          <RunsTable runs={runs} showName />
        </section>
      )}
    </div>
  )
}

registerPanel('sequences', SequencesPage)
