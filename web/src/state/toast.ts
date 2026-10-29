import { create } from 'zustand'

export interface ToastAction {
  label: string
  onClick: () => void
  /** The prominent action of a pair, such as "Admit". */
  primary?: boolean
}

export interface Toast {
  id: number
  message: string
  title?: string
  actions?: ToastAction[]
  /** Toasts with the same key replace each other instead of stacking. */
  key?: string
  /** Milliseconds; 0 keeps it until dismissed. */
  duration: number
}

interface ToastState {
  toasts: Toast[]
}

export const useToasts = create<ToastState>(() => ({ toasts: [] }))

let nextId = 1
const timers = new Map<number, ReturnType<typeof setTimeout>>()

export function dismissToast(id: number): void {
  clearTimeout(timers.get(id))
  timers.delete(id)
  useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

export function dismissToastKey(key: string): void {
  for (const t of useToasts.getState().toasts) if (t.key === key) dismissToast(t.id)
}

/** Shows a transient message and returns its id. */
export function toast(message: string, opts: Partial<Omit<Toast, 'id' | 'message'>> = {}): number {
  const id = nextId++
  const t: Toast = { id, message, duration: opts.actions ? 12_000 : 5_000, ...opts }
  useToasts.setState((s) => {
    const kept = t.key ? s.toasts.filter((x) => x.key !== t.key) : s.toasts
    // Never more than four on screen; the oldest goes first.
    return { toasts: [...kept, t].slice(-4) }
  })
  if (t.duration > 0) timers.set(id, setTimeout(() => dismissToast(id), t.duration))
  return id
}

export function clearToasts(): void {
  for (const id of timers.keys()) clearTimeout(timers.get(id))
  timers.clear()
  useToasts.setState({ toasts: [] })
}
