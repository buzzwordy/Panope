import React, { useEffect, useMemo, useState } from 'react'
import type { K8sObject, MetricSample } from '@shared/types'
import { api } from '../api'
import { Icon } from './Icon'
import { formatCpu, formatMemory } from '../lib/format'
import { analyzePods, severityRank, type SizingRow, type SizingIssue } from '../lib/rightsize'

/**
 * Right-sizing: measured usage vs declared requests per container.
 * Surfaces the four things worth acting on: OOM-killed containers, ones about
 * to hit their requests, ones burning 10x what they use, and ones running
 * with no requests at all (invisible to the scheduler).
 */

const ISSUE_LABEL: Record<SizingIssue, string> = {
  'oom-killed': 'OOMKilled',
  'no-requests': 'No requests',
  'no-limits': 'No limits',
  'cpu-overprovisioned': 'CPU over-provisioned',
  'mem-overprovisioned': 'Memory over-provisioned',
  'cpu-underprovisioned': 'CPU near request',
  'mem-underprovisioned': 'Memory near request'
}

type IssueFilter = 'all' | 'problems' | 'waste' | 'no-requests'

interface Props {
  namespace: string
  contextVersion: number
}

export function RightSizingView({ namespace, contextVersion }: Props): React.ReactElement {
  const [pods, setPods] = useState<K8sObject[]>([])
  const [metrics, setMetrics] = useState<Map<string, MetricSample>>(new Map())
  const [metricsAvailable, setMetricsAvailable] = useState(true)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<IssueFilter>('all')
  const [q, setQ] = useState('')

  useEffect(() => {
    let disposed = false
    setLoading(true)
    const load = (): void => {
      Promise.all([api.listResource('pods'), api.getMetrics('pods')]).then(([res, m]) => {
        if (disposed) return
        setPods(res.items)
        const byKey = new Map<string, MetricSample>()
        for (const s of m.samples) byKey.set(s.namespace ? `${s.namespace}/${s.name}` : s.name, s)
        setMetrics(byKey)
        setMetricsAvailable(m.available)
        setLoading(false)
      })
    }
    load()
    const t = setInterval(load, 20000)
    return () => {
      disposed = true
      clearInterval(t)
    }
  }, [contextVersion])

  const rows = useMemo(() => {
    const scoped = namespace === 'All' ? pods : pods.filter((p) => p.metadata?.namespace === namespace)
    return analyzePods(scoped, metrics).sort(
      (a, b) => severityRank(a) - severityRank(b) || (b.memPct ?? 0) - (a.memPct ?? 0)
    )
  }, [pods, metrics, namespace])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (filter === 'problems' && !r.issues.some((i) => i === 'oom-killed' || i.endsWith('underprovisioned'))) return false
      if (filter === 'waste' && !r.issues.some((i) => i.endsWith('overprovisioned'))) return false
      if (filter === 'no-requests' && !r.issues.includes('no-requests')) return false
      if (needle && !`${r.namespace}/${r.pod} ${r.container} ${r.owner ?? ''}`.toLowerCase().includes(needle)) return false
      return true
    })
  }, [rows, filter, q])

  const summary = useMemo(() => {
    let oom = 0
    let under = 0
    let over = 0
    let noReq = 0
    for (const r of rows) {
      if (r.issues.includes('oom-killed')) oom++
      if (r.issues.some((i) => i.endsWith('underprovisioned'))) under++
      if (r.issues.some((i) => i.endsWith('overprovisioned'))) over++
      if (r.issues.includes('no-requests')) noReq++
    }
    return { oom, under, over, noReq }
  }, [rows])

  const pctClass = (pct: number | null): string =>
    pct === null ? '' : pct > 90 ? 'is-danger' : pct > 75 ? 'is-warn' : pct < 10 ? 'is-idle' : ''

  return (
    <div className="sizing-view">
      <div className="sizing-cards">
        <button className={`sizing-card${filter === 'problems' ? ' is-active' : ''}`} onClick={() => setFilter(filter === 'problems' ? 'all' : 'problems')}>
          <span className="sizing-card__num is-danger">{summary.oom + summary.under}</span>
          <span className="sizing-card__label">At risk (OOM / near request)</span>
        </button>
        <button className={`sizing-card${filter === 'waste' ? ' is-active' : ''}`} onClick={() => setFilter(filter === 'waste' ? 'all' : 'waste')}>
          <span className="sizing-card__num is-warn">{summary.over}</span>
          <span className="sizing-card__label">Over-provisioned (&lt;10% used)</span>
        </button>
        <button className={`sizing-card${filter === 'no-requests' ? ' is-active' : ''}`} onClick={() => setFilter(filter === 'no-requests' ? 'all' : 'no-requests')}>
          <span className="sizing-card__num">{summary.noReq}</span>
          <span className="sizing-card__label">No requests declared</span>
        </button>
        <div className="sizing-card sizing-card--static">
          <span className="sizing-card__num">{rows.length}</span>
          <span className="sizing-card__label">Running containers</span>
        </div>
      </div>

      {!metricsAvailable && (
        <div className="error-banner">
          metrics-server is not available - usage columns are empty; requests/limits checks still apply.
        </div>
      )}

      <div className="toolbar">
        <div className="input-wrap input-wrap--icon">
          <span className="input-wrap__icon">
            <Icon name="search" size={14} />
          </span>
          <input className="input" placeholder="Filter by pod, container, owner..." value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {filter !== 'all' && (
          <button className="btn btn--secondary" onClick={() => setFilter('all')}>
            Clear filter
          </button>
        )}
        <div className="panel-toolbar__spacer" />
        <span className="audit-count">{filtered.length} containers</span>
      </div>

      {loading ? (
        <div className="state">
          <div className="spinner" />
          <div className="state__title">Analysing containers...</div>
        </div>
      ) : (
        <div className="table-region">
          <table className="table sizing-table">
            <thead>
              <tr>
                <th>Container</th>
                <th>Owner</th>
                <th style={{ width: 210 }}>CPU use / request</th>
                <th style={{ width: 210 }}>Memory use / request</th>
                <th style={{ width: 70 }}>Restarts</th>
                <th>Findings</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={`${r.namespace}/${r.pod}/${r.container}`}>
                  <td className="sizing-name">
                    <span className="sizing-name__pod">{r.namespace}/{r.pod}</span>
                    <span className="sizing-name__container">{r.container}</span>
                  </td>
                  <td className="sizing-owner">{r.owner ?? '-'}</td>
                  <td>
                    <UsageCell usage={r.cpuUsage} request={r.cpuRequest} pct={r.cpuPct} fmt={formatCpu} cls={pctClass(r.cpuPct)} />
                  </td>
                  <td>
                    <UsageCell usage={r.memUsage} request={r.memRequest} pct={r.memPct} fmt={formatMemory} cls={pctClass(r.memPct)} />
                  </td>
                  <td>{r.restarts || ''}</td>
                  <td className="sizing-issues">
                    {r.issues.map((i) => (
                      <span key={i} className={`sizing-chip sizing-chip--${i}`}>
                        {ISSUE_LABEL[i]}
                      </span>
                    ))}
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

function UsageCell({
  usage,
  request,
  pct,
  fmt,
  cls
}: {
  usage: number | null
  request: number
  pct: number | null
  fmt: (v: number) => string
  cls: string
}): React.ReactElement {
  return (
    <div className={`sizing-usage ${cls}`}>
      <span className="sizing-usage__text">
        {usage !== null ? fmt(usage) : '-'} / {request > 0 ? fmt(request) : 'no request'}
        {pct !== null && <span className="sizing-usage__pct"> {Math.round(pct)}%</span>}
      </span>
      {pct !== null && (
        <span className="sizing-usage__bar">
          <span className="sizing-usage__fill" style={{ width: `${Math.min(100, pct)}%` }} />
        </span>
      )}
    </div>
  )
}
