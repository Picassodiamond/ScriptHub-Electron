/** Toasts, the confirm dialog and the keyboard shortcut sheet. */
import { useLayoutEffect } from 'preact/hooks'
import { allCommands, confirmState, dismissToast, helpOpen, keyHint, toasts } from '../core'

export function Toasts() {
  const list = toasts.value
  if (!list.length) return null
  return (
    <div class="toasts" role="region" aria-label="Messages" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} class={`flash flash-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <span>{t.text}</span>
          <button type="button" class="flash-x" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>×</button>
        </div>
      ))}
    </div>
  )
}

export function ConfirmDialog() {
  const c = confirmState.value
  // a layout effect: the Escape/Enter listener is in place before the dialog is painted, so a fast key press is not lost
  useLayoutEffect(() => {
    if (!c) return
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); c.resolve('cancel') }
      if (e.key === 'Enter') { e.preventDefault(); c.resolve('ok') }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [c])
  if (!c) return null
  return (
    <div class="overlay is-center" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) c.resolve('cancel') }}>
      <div class="dialog" role="alertdialog" aria-modal="true" aria-label={c.title ?? 'Confirm'}>
        <div class="dialog-head"><h2>{c.title ?? 'Are you sure?'}</h2></div>
        <div class="dialog-body"><p class="dialog-msg">{c.message}</p></div>
        <div class="dialog-foot">
          <button type="button" class="btn" onClick={() => c.resolve('cancel')}>{c.cancelLabel ?? 'Cancel'}</button>
          {c.altLabel && <button type="button" class="btn" onClick={() => c.resolve('alt')}>{c.altLabel}</button>}
          <button type="button" class={`btn ${c.danger ? 'btn-danger' : 'btn-primary'}`} autofocus onClick={() => c.resolve('ok')}>{c.confirmLabel ?? 'OK'}</button>
        </div>
      </div>
    </div>
  )
}

export function HelpSheet() {
  useLayoutEffect(() => {
    if (!helpOpen.value) return
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') helpOpen.value = false }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [helpOpen.value])
  if (!helpOpen.value) return null
  const rows = allCommands().filter((c) => c.keys?.length && (c.palette || c.keys.length))
  return (
    <div class="overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) helpOpen.value = false }}>
      <div class="dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div class="dialog-head">
          <h2>Keyboard shortcuts</h2>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Close" onClick={() => { helpOpen.value = false }}>×</button>
        </div>
        <div class="dialog-body">
          <table class="keys">
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>{c.title}</td>
                  <td class="num">{c.keys!.map((k, i) => <>{i > 0 && ' or '}<kbd>{keyHint(k)}</kbd></>)}</td>
                </tr>
              ))}
              <tr><td>Command palette (commands only)</td><td class="num"><kbd>Ctrl K</kbd> then <kbd>&gt;</kbd></td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
