import React, { useState } from 'react'
import { Icon } from '../Icon'

export interface PickItem {
  value: string
  label: string
  sub?: string
}

interface Props {
  title: string
  icon: string
  items: PickItem[]
  current: string
  onPick: (value: string) => void
  onClose: () => void
}

export function PickModal({ title, icon, items, current, onPick, onClose }: Props): React.ReactElement {
  const [q, setQ] = useState('')
  const filtered = items.filter((i) => i.label.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--sm" onClick={(e) => e.stopPropagation()} style={{ width: 480 }}>
        <div className="modal__header">
          <Icon name={icon} size={16} />
          <span className="modal__title">{title}</span>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose} title="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="modal__body" style={{ gap: 'var(--space-4)' }}>
          {items.length > 8 && (
            <input className="input" placeholder="Filter..." value={q} autoFocus onChange={(e) => setQ(e.target.value)} />
          )}
          <div className="pick-list">
            {filtered.map((i) => (
              <button
                key={i.value}
                className={`pick-item${i.value === current ? ' is-current' : ''}`}
                onClick={() => {
                  onPick(i.value)
                  onClose()
                }}
              >
                <span className="pick-item__check">{i.value === current ? <Icon name="heart" size={12} /> : null}</span>
                <span className="pick-item__label">{i.label}</span>
                {i.sub && <span className="pick-item__sub">{i.sub}</span>}
              </button>
            ))}
            {filtered.length === 0 && <div className="empty-hint">Nothing matches.</div>}
          </div>
        </div>
      </div>
    </div>
  )
}
