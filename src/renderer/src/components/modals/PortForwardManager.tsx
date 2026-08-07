import React from 'react'
import { usePortForwards } from '../../state/portForwards'
import { Icon } from '../Icon'

export function PortForwardManager({ onClose }: { onClose: () => void }): React.ReactElement {
  const { forwards, stop } = usePortForwards()
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--sm" onClick={(e) => e.stopPropagation()} style={{ width: 520 }}>
        <div className="modal__header">
          <Icon name="forward" size={16} />
          <span className="modal__title">Port forwards</span>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose} title="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="modal__body">
          {forwards.length === 0 ? (
            <div className="empty-hint">
              No active port forwards. Open a Pod and use the Forward tab to start one.
            </div>
          ) : (
            <div className="pf-list">
              {forwards.map((f) => (
                <div className="pf-row" key={f.id}>
                  <a
                    className="pf-row__addr"
                    href={`http://127.0.0.1:${f.localPort}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    127.0.0.1:{f.localPort}
                  </a>
                  <span className="pf-row__meta">
                    {'->'} {f.namespace}/{f.service ? `svc/${f.service}` : f.pod}:{f.remotePort}
                    {f.service && f.pod ? ` (${f.pod})` : ''}
                  </span>
                  {f.error && <span className="pf-row__meta" style={{ color: 'var(--color-danger)' }}>{f.error}</span>}
                  <span style={{ marginLeft: 'auto' }} />
                  <button className="btn btn--secondary" onClick={() => stop(f.id)}>
                    Stop
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
