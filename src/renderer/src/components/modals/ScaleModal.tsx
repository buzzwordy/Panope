import React, { useState } from 'react'

interface Props {
  name: string
  current: number
  onConfirm: (replicas: number) => Promise<void> | void
  onCancel: () => void
}

export function ScaleModal({ name, current, onConfirm, onCancel }: Props): React.ReactElement {
  const [value, setValue] = useState(String(current))
  const [busy, setBusy] = useState(false)

  async function go(): Promise<void> {
    const n = parseInt(value, 10)
    if (Number.isNaN(n) || n < 0) return
    setBusy(true)
    try {
      await onConfirm(n)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal modal--sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <span className="modal__title">Scale {name}</span>
        </div>
        <div className="modal__body">
          <div className="field">
            <label>Desired replicas</label>
            <input
              className="input"
              type="number"
              min={0}
              value={value}
              autoFocus
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && go()}
            />
          </div>
        </div>
        <div className="modal__footer">
          <span className="spacer" />
          <button className="btn btn--secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={go} disabled={busy}>
            {busy ? 'Scaling...' : 'Scale'}
          </button>
        </div>
      </div>
    </div>
  )
}
