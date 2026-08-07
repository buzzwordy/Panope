import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { FleetCluster } from '@shared/types'
import { api } from '../api'
import { formatCpu, formatMemory } from '../lib/format'
import { Icon } from './Icon'

interface Props {
  currentContext?: string
  onSwitchContext: (name: string) => void
}

type Level = 'ok' | 'warn' | 'crit'
const WARN_AT = 75
const CRIT_AT = 90
function levelOf(pct: number | null | undefined): Level {
  if (pct === null || pct === undefined) return 'ok'
  if (pct >= CRIT_AT) return 'crit'
  if (pct >= WARN_AT) return 'warn'
  return 'ok'
}
const pctOf = (used?: number, total?: number): number | null =>
  used !== undefined && total !== undefined && total > 0 ? Math.round((used / total) * 100) : null

/** Worst thing about a cluster, used to sort trouble to the top. */
function clusterLevel(c: FleetCluster): Level {
  if (!c.reachable) return 'crit'
  if (c.nodes !== undefined && c.nodesReady !== undefined && c.nodesReady < c.nodes) return 'crit'
  if (c.podsProblem) return 'warn'
  const worst = Math.max(
    pctOf(c.cpuUsed, c.cpuTotal) ?? 0,
    pctOf(c.memUsed, c.memTotal) ?? 0,
    pctOf(c.pods, c.podCapacity) ?? 0
  )
  return levelOf(worst)
}
const RANK: Record<Level, number> = { crit: 0, warn: 1, ok: 2 }

function MiniStat({
  label,
  value,
  pct
}: {
  label: string
  value: string
  pct: number | null
}): React.ReactElement {
  const lv = levelOf(pct)
  return (
    <div className="fleet-stat">
      <div className="fleet-stat__head">
        <span className="fleet-stat__label">{label}</span>
        <span className={`fleet-stat__value is-${lv}`}>{value}</span>
      </div>
      <div className="fleet-stat__bar">
        <div className={`fleet-stat__fill is-${lv}`} style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
      </div>
    </div>
  )
}

export function FleetView({ currentContext, onSwitchContext }: Props): React.ReactElement {
  const [clusters, setClusters] = useState<FleetCluster[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [onlyTrouble, setOnlyTrouble] = useState(false)

  const refresh = useCallback(() => {
    setLoading(true)
    api
      .fleetSummary()
      .then(setClusters)
      .finally(() => setLoading(false))
  }, [])

  // Probing every cluster is expensive, so it runs on open and on demand
  // rather than on a timer.
  useEffect(refresh, [refresh])

  const sorted = useMemo(() => {
    const list = [...(clusters ?? [])].sort((a, b) => {
      const r = RANK[clusterLevel(a)] - RANK[clusterLevel(b)]
      return r !== 0 ? r : a.context.localeCompare(b.context)
    })
    return onlyTrouble ? list.filter((c) => clusterLevel(c) !== 'ok') : list
  }, [clusters, onlyTrouble])

  const totals = useMemo(() => {
    const up = (clusters ?? []).filter((c) => c.reachable)
    return {
      clusters: clusters?.length ?? 0,
      reachable: up.length,
      nodes: up.reduce((n, c) => n + (c.nodes ?? 0), 0),
      pods: up.reduce((n, c) => n + (c.pods ?? 0), 0),
      problems: up.reduce((n, c) => n + (c.podsProblem ?? 0), 0)
    }
  }, [clusters])

  return (
    <>
      <div className="page-header">
        <span className="page-header__icon">
          <Icon name="layers" size={20} />
        </span>
        <h1 className="page-header__title">Fleet</h1>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--space-4)', alignItems: 'center' }}>
          <label className="checkbox">
            <input type="checkbox" checked={onlyTrouble} onChange={(e) => setOnlyTrouble(e.target.checked)} /> Only
            trouble
          </label>
          <button className="btn btn--secondary" onClick={refresh} disabled={loading}>
            <Icon name="refresh" size={13} /> {loading ? 'Probing...' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="detail-body">
        <div className="fleet-summary">
          <span>
            <b>{totals.reachable}</b>/{totals.clusters} clusters reachable
          </span>
          <span className="dot">·</span>
          <span>
            <b>{totals.nodes}</b> nodes
          </span>
          <span className="dot">·</span>
          <span>
            <b>{totals.pods}</b> pods
          </span>
          <span className="dot">·</span>
          <span className={totals.problems ? 'is-warn' : ''}>
            <b>{totals.problems}</b> unhealthy
          </span>
        </div>

        {clusters === null ? (
          <div className="state">
            <div className="spinner" />
            <div className="state__title">Probing every context...</div>
            <div className="state__hint">Unreachable clusters time out after 8s.</div>
          </div>
        ) : sorted.length === 0 ? (
          <div className="state">
            <Icon name="layers" size={28} />
            <div className="state__title">{onlyTrouble ? 'Every cluster is healthy.' : 'No contexts found.'}</div>
          </div>
        ) : (
          <div className="fleet-grid">
            {sorted.map((c) => {
              const lv = clusterLevel(c)
              const cpuPct = pctOf(c.cpuUsed, c.cpuTotal)
              const memPct = pctOf(c.memUsed, c.memTotal)
              const podPct = pctOf(c.pods, c.podCapacity)
              const isCurrent = c.context === currentContext
              return (
                <button
                  key={c.context}
                  className={`fleet-card is-${lv}${isCurrent ? ' is-current' : ''}`}
                  onClick={() => onSwitchContext(c.context)}
                  title={c.reachable ? `Switch to ${c.context}` : c.error}
                >
                  <header className="fleet-card__head">
                    <span className={`status-dot status-dot--${c.reachable ? (lv === 'ok' ? 'running' : 'pending') : 'failed'}`} />
                    <span className="fleet-card__name">{c.context}</span>
                    {isCurrent && <span className="fleet-card__badge">current</span>}
                    {c.latencyMs !== undefined && <span className="fleet-card__latency">{c.latencyMs}ms</span>}
                  </header>

                  {!c.reachable ? (
                    <div className="fleet-card__error">
                      <Icon name="close" size={12} /> {c.error?.slice(0, 90) || 'unreachable'}
                    </div>
                  ) : (
                    <>
                      <div className="fleet-card__meta">
                        <span>{c.version ?? '-'}</span>
                        <span className="dot">·</span>
                        <span className={c.nodesReady !== c.nodes ? 'is-crit' : ''}>
                          {c.nodesReady}/{c.nodes} nodes
                        </span>
                        <span className="dot">·</span>
                        <span className={c.podsProblem ? 'is-warn' : ''}>
                          {c.pods} pods{c.podsProblem ? ` · ${c.podsProblem} unhealthy` : ''}
                        </span>
                      </div>
                      <div className="fleet-card__stats">
                        <MiniStat
                          label="CPU"
                          value={cpuPct === null ? (c.metricsAvailable ? '-' : 'no metrics') : `${cpuPct}%`}
                          pct={cpuPct}
                        />
                        <MiniStat
                          label="Memory"
                          value={memPct === null ? (c.metricsAvailable ? '-' : 'no metrics') : `${memPct}%`}
                          pct={memPct}
                        />
                        <MiniStat
                          label="Pod slots"
                          value={c.podCapacity ? `${c.pods}/${c.podCapacity}` : '-'}
                          pct={podPct}
                        />
                      </div>
                      {c.cpuTotal !== undefined && (
                        <div className="fleet-card__capacity">
                          {formatCpu(c.cpuTotal)} cpu · {formatMemory(c.memTotal ?? 0)} allocatable
                        </div>
                      )}
                    </>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
