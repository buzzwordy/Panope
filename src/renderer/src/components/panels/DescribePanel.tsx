import React, { useMemo } from 'react'
import type { K8sObject } from '@shared/types'
import { getByPath } from '../../lib/getByPath'
import { humanDuration } from '../../lib/format'

/**
 * kubectl-describe equivalent: the object's operationally interesting facts
 * in one scannable, copyable pane - conditions, ownership, scheduling
 * constraints, volumes - assembled client-side from the object itself.
 */

interface Props {
  obj: K8sObject
  now: number
}

interface Condition {
  type?: string
  status?: string
  reason?: string
  message?: string
  lastTransitionTime?: string
}

function rows(pairs: Array<[string, React.ReactNode]>): React.ReactElement {
  return (
    <dl className="describe__grid">
      {pairs
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => (
          <React.Fragment key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </React.Fragment>
        ))}
    </dl>
  )
}

export function DescribePanel({ obj, now }: Props): React.ReactElement {
  const meta = obj.metadata ?? {}
  const spec = (obj.spec ?? {}) as Record<string, unknown>

  const conditions = useMemo(
    () => ((getByPath(obj, 'status.conditions') as Condition[] | undefined) ?? []).slice().reverse(),
    [obj]
  )
  const owners = meta.ownerReferences ?? []
  const tolerations = (getByPath(obj, 'spec.tolerations') as Array<Record<string, string>> | undefined) ?? []
  const nodeSelector = (getByPath(obj, 'spec.nodeSelector') as Record<string, string> | undefined) ?? {}
  const volumes = (getByPath(obj, 'spec.volumes') as Array<Record<string, unknown>> | undefined) ?? []
  const containers = (getByPath(obj, 'spec.containers') as Array<Record<string, unknown>> | undefined) ?? []
  const initContainers = (getByPath(obj, 'spec.initContainers') as Array<Record<string, unknown>> | undefined) ?? []
  const finalizers = (meta as { finalizers?: string[] }).finalizers ?? []

  const affinity = getByPath(obj, 'spec.affinity')

  function volumeSource(v: Record<string, unknown>): string {
    for (const [k, val] of Object.entries(v)) {
      if (k === 'name' || val === undefined || val === null) continue
      if (k === 'configMap') return `ConfigMap ${(val as { name?: string }).name ?? ''}`
      if (k === 'secret') return `Secret ${(val as { secretName?: string }).secretName ?? ''}`
      if (k === 'persistentVolumeClaim') return `PVC ${(val as { claimName?: string }).claimName ?? ''}`
      if (k === 'emptyDir') return 'emptyDir'
      if (k === 'hostPath') return `hostPath ${(val as { path?: string }).path ?? ''}`
      if (k === 'projected') return 'projected'
      if (k === 'downwardAPI') return 'downwardAPI'
      return k
    }
    return '?'
  }

  return (
    <div className="describe">
      <section className="describe__section">
        <h3 className="describe__title">Metadata</h3>
        {rows([
          ['Name', meta.name],
          ['Namespace', meta.namespace],
          ['Kind', `${obj.kind ?? ''} (${obj.apiVersion ?? ''})`],
          ['UID', meta.uid],
          ['Created', meta.creationTimestamp ? `${new Date(meta.creationTimestamp).toLocaleString()} (${humanDuration(meta.creationTimestamp, now)} ago)` : undefined],
          ['Deleting since', meta.deletionTimestamp ? new Date(meta.deletionTimestamp).toLocaleString() : undefined],
          ['Finalizers', finalizers.length ? finalizers.join(', ') : undefined],
          ['Node', getByPath(obj, 'spec.nodeName') as string],
          ['Service account', getByPath(obj, 'spec.serviceAccountName') as string],
          ['Priority class', getByPath(obj, 'spec.priorityClassName') as string]
        ])}
      </section>

      {owners.length > 0 && (
        <section className="describe__section">
          <h3 className="describe__title">Owned by</h3>
          {rows(owners.map((o) => [o.kind, o.name] as [string, React.ReactNode]))}
        </section>
      )}

      {conditions.length > 0 && (
        <section className="describe__section">
          <h3 className="describe__title">Conditions</h3>
          <table className="table describe__conditions">
            <thead>
              <tr>
                <th>Type</th>
                <th>Status</th>
                <th>Reason</th>
                <th>Message</th>
                <th>Since</th>
              </tr>
            </thead>
            <tbody>
              {conditions.map((c, i) => {
                const bad =
                  (c.status === 'False' && c.type !== 'Unschedulable') ||
                  (c.status === 'True' && ['MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable'].includes(c.type ?? ''))
                return (
                  <tr key={`${c.type}-${i}`} className={bad ? 'describe__cond--bad' : ''}>
                    <td>{c.type}</td>
                    <td>{c.status}</td>
                    <td>{c.reason ?? ''}</td>
                    <td className="describe__msg">{c.message ?? ''}</td>
                    <td>{c.lastTransitionTime ? humanDuration(c.lastTransitionTime, now) : ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      )}

      {(containers.length > 0 || initContainers.length > 0) && (
        <section className="describe__section">
          <h3 className="describe__title">Containers</h3>
          {([...initContainers.map((c) => ({ ...c, __init: true })), ...containers] as Array<Record<string, unknown>>).map((c) => {
            const res = (c.resources ?? {}) as { requests?: Record<string, string>; limits?: Record<string, string> }
            const mounts = (c.volumeMounts as Array<{ name?: string; mountPath?: string; readOnly?: boolean }> | undefined) ?? []
            const ports = (c.ports as Array<{ containerPort?: number; protocol?: string }> | undefined) ?? []
            return (
              <div key={String(c.name)} className="describe__container">
                <div className="describe__container-head">
                  <strong>{String(c.name)}</strong>
                  {(c as { __init?: boolean }).__init && <span className="describe__chip">init</span>}
                  <code className="describe__image">{String(c.image ?? '')}</code>
                </div>
                {rows([
                  ['Ports', ports.length ? ports.map((p) => `${p.containerPort}/${p.protocol ?? 'TCP'}`).join(', ') : undefined],
                  ['Requests', res.requests ? Object.entries(res.requests).map(([k, v]) => `${k}=${v}`).join(', ') : undefined],
                  ['Limits', res.limits ? Object.entries(res.limits).map(([k, v]) => `${k}=${v}`).join(', ') : undefined],
                  ['Mounts', mounts.length ? mounts.map((m) => `${m.mountPath}${m.readOnly ? ' (ro)' : ''} <- ${m.name}`).join('; ') : undefined],
                  ['Command', c.command ? (c.command as string[]).join(' ') : undefined],
                  ['Args', c.args ? (c.args as string[]).join(' ') : undefined]
                ])}
              </div>
            )
          })}
        </section>
      )}

      {(tolerations.length > 0 || Object.keys(nodeSelector).length > 0 || !!affinity) && (
        <section className="describe__section">
          <h3 className="describe__title">Scheduling</h3>
          {rows([
            [
              'Node selector',
              Object.keys(nodeSelector).length
                ? Object.entries(nodeSelector).map(([k, v]) => `${k}=${v}`).join(', ')
                : undefined
            ],
            [
              'Tolerations',
              tolerations.length
                ? tolerations
                    .map((t) => `${t.key ?? '*'}${t.operator === 'Exists' ? '' : `=${t.value ?? ''}`}:${t.effect ?? '*'}`)
                    .join(', ')
                : undefined
            ],
            ['Affinity', affinity ? <pre className="describe__pre">{JSON.stringify(affinity, null, 2)}</pre> : undefined]
          ])}
        </section>
      )}

      {volumes.length > 0 && (
        <section className="describe__section">
          <h3 className="describe__title">Volumes</h3>
          {rows(volumes.map((v) => [String(v.name), volumeSource(v)] as [string, React.ReactNode]))}
        </section>
      )}

      {spec.strategy !== undefined && (
        <section className="describe__section">
          <h3 className="describe__title">Update strategy</h3>
          <pre className="describe__pre">{JSON.stringify(spec.strategy, null, 2)}</pre>
        </section>
      )}
    </div>
  )
}
