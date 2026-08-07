import React, { useEffect, useState } from 'react'
import type { AppInfo, ClusterInfo } from '@shared/types'
import { api } from '../../api'
import { Icon } from '../Icon'

interface Props {
  clusterInfo?: ClusterInfo
  readOnly: boolean
  onClose: () => void
}

export function AboutModal({ clusterInfo, readOnly, onClose }: Props): React.ReactElement {
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    let disposed = false
    api
      .getAppInfo()
      .then((i) => !disposed && setInfo(i))
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [])

  const rows: Array<[string, React.ReactNode]> = [
    ['Version', info?.version ?? '...'],
    ['Running as', info ? (info.mode === 'desktop' ? 'Desktop app' : 'In-cluster server') : '...'],
    ['Cluster', clusterInfo?.context ?? '-'],
    ['Kubernetes', clusterInfo?.version ?? '-'],
    ['API server', clusterInfo?.server ?? '-'],
    ['Mode', readOnly ? 'Read-only' : 'Read / write'],
    ['Metrics', clusterInfo?.metricsAvailable ? 'metrics-server available' : 'metrics-server not available']
  ]
  if (info?.electron) rows.push(['Electron', `${info.electron} · Node ${info.node} · Chromium ${info.chrome}`])
  if (info?.platform) rows.push(['Platform', info.platform])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--sm about" style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <Icon name="cube" size={18} />
          <span className="modal__title">About Panope</span>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose} title="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="modal__body">
          <div className="about__hero">
            <div className="about__name">Panope</div>
            <div className="about__tag">A desktop and in-cluster client for Kubernetes</div>
          </div>
          <dl className="about__grid">
            {rows.map(([k, v]) => (
              <React.Fragment key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </React.Fragment>
            ))}
          </dl>
        </div>
        <div className="modal__footer">
          <span className="confirm-text">Cluster access comes from your kubeconfig or, in-cluster, your OIDC identity.</span>
          <span className="spacer" />
          <button className="btn btn--secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
