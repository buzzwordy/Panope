import React, { useState } from 'react'

interface Props {
  title: string
  body: React.ReactNode
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => Promise<void> | void
  onCancel: () => void
}

export function ConfirmModal({
  title,
  body,
  confirmLabel = 'Confirm',
  danger,
  onConfirm,
  onCancel
}: Props): React.ReactElement {
  const [busy, setBusy] = useState(false)
  async function go(): Promise<void> {
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal modal--sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <span className="modal__title">{title}</span>
        </div>
        <div className="modal__body">
          <div className="confirm-text">{body}</div>
        </div>
        <div className="modal__footer">
          <span className="spacer" />
          <button className="btn btn--secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`} onClick={go} disabled={busy}>
            {busy ? 'Working...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
