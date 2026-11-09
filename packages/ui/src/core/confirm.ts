/** A confirmation dialog as a promise (replaces data-confirm): `if (await confirm({ message: 'Delete it?', danger: true })) …` */
import { signal } from '@preact/signals'

export interface ConfirmOptions {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  /** A third choice between Cancel and the confirm button (e.g. "Don't save"). */
  altLabel?: string
}
export type Answer = 'ok' | 'alt' | 'cancel'
/** `resolve(true)` / `resolve(false)` still mean 'ok' / 'cancel'. */
export interface ConfirmState extends ConfirmOptions { resolve(answer: Answer | boolean): void }

export const confirmState = signal<ConfirmState | null>(null)

/** A dialog with up to three answers: the confirm button ('ok', Enter), an optional alternative ('alt'), Cancel/Escape. */
export function ask(opts: ConfirmOptions): Promise<Answer> {
  return new Promise((resolve) => {
    confirmState.value?.resolve('cancel')
    confirmState.value = {
      ...opts,
      resolve: (answer) => {
        confirmState.value = null
        resolve(answer === true ? 'ok' : answer === false ? 'cancel' : answer)
      },
    }
  })
}

export async function confirm(opts: ConfirmOptions): Promise<boolean> {
  return (await ask(opts)) === 'ok'
}
