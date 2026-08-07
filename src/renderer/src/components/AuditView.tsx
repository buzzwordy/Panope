import React, { useEffect, useMemo, useState } from 'react'
import type { AuditEntry } from '@shared/types'
import { api } from '../api'
import { Icon } from './Icon'
import { humanDuration } from '../lib/format'

/**
 * Action audit: every mutation performed through this Panope instance -
 * who, what, when, and whether it worked. On the desktop that's your own
 * trail (persisted across restarts); in-cluster it's the whole deployment's,
 * with the durable copy in the pod's stdout logs.
 */

interface Props {
  now: number
}

/** API error bodies span many lines; the first one carries the point. */
function firstLine(err: string): string {
  const line = err.split('\n')[0].trim()
  return line.length > 200 ? line.slice(0, 200) + '...' : line
}

export function AuditView({ now }: Props): React.ReactElement {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [onlyFailed, setOnlyFailed] = useState(false)

  useEffect(() => {
    let disposed = false
    const load = (): void => {
      api
        .auditLog()
        .then((e) => !disposed && (setEntries(e), setError(null)))
        .catch((e) => !disposed && setError(e instanceof Error ? e.message : String(e)))
    }
    load()
    const t = setInterval(load, 10000)
    return () => {
      disposed = true
      clearInterval(t)
    }
  }, [])

  const filtered = useMemo(() => {
    if (!entries) return []
    const needle = q.trim().toLowerCase()
    return entries.filter((e) => {
      if (onlyFailed && e.ok) return false
      if (!needle) return true
      return `${e.user} ${e.method} ${e.target} ${e.error ?? ''}`.toLowerCase().includes(needle)
    })
  }, [entries, q, onlyFailed])

  return (
    <div className="audit-view">
      <div className="toolbar">
        <div className="input-wrap input-wrap--icon">
          <span className="input-wrap__icon">
            <Icon name="search" size={14} />
          </span>
          <input className="input" placeholder="Filter by user, action, target..." value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="audit-failtoggle">
          <input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} />
          Failed only
        </label>
        <div className="panel-toolbar__spacer" />
        <span className="audit-count">
          {filtered.length} of {entries?.length ?? 0} actions
        </span>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {entries !== null && entries.length === 0 ? (
        <div className="state">
          <Icon name="list" size={28} />
          <div className="state__title">No actions recorded yet</div>
          <div className="state__hint">Mutations (delete, scale, restart, apply, helm...) will appear here as they happen.</div>
        </div>
      ) : (
        <div className="table-region">
          <table className="table audit-table">
            <thead>
              <tr>
                <th style={{ width: 90 }}>When</th>
                <th style={{ width: 160 }}>Who</th>
                <th style={{ width: 160 }}>Action</th>
                <th>Target</th>
                <th style={{ width: 90 }}>Result</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e, i) => (
                <tr key={`${e.ts}-${i}`} className={e.ok ? '' : 'audit-row--failed'}>
                  <td title={new Date(e.ts).toLocaleString()}>{humanDuration(new Date(e.ts).toISOString(), now)}</td>
                  <td>{e.user || <span className="audit-self">local (kubeconfig)</span>}</td>
                  <td>
                    <code className="audit-method">{e.method}</code>
                  </td>
                  <td className="audit-target" title={e.error}>
                    {e.target}
                    {e.error && <span className="audit-error"> - {firstLine(e.error)}</span>}
                  </td>
                  <td>
                    <span className={`pill ${e.ok ? 'is-running' : 'is-failed'}`}>
                      <span className="pill__dot" />
                      {e.ok ? 'OK' : 'Failed'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
