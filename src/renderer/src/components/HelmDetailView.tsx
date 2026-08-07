import React, { useEffect, useState } from 'react'
import type { ResourceDef } from '@shared/catalog'
import type { K8sObject } from '@shared/types'
import { api } from '../api'
import { useToast } from '../state/toast'
import { Icon } from './Icon'
import { ConfirmModal } from './modals/ConfirmModal'
import { HelmDeployModal } from './modals/HelmDeployModal'

type Tab = 'history' | 'values' | 'manifest' | 'notes'

interface Props {
  def: ResourceDef
  obj: K8sObject
  theme: 'dark' | 'light'
  readOnly?: boolean
  onBack: () => void
  onChanged: () => void
}

function fields(obj: K8sObject): { chart?: string; appVersion?: string; revision?: unknown; status?: string; updated?: string } {
  const o = obj as unknown as Record<string, unknown>
  return {
    chart: o.chart as string,
    appVersion: o.appVersion as string,
    revision: o.revision,
    status: o.status as string,
    updated: o.updatedText as string
  }
}

export function HelmDetailView({ def, obj, theme, readOnly = false, onBack, onChanged }: Props): React.ReactElement {
  const toast = useToast()
  const name = obj.metadata?.name ?? ''
  const ns = obj.metadata?.namespace ?? ''
  const isRelease = def.kind === 'Release'

  const [tab, setTab] = useState<Tab>('history')
  const [history, setHistory] = useState<Array<Record<string, unknown>> | null>(null)
  const [text, setText] = useState<string>('')
  const [loadingText, setLoadingText] = useState(false)
  const [showUninstall, setShowUninstall] = useState(false)
  const [rollbackTo, setRollbackTo] = useState<number | null>(null)
  const [deploy, setDeploy] = useState<'install' | 'upgrade' | null>(null)

  useEffect(() => {
    if (!isRelease) return
    let disposed = false
    api.helmHistory(name, ns).then((h) => !disposed && setHistory(h))
    return () => {
      disposed = true
    }
  }, [isRelease, name, ns])

  useEffect(() => {
    if (!isRelease || (tab !== 'values' && tab !== 'manifest' && tab !== 'notes')) return
    let disposed = false
    setLoadingText(true)
    api.helmGet(name, ns, tab).then((t) => {
      if (disposed) return
      setText(t)
      setLoadingText(false)
    })
    return () => {
      disposed = true
    }
  }, [isRelease, tab, name, ns])

  async function uninstall(): Promise<void> {
    setShowUninstall(false)
    const res = await api.helmUninstall(name, ns)
    if (res.ok) {
      toast.success(`Uninstalled ${name}`)
      onChanged()
      onBack()
    } else toast.error(res.error ?? 'Uninstall failed')
  }
  async function rollback(rev: number): Promise<void> {
    setRollbackTo(null)
    const res = await api.helmRollback(name, ns, rev)
    if (res.ok) {
      toast.success(`Rolled back ${name} to revision ${rev}`)
      onChanged()
      api.helmHistory(name, ns).then(setHistory)
    } else toast.error(res.error ?? 'Rollback failed')
  }

  const f = fields(obj)

  if (!isRelease) {
    // Chart: info card + install
    const o = obj as unknown as Record<string, unknown>
    return (
      <>
        <div className="detail-head">
          <button className="icon-btn" title="Back" onClick={onBack}>
            <Icon name="chevron-left" size={18} />
          </button>
          <span className="detail-head__icon">
            <Icon name={def.icon} size={20} />
          </span>
          <h1 className="detail-head__title">
            <span className="detail-crumb">Charts</span>
            <span className="detail-crumb__sep"> / </span>
            {name}
          </h1>
          <div className="detail-head__actions">
            <button className="btn btn--primary" disabled={readOnly} onClick={() => setDeploy('install')}>
              <Icon name="plus" size={13} /> Install
            </button>
          </div>
        </div>
        <div className="detail-body">
          <div className="spec-card">
            <dl className="spec-grid spec-grid--kv">
              <dt>name</dt>
              <dd>{name}</dd>
              <dt>chart version</dt>
              <dd>{String(o.chartVersion ?? '-')}</dd>
              <dt>app version</dt>
              <dd>{String(o.appVersion ?? '-')}</dd>
              <dt>description</dt>
              <dd>{String(o.description ?? '-')}</dd>
            </dl>
          </div>
        </div>
        {deploy === 'install' && (
          <HelmDeployModal
            mode="install"
            chart={name}
            chartVersion={String(o.chartVersion ?? '') || undefined}
            theme={theme}
            onClose={() => setDeploy(null)}
            onDone={onChanged}
          />
        )}
      </>
    )
  }

  const tabs: Tab[] = ['history', 'values', 'manifest', 'notes']
  return (
    <>
      <div className="detail-head">
        <button className="icon-btn" title="Back" onClick={onBack}>
          <Icon name="chevron-left" size={18} />
        </button>
        <span className="detail-head__icon">
          <Icon name={def.icon} size={20} />
        </span>
        <h1 className="detail-head__title">
          <span className="detail-crumb">Releases</span>
          <span className="detail-crumb__sep"> / </span>
          {name}
        </h1>
        <div className="detail-head__actions">
          <button className="btn btn--secondary" disabled={readOnly} onClick={() => setDeploy('upgrade')}>
            <Icon name="refresh" size={13} /> Upgrade
          </button>
          <button className="btn btn--danger" disabled={readOnly} onClick={() => setShowUninstall(true)}>
            <Icon name="trash" size={13} /> Uninstall
          </button>
        </div>
      </div>

      <div className="detail-body">
        <div className="spec-card spec-two" style={{ marginBottom: 'var(--space-7)' }}>
          <dl className="spec-grid">
            <dt>chart</dt>
            <dd>{f.chart ?? '-'}</dd>
            <dt>app version</dt>
            <dd>{f.appVersion ?? '-'}</dd>
            <dt>revision</dt>
            <dd>{String(f.revision ?? '-')}</dd>
          </dl>
          <dl className="spec-grid">
            <dt>status</dt>
            <dd>{f.status ?? '-'}</dd>
            <dt>namespace</dt>
            <dd>{ns}</dd>
            <dt>updated</dt>
            <dd>{f.updated ?? '-'}</dd>
          </dl>
        </div>

        <div className="detail-tabs" style={{ margin: '0 0 var(--space-6)' }}>
          {tabs.map((t) => (
            <button key={t} className={`detail-tab${tab === t ? ' is-active' : ''}`} onClick={() => setTab(t)}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        {tab === 'history' && (
          <table className="table spec-table">
            <thead>
              <tr>
                <th>Rev</th>
                <th>Status</th>
                <th>Chart</th>
                <th>App</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(history ?? []).map((h) => {
                const rev = Number(h.revision)
                return (
                  <tr key={rev}>
                    <td className="cell--num">{rev}</td>
                    <td>{String(h.status ?? '')}</td>
                    <td>{String(h.chart ?? '')}</td>
                    <td>{String(h.app_version ?? '')}</td>
                    <td style={{ whiteSpace: 'normal' }}>{String(h.updated ?? '')}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn--secondary" disabled={readOnly} onClick={() => setRollbackTo(rev)}>
                        Rollback
                      </button>
                    </td>
                  </tr>
                )
              })}
              {history !== null && history.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="empty-hint">No release history.</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {(tab === 'values' || tab === 'manifest' || tab === 'notes') && (
          <pre className="yaml" style={{ padding: 'var(--space-6)' }}>
            {loadingText ? 'Loading...' : text || `(no ${tab})`}
          </pre>
        )}
      </div>

      {showUninstall && (
        <ConfirmModal
          title={`Uninstall ${name}`}
          danger
          confirmLabel="Uninstall"
          body={<>Uninstall the Helm release <strong>{name}</strong> from <strong>{ns}</strong>? This deletes its resources.</>}
          onConfirm={uninstall}
          onCancel={() => setShowUninstall(false)}
        />
      )}
      {rollbackTo !== null && (
        <ConfirmModal
          title={`Rollback ${name}`}
          confirmLabel={`Rollback to ${rollbackTo}`}
          body={<>Roll <strong>{name}</strong> back to revision <strong>{rollbackTo}</strong>?</>}
          onConfirm={() => rollback(rollbackTo)}
          onCancel={() => setRollbackTo(null)}
        />
      )}
      {deploy === 'upgrade' && (
        <HelmDeployModal
          mode="upgrade"
          release={name}
          namespace={ns}
          // "redis-17.3.4" -> "redis"; helm needs repo/chart, so leave it editable
          chart={(f.chart ?? '').replace(/-\d+(\.\d+)*.*$/, '')}
          theme={theme}
          onClose={() => setDeploy(null)}
          onDone={() => {
            onChanged()
            api.helmHistory(name, ns).then(setHistory)
          }}
        />
      )}
    </>
  )
}
