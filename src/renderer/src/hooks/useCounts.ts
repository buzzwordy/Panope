import { useEffect, useState } from 'react'
import { api } from '../api'
import { CATALOG } from '@shared/catalog'

export interface CountEntry {
  total: number
  byNs: Record<string, number>
  namespaced: boolean
}
export type CountsData = Record<string, CountEntry>

/**
 * Lazily fetch item counts for every (supported) resource so the sidebar can
 * show badges. Keeps a per-namespace breakdown so counts can adjust to the
 * selected namespace without refetching. Re-runs when the context changes.
 */
export function useCounts(contextVersion: number): CountsData {
  const [counts, setCounts] = useState<CountsData>({})

  useEffect(() => {
    let disposed = false
    setCounts({})
    const defs = CATALOG.filter((d) => !d.unsupported && (d.listMethod || d.api === 'helm'))
    let idx = 0
    const CONCURRENCY = 6

    async function worker(): Promise<void> {
      while (!disposed && idx < defs.length) {
        const def = defs[idx++]
        try {
          const c = await api.countResource(def.key)
          if (disposed || !c) continue
          setCounts((prev) => ({
            ...prev,
            [def.key]: { total: c.total, byNs: c.byNs, namespaced: def.namespaced }
          }))
        } catch {
          /* ignore per-resource failures */
        }
      }
    }

    for (let i = 0; i < CONCURRENCY; i++) void worker()
    return () => {
      disposed = true
    }
  }, [contextVersion])

  return counts
}

/** Count to display for a resource given the selected namespace. */
export function displayCount(entry: CountEntry | undefined, namespace: string): number | undefined {
  if (!entry) return undefined
  if (namespace === 'All' || !entry.namespaced) return entry.total
  return entry.byNs[namespace] ?? 0
}
