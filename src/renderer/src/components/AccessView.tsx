import React, { useEffect, useMemo, useState } from 'react'
import type { AccessCheck, AccessResult, AccessSubject, WhoAmI } from '@shared/types'
import { api } from '../api'
import { Icon } from './Icon'

/**
 * "Can I?" - the effective-permissions view.
 *
 * Asks the authorizer itself (SelfSubjectAccessReview / SubjectAccessReview)
 * rather than reading Role objects, so aggregated ClusterRoles, group
 * bindings and webhook authorizers are all accounted for. The matrix is the
 * everyday question ("what can I touch here?"); the custom row answers the
 * precise one ("why can't I delete THIS?").
 */

const VERBS = ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] as const

/** The everyday kinds - enough to characterise a role at a glance. */
const MATRIX_RESOURCES: Array<{ label: string; resource: string; group: string }> = [
  { label: 'Pods', resource: 'pods', group: '' },
  { label: 'Pod logs', resource: 'pods', group: '' }, // subresource handled below
  { label: 'Pod exec', resource: 'pods', group: '' },
  { label: 'Deployments', resource: 'deployments', group: 'apps' },
  { label: 'StatefulSets', resource: 'statefulsets', group: 'apps' },
  { label: 'Services', resource: 'services', group: '' },
  { label: 'Ingresses', resource: 'ingresses', group: 'networking.k8s.io' },
  { label: 'ConfigMaps', resource: 'configmaps', group: '' },
  { label: 'Secrets', resource: 'secrets', group: '' },
  { label: 'PVCs', resource: 'persistentvolumeclaims', group: '' },
  { label: 'Jobs', resource: 'jobs', group: 'batch' },
  { label: 'CronJobs', resource: 'cronjobs', group: 'batch' },
  { label: 'Nodes', resource: 'nodes', group: '' },
  { label: 'Namespaces', resource: 'namespaces', group: '' },
  { label: 'Events', resource: 'events', group: '' },
  { label: 'Roles', resource: 'roles', group: 'rbac.authorization.k8s.io' },
  { label: 'RoleBindings', resource: 'rolebindings', group: 'rbac.authorization.k8s.io' }
]

function checkFor(row: (typeof MATRIX_RESOURCES)[number], verb: string, namespace: string): AccessCheck {
  const base: AccessCheck = {
    verb,
    resource: row.resource,
    group: row.group,
    namespace: namespace === 'All' ? undefined : namespace
  }
  if (row.label === 'Pod logs') return { ...base, subresource: 'log', verb: 'get' }
  if (row.label === 'Pod exec') return { ...base, subresource: 'exec', verb: 'create' }
  return base
}

interface Props {
  namespaces: string[]
  namespace: string
}

export function AccessView({ namespaces, namespace }: Props): React.ReactElement {
  const [who, setWho] = useState<WhoAmI | null>(null)
  const [ns, setNs] = useState(namespace)
  const [asUser, setAsUser] = useState('')
  const [asGroups, setAsGroups] = useState('')
  const [applied, setApplied] = useState<AccessSubject | undefined>()
  const [matrix, setMatrix] = useState<Map<string, AccessResult>>(new Map())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // one custom check row
  const [cVerb, setCVerb] = useState('delete')
  const [cResource, setCResource] = useState('pods')
  const [cGroup, setCGroup] = useState('')
  const [cName, setCName] = useState('')
  const [cResult, setCResult] = useState<AccessResult | null>(null)
  const [cBusy, setCBusy] = useState(false)

  useEffect(() => {
    api.whoAmI().then(setWho).catch(() => setWho(null))
  }, [])

  const cellKey = (label: string, verb: string): string => `${label}|${verb}`

  useEffect(() => {
    let disposed = false
    setLoading(true)
    setError(null)
    const checks: AccessCheck[] = []
    const keys: string[] = []
    for (const row of MATRIX_RESOURCES) {
      // subresource rows are single-cell (their verb is fixed)
      const verbs = row.label === 'Pod logs' || row.label === 'Pod exec' ? ['-'] : [...VERBS]
      for (const v of verbs) {
        checks.push(checkFor(row, v === '-' ? 'get' : v, ns))
        keys.push(cellKey(row.label, v))
      }
    }
    api
      .canI(checks, applied)
      .then((results) => {
        if (disposed) return
        const next = new Map<string, AccessResult>()
        results.forEach((r, i) => next.set(keys[i], r))
        setMatrix(next)
        const firstErr = results.find((r) => r.error)?.error
        setError(firstErr ?? null)
      })
      .catch((e) => !disposed && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !disposed && setLoading(false))
    return () => {
      disposed = true
    }
  }, [ns, applied])

  async function runCustom(): Promise<void> {
    setCBusy(true)
    setCResult(null)
    try {
      const [res] = await api.canI(
        [
          {
            verb: cVerb,
            resource: cResource.trim(),
            group: cGroup.trim(),
            namespace: ns === 'All' ? undefined : ns,
            name: cName.trim() || undefined
          }
        ],
        applied
      )
      setCResult(res)
    } catch (e) {
      setCResult({ allowed: false, error: e instanceof Error ? e.message : String(e) })
    }
    setCBusy(false)
  }

  function applySubject(): void {
    const user = asUser.trim()
    const groups = asGroups
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean)
    setApplied(user || groups.length ? { user: user || undefined, groups: groups.length ? groups : undefined } : undefined)
  }

  const subjectLabel = useMemo(() => {
    if (applied?.user) return applied.user + (applied.groups?.length ? ` (${applied.groups.join(', ')})` : '')
    if (applied?.groups?.length) return `groups: ${applied.groups.join(', ')}`
    return who ? who.user : '...'
  }, [applied, who])

  return (
    <div className="access-view">
      <div className="access-idcard">
        <div className="access-idcard__row">
          <Icon name="sa" size={15} />
          <span className="access-idcard__label">Checking as</span>
          <strong>{subjectLabel}</strong>
          {applied && (
            <button
              className="btn btn--secondary btn--xs"
              onClick={() => {
                setApplied(undefined)
                setAsUser('')
                setAsGroups('')
              }}
            >
              Back to myself
            </button>
          )}
        </div>
        {!applied && who && (
          <div className="access-idcard__sub">
            {who.groups.length > 0 && <span>groups: {who.groups.join(', ')}</span>}
            {who.role && <span> · Panope role: {who.role}</span>}
            <span> · via {who.source === 'selfsubjectreview' ? 'SelfSubjectReview' : who.source}</span>
          </div>
        )}
        <div className="access-idcard__as">
          <input
            className="input"
            placeholder="Check as user... (needs SubjectAccessReview rights)"
            value={asUser}
            onChange={(e) => setAsUser(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applySubject()}
          />
          <input
            className="input"
            placeholder="groups, comma-separated"
            value={asGroups}
            onChange={(e) => setAsGroups(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applySubject()}
          />
          <button className="btn btn--secondary" onClick={applySubject} disabled={!asUser.trim() && !asGroups.trim()}>
            Check as
          </button>
          <div className="panel-toolbar__spacer" />
          <label className="access-nslabel">Namespace</label>
          <select className="input access-nspick" value={ns} onChange={(e) => setNs(e.target.value)}>
            <option value="All">All (cluster-wide)</option>
            {namespaces.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="access-matrix-wrap">
        <table className="access-matrix">
          <thead>
            <tr>
              <th>Resource</th>
              {VERBS.map((v) => (
                <th key={v}>{v}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {MATRIX_RESOURCES.map((row) => {
              const single = row.label === 'Pod logs' || row.label === 'Pod exec'
              return (
                <tr key={row.label}>
                  <td className="access-matrix__res">
                    {row.label}
                    {row.group && <span className="access-matrix__group">{row.group}</span>}
                  </td>
                  {single ? (
                    <td colSpan={VERBS.length} className="access-matrix__single">
                      <Cell r={matrix.get(cellKey(row.label, '-'))} loading={loading} />
                      <span className="access-matrix__hint">
                        {row.label === 'Pod logs' ? 'get pods/log' : 'create pods/exec'}
                      </span>
                    </td>
                  ) : (
                    VERBS.map((v) => (
                      <td key={v}>
                        <Cell r={matrix.get(cellKey(row.label, v))} loading={loading} />
                      </td>
                    ))
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="access-custom">
        <div className="access-custom__title">Precise check</div>
        <div className="access-custom__row">
          <select className="input" value={cVerb} onChange={(e) => setCVerb(e.target.value)} style={{ width: 110 }}>
            {[...VERBS, 'deletecollection', 'impersonate', '*'].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <input
            className="input"
            style={{ width: 180 }}
            placeholder="resource (plural)"
            value={cResource}
            onChange={(e) => setCResource(e.target.value)}
          />
          <input
            className="input"
            style={{ width: 180 }}
            placeholder="API group (empty = core)"
            value={cGroup}
            onChange={(e) => setCGroup(e.target.value)}
          />
          <input
            className="input"
            style={{ width: 200 }}
            placeholder="object name (optional)"
            value={cName}
            onChange={(e) => setCName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runCustom()}
          />
          <button className="btn btn--primary" onClick={runCustom} disabled={cBusy || !cResource.trim()}>
            {cBusy ? 'Checking...' : 'Check'}
          </button>
        </div>
        {cResult && (
          <div className={`access-verdict ${cResult.allowed ? 'is-yes' : 'is-no'}`}>
            <Icon name={cResult.allowed ? 'check' : 'close'} size={14} />
            {cResult.allowed ? 'Allowed' : 'Denied'}
            {(cResult.reason || cResult.error) && (
              <span className="access-verdict__reason">- {cResult.reason ?? cResult.error}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Cell({ r, loading }: { r?: AccessResult; loading: boolean }): React.ReactElement {
  if (!r) return <span className="access-cell is-wait">{loading ? '·' : ''}</span>
  if (r.error) {
    return (
      <span className="access-cell is-err" title={r.error}>
        ?
      </span>
    )
  }
  return (
    <span className={`access-cell ${r.allowed ? 'is-yes' : 'is-no'}`} title={r.reason || (r.allowed ? 'allowed' : 'denied')}>
      {r.allowed ? '✓' : '✕'}
    </span>
  )
}
