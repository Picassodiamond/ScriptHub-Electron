/** "Versions…": pick an earlier version of the script, see it side by side with what is in the editor, and restore it. */
import type { BackupVersionDto } from '@scripthub/protocol'
import { useEffect, useMemo, useState } from 'preact/hooks'
import { api, errorText } from '../../core'
import { changeCount, diffLines } from './diff'

export interface VersionsDialogProps {
  id: string
  versions: BackupVersionDto[]
  /** the text in the editor now */
  current: string
  dirty: boolean
  onRestore(version: string): void
  onClose(): void
}

const kb = (n: number): string => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`)

export function VersionsDialog({ id, versions, current, dirty, onRestore, onClose }: VersionsDialogProps) {
  const [name, setName] = useState(versions[0]?.name ?? '')
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!name) return
    let live = true
    setText(null)
    setError(null)
    api['editor.versionText']({ id, version: name })
      .then((r) => { if (live) setText(r.text) })
      .catch((e) => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [id, name])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const rows = useMemo(() => (text === null ? [] : diffLines(text, current)), [text, current])
  const changes = changeCount(rows)

  return (
    <div class="overlay is-center" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div class="dialog versions-dialog" role="dialog" aria-modal="true" aria-label="Versions">
        <div class="dialog-head">
          <h2>Versions</h2>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div class="dialog-body">
          {versions.length === 0 ? <p class="muted">There are no earlier versions yet. Every save keeps the previous one.</p> : (
            <div class="versions-grid">
              <ul class="versions-list" role="listbox" aria-label="Earlier versions">
                {versions.map((v) => (
                  <li key={v.name} role="option" aria-selected={v.name === name} class={v.name === name ? 'is-active' : ''} onClick={() => setName(v.name)}>
                    <span class="mono small">{v.when}</span><span class="faint small"> · {kb(v.size)}</span>
                  </li>
                ))}
              </ul>
              <div class="versions-diff">
                {error && <p class="error-text">{error}</p>}
                {text === null && !error && <p class="muted">Loading…</p>}
                {text !== null && (
                  <>
                    <div class="versions-note small muted">
                      {changes ? `${changes} line${changes === 1 ? '' : 's'} differ` : 'Identical to the editor'} — left: this version, right: the editor now.
                    </div>
                    <div class="diff" data-diff>
                      {rows.map((r, i) => (
                        <div class={`diff-row diff-${r.kind}`} key={i}>
                          <span class="diff-n">{r.left ?? ''}</span><code class="diff-l">{r.leftText}</code>
                          <span class="diff-n">{r.right ?? ''}</span><code class="diff-r">{r.rightText}</code>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
        <div class="dialog-foot">
          {dirty && <span class="small muted" style="margin-right:auto">Unsaved changes in the editor are replaced.</span>}
          <button type="button" class="btn" onClick={onClose}>Close</button>
          <button type="button" class="btn btn-primary" disabled={!name || text === null} data-restore onClick={() => onRestore(name)}>Restore this version</button>
        </div>
      </div>
    </div>
  )
}
