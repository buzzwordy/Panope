import { useSyncExternalStore } from 'react'

/**
 * A short history of the toasts the app has shown, kept after the toast itself
 * fades. The top-bar bell reads it so a mutation result or an error you missed
 * is still recoverable instead of gone in 3 seconds.
 */

export type NotifyKind = 'success' | 'error' | 'info'
export interface Notification {
  id: number
  kind: NotifyKind
  message: string
  at: number
}

const MAX = 50
let items: Notification[] = []
let unread = 0
let seq = 0
const listeners = new Set<() => void>()
let snapshot: { items: Notification[]; unread: number } = { items, unread }

function emit(): void {
  snapshot = { items, unread }
  for (const l of listeners) l()
}

export function notify(kind: NotifyKind, message: string): void {
  items = [{ id: ++seq, kind, message, at: Date.now() }, ...items].slice(0, MAX)
  unread += 1
  emit()
}

export function markNotificationsRead(): void {
  if (unread === 0) return
  unread = 0
  emit()
}

export function clearNotifications(): void {
  items = []
  unread = 0
  emit()
}

export function useNotifications(): { items: Notification[]; unread: number } {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => snapshot
  )
}
