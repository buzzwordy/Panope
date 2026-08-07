import React from 'react'
import { Icon } from '../Icon'
import { isDesktop } from '../../api'
import { THEMES, themeBase, type ThemeId } from '../../lib/prefs'

interface Props {
  theme: ThemeId
  readOnly: boolean
  updateCheck: boolean
  onSetTheme: (t: ThemeId) => void
  onToggleReadOnly: () => void
  onToggleUpdateCheck: () => void
  onClose: () => void
}

export function PreferencesModal({
  theme,
  readOnly,
  updateCheck,
  onSetTheme,
  onToggleReadOnly,
  onToggleUpdateCheck,
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
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)' }}>
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  className={`btn ${theme === t.id ? 'btn--primary' : 'btn--secondary'}`}
                  onClick={() => onSetTheme(t.id)}
                >
                  <Icon name={themeBase(t.id) === 'dark' ? 'moon' : 'sun'} size={13} /> {t.label}
                </button>
              ))}
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
          {isDesktop && (
            <div className="field">
              <label>Updates</label>
              <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'center' }}>
                <button
                  className={`btn ${updateCheck ? 'btn--primary' : 'btn--secondary'}`}
                  onClick={onToggleUpdateCheck}
                  title="Asks api.github.com for the newest release tag, once per launch"
                >
                  <Icon name="download" size={13} />
                  {updateCheck ? 'Check on startup: ON' : 'Check on startup: OFF'}
                </button>
              </div>
              <span className="confirm-text">
                Panope asks api.github.com for the newest release tag once per launch. Nothing is downloaded
                or installed automatically - it links you to the release page.
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
