import { useSyncExternalStore } from 'react'

/**
 * Manual refresh. The top-bar button, Ctrl/Cmd+R and the palette bump one
 * counter; every view that loads cluster data lists it beside contextVersion in
 * its effect dependencies, so whatever is on screen fetches again.
 *
 * A reload keeps the current data on screen until the fresh copy lands. Only a
 * context switch clears views back to their loading state.
 */

let tick = 0
const listeners = new Set<() => void>()

export function reloadAll(): void {
  tick += 1
  for (const l of listeners) l()
}

export function useReloadTick(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => tick
  )
}
