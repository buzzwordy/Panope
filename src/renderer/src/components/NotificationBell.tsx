import React, { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { useNotifications, markNotificationsRead, clearNotifications } from '../state/notifications'

function ago(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

export function NotificationBell(): React.ReactElement {
  const { items, unread } = useNotifications()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    markNotificationsRead()
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className="bell-wrap" ref={ref}>
      <button className="icon-btn" title="Notifications" onClick={() => setOpen((o) => !o)}>
        <Icon name="bell" size={16} />
        {unread > 0 && <span className="bell__badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="bell-menu">
          <div className="bell-menu__head">
            <span>Notifications</span>
            {items.length > 0 && (
              <button className="bell-menu__clear" onClick={clearNotifications}>
                Clear
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <div className="bell-menu__empty">Nothing yet. Actions and errors show up here.</div>
          ) : (
            <div className="bell-menu__list">
              {items.map((n) => (
                <div key={n.id} className={`bell-item bell-item--${n.kind}`}>
                  <span className="bell-item__dot" />
                  <span className="bell-item__msg">{n.message}</span>
                  <span className="bell-item__time">{ago(n.at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
