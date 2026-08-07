import React, { useEffect, useState } from 'react'
import { api } from '../../api'
import { Icon } from '../Icon'

export function RepositoriesModal({ onClose }: { onClose: () => void }): React.ReactElement {
  const [repos, setRepos] = useState<Array<{ name: string; url: string }> | null>(null)

  useEffect(() => {
    let disposed = false
    api.listHelmRepos().then((r) => {
      if (!disposed) setRepos(r)
    })
    return () => {
      disposed = true
    }
  }, [])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--sm" onClick={(e) => e.stopPropagation()} style={{ width: 560 }}>
        <div className="modal__header">
          <Icon name="release" size={16} />
          <span className="modal__title">Helm Repositories</span>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose} title="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="modal__body">
          {repos === null ? (
            <div className="empty-hint">Loading...</div>
          ) : repos.length === 0 ? (
            <div className="empty-hint">
              No Helm repositories configured. Add one with <code>helm repo add &lt;name&gt; &lt;url&gt;</code>.
            </div>
          ) : (
            <div className="pick-list">
              {repos.map((r) => (
                <div className="pf-row" key={r.name}>
                  <span className="pick-item__label" style={{ fontWeight: 'var(--font-weight-semibold)' }}>
                    {r.name}
                  </span>
                  <a className="pf-row__addr" href={r.url} target="_blank" rel="noreferrer" style={{ marginLeft: 'auto' }}>
                    {r.url}
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
