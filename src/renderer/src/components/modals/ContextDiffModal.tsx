import React, { useEffect, useMemo, useState } from 'react'
import yaml from 'js-yaml'
import type { ResourceDef } from '@shared/catalog'
import type { K8sObject, KubeContextInfo } from '@shared/types'
import { api } from '../../api'
import { Icon } from '../Icon'
import { diffLines, diffStat } from '../../lib/lineDiff'

/**
 * The same object in another cluster, side by side as a diff - the
 * "is staging actually what prod runs?" question without leaving the app.
 * Reads only; noisy server-managed fields are stripped from both sides.
 */

interface Props {
  def: ResourceDef
  obj: K8sObject
  currentContext?: string
  onClose: () => void
}

function comparableYaml(obj: K8sObject): string {
  const clone = JSON.parse(JSON.stringify(obj)) as K8sObject
  const m = (clone.metadata ?? {}) as Record<string, unknown>
  // Server-assigned identity differs between clusters by construction; keeping
  // it would bury the meaningful drift in guaranteed noise.
  delete m.managedFields
  delete m.resourceVersion
  delete m.uid
  delete m.creationTimestamp
  delete m.generation
  delete (m as { annotations?: Record<string, string> }).annotations?.['kubectl.kubernetes.io/last-applied-configuration']
  delete clone.status
  try {
    return yaml.dump(clone, { noRefs: true, sortKeys: true, lineWidth: 140 })
  } catch {
    return JSON.stringify(clone, null, 2)
  }
}

export function ContextDiffModal({ def, obj, currentContext, onClose }: Props): React.ReactElement {
  const [contexts, setContexts] = useState<KubeContextInfo[]>([])
  const [target, setTarget] = useState('')
  const [other, setOther] = useState<K8sObject | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'missing'>('idle')
  const [error, setError] = useState<string | null>(null)

  const name = obj.metadata?.name ?? ''
  const ns = obj.metadata?.namespace

  useEffect(() => {
    api.listContexts().then((all) => {
      const others = all.filter((c) => c.name !== currentContext)
      setContexts(others)
      if (others.length === 1) setTarget(others[0].name)
    })
  }, [currentContext])

  useEffect(() => {
    if (!target) return
    let disposed = false
    setState('loading')
    setError(null)
    setOther(null)
    api
      .getResourceInContext(target, def.key, name, ns)
      .then((o) => {
        if (disposed) return
        if (!o) {
          setState('missing')
        } else {
          setOther(o)
          setState('done')
        }
      })
      .catch((e) => {
        if (disposed) return
        const msg = e instanceof Error ? e.message : String(e)
        if (/not found|404/i.test(msg)) setState('missing')
        else {
          setError(msg)
          setState('idle')
        }
      })
    return () => {
      disposed = true
    }
  }, [target, def.key, name, ns])

  const rows = useMemo(() => {
    if (!other) return []
    return diffLines(comparableYaml(other), comparableYaml(obj))
  }, [obj, other])
  const stat = diffStat(rows)
  const identical = other && stat.added === 0 && stat.removed === 0

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--lg ctx-diff" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <Icon name="git-branch" size={16} />
          <span className="modal__title">
            Compare {def.kind} {ns ? `${ns}/` : ''}{name} across contexts
          </span>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose} title="Close">
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="modal__body ctx-diff__body">
          <div className="panel-toolbar">
            <span className="ctx-diff__side">
              <span className="ctx-diff__badge is-theirs">{target || 'other'}</span> vs{' '}
              <span className="ctx-diff__badge is-ours">{currentContext ?? 'current'}</span>
            </span>
            <div className="panel-toolbar__spacer" />
            {other && !identical && (
              <span className="diff-stat">
                <span className="diff-stat__add">+{stat.added}</span>
                <span className="diff-stat__del">-{stat.removed}</span>
              </span>
            )}
            <label className="access-nslabel">Compare with</label>
            <select className="input" style={{ width: 220 }} value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="" disabled>
                Pick a context...
              </option>
              {contexts.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {error && <div className="error-banner">{error}</div>}

          {state === 'loading' && (
            <div className="state">
              <div className="spinner" />
              <div className="state__title">Reading from {target}...</div>
            </div>
          )}

          {state === 'missing' && (
            <div className="state">
              <Icon name="box" size={28} />
              <div className="state__title">Not found in {target}</div>
              <div className="state__hint">
                {def.kind} {ns ? `${ns}/` : ''}{name} does not exist in that cluster.
              </div>
            </div>
          )}

          {state === 'done' && identical && (
            <div className="state">
              <Icon name="check" size={28} />
              <div className="state__title">Identical</div>
              <div className="state__hint">No drift after stripping server-managed fields and status.</div>
            </div>
          )}

          {state === 'done' && !identical && (
            <div className="yaml-diff ctx-diff__diff">
              {rows.map((r, idx) => (
                <div key={idx} className={`yaml-diff__row yaml-diff__row--${r.kind}`}>
                  <span className="yaml-diff__gutter">{r.oldNo ?? ''}</span>
                  <span className="yaml-diff__gutter">{r.newNo ?? ''}</span>
                  <span className="yaml-diff__sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}</span>
                  <span className="yaml-diff__text">{r.text || ' '}</span>
                </div>
              ))}
            </div>
          )}

          {state === 'idle' && !error && (
            <div className="state">
              <Icon name="layers" size={28} />
              <div className="state__title">Pick a context to compare with</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
