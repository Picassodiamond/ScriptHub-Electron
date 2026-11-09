/** Flash messages ("toasts"): success and info hide themselves, errors and warnings stay until dismissed. */
import { signal } from '@preact/signals'

export type ToastKind = 'success' | 'error' | 'info' | 'warning'
export interface ToastItem { id: number; kind: ToastKind; text: string }

export const toasts = signal<ToastItem[]>([])
let next = 1

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

function push(kind: ToastKind, text: string): number {
  const id = next++
  toasts.value = [...toasts.value.slice(-4), { id, kind, text }]
  if (kind === 'success' || kind === 'info') setTimeout(() => dismissToast(id), 4500)
  return id
}

export const toast = {
  success: (t: string) => push('success', t),
  error: (t: string) => push('error', t),
  info: (t: string) => push('info', t),
  warning: (t: string) => push('warning', t),
  show: push,
}
