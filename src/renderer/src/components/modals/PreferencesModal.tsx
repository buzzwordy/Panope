import React from 'react'
import { Icon } from '../Icon'

interface Props {
  theme: 'dark' | 'light'
  readOnly: boolean
  onSetTheme: (t: 'dark' | 'light') => void
  onToggleReadOnly: () => void
  onClose: () => void
}

export function PreferencesModal({
  theme,
  readOnly,
  onSetTheme,
  onToggleReadOnly,
  onClose
}: Props): React.ReactElement {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--sm" onClick={(e) => e.stopPropagation()} style={{ width: 460 }}>
        <div className="modal__header">
          <Icon name="sliders" size={16} />
          <span className="modal__title">Preferences</span>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose} title="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="modal__body">
          <div className="field">
            <label>Theme</label>
            <div style={{ display: 'flex', gap: 'var(--space-4)' }}>
              <button
                className={`btn ${theme === 'dark' ? 'btn--primary' : 'btn--secondary'}`}
                onClick={() => onSetTheme('dark')}
              >
                <Icon name="moon" size={13} /> Dark
              </button>
              <button
                className={`btn ${theme === 'light' ? 'btn--primary' : 'btn--secondary'}`}
                onClick={() => onSetTheme('light')}
              >
                <Icon name="sun" size={13} /> Light
              </button>
            </div>
          </div>
          <div className="field">
            <label>Cluster access</label>
            <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'center' }}>
              <button
                className={`btn ${readOnly ? 'btn--primary' : 'btn--secondary'}`}
                onClick={onToggleReadOnly}
                title="Enforced in the main process - blocks apply/scale/delete, exec and port-forwards"
              >
                <Icon name={readOnly ? 'lock' : 'unlock'} size={13} />
                {readOnly ? 'Read-only mode: ON' : 'Read-only mode: OFF'}
              </button>
            </div>
            <span className="confirm-text">
              {readOnly
                ? 'All mutations, exec sessions and port-forwards are blocked until turned off. Persists across restarts.'
                : 'Writes (create / apply / scale / restart / delete) are enabled and confirmed before executing.'}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
