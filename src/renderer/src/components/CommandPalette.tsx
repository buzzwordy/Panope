import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'

export interface PaletteItem {
  key: string
  label: string
  group: string
  icon: string
}

interface Props {
  items: PaletteItem[]
  onSelect: (key: string) => void
  onClose: () => void
}

export function CommandPalette({ items, onSelect, onClose }: Props): React.ReactElement {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    const list = s
      ? items.filter((i) => i.label.toLowerCase().includes(s) || i.group.toLowerCase().includes(s) || i.key.toLowerCase().includes(s))
      : items
    return list.slice(0, 50)
  }, [q, items])

  useEffect(() => setSel(0), [q])
  useEffect(() => {
    const el = listRef.current?.querySelector('.is-sel') as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  function pick(i: number): void {
    const item = filtered[i]
    if (item) {
      onSelect(item.key)
      onClose()
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose} style={{ alignItems: 'flex-start', paddingTop: '12vh' }}>
      <div className="modal" style={{ width: 620, maxHeight: '70vh' }} onClick={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            className="input"
            placeholder="Jump to a resource..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSel((s) => Math.min(s + 1, filtered.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((s) => Math.max(s - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                pick(sel)
              } else if (e.key === 'Escape') {
                onClose()
              }
            }}
          />
        </div>
        <div className="palette-list" ref={listRef}>
          {filtered.map((i, idx) => (
            <button
              key={i.key}
              className={`palette-item${idx === sel ? ' is-sel' : ''}`}
              onMouseEnter={() => setSel(idx)}
              onClick={() => pick(idx)}
            >
              <Icon name={i.icon} size={14} />
              <span className="palette-item__label">{i.label}</span>
              {i.group && <span className="palette-item__group">{i.group}</span>}
            </button>
          ))}
          {filtered.length === 0 && <div className="empty-hint">No matches.</div>}
        </div>
      </div>
    </div>
  )
}
