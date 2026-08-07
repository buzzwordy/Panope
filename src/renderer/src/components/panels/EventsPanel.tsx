import React, { useEffect, useState } from 'react'
import { api } from '../../api'
import { useReloadTick } from '../../state/reload'
import type { K8sObject } from '@shared/types'
import { getByPath } from '../../lib/getByPath'
import { humanDuration } from '../../lib/format'
import { StatusPill } from '../cells/StatusPill'
import { Icon } from '../Icon'

interface Props {
  name: string
  namespace?: string
  kind: string
  now: number
}

export function EventsPanel({ name, namespace, kind, now }: Props): React.ReactElement {
  const [events, setEvents] = useState<K8sObject[] | null>(null)
  const [nonce, setNonce] = useState(0)
  const reloadTick = useReloadTick()

  // Back to "loading" only when the object changes; a reload keeps the list up.
  useEffect(() => setEvents(null), [name, namespace, kind])

  useEffect(() => {
    let disposed = false
    api.getEvents(name, namespace, kind).then((ev) => {
      if (!disposed) setEvents(ev)
    })
    return () => {
      disposed = true
    }
  }, [name, namespace, kind, nonce, reloadTick])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-sm)' }}>
          {events ? `${events.length} event${events.length === 1 ? '' : 's'}` : 'Loading...'}
        </span>
        <button
          className="btn btn--secondary"
          style={{ marginLeft: 'auto' }}
          onClick={() => setNonce((n) => n + 1)}
        >
          <Icon name="refresh" size={13} /> Refresh
        </button>
      </div>
      {events && events.length === 0 && <div className="empty-hint">No events for this object.</div>}
      {events && events.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Reason</th>
              <th>Message</th>
              <th style={{ textAlign: 'right' }}>Age</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e, i) => {
              const type = (getByPath(e, 'type') as string) ?? 'Normal'
              const ts =
                (getByPath(e, 'lastTimestamp') as string) ||
                (getByPath(e, 'eventTime') as string) ||
                e.metadata?.creationTimestamp
              return (
                <tr key={e.metadata?.uid ?? i}>
                  <td>
                    <StatusPill label={type} variant={type === 'Warning' ? 'pending' : 'unknown'} />
                  </td>
                  <td>{getByPath(e, 'reason') as string}</td>
                  <td style={{ whiteSpace: 'normal', userSelect: 'text' }}>{getByPath(e, 'message') as string}</td>
                  <td className="cell--num" style={{ textAlign: 'right' }}>
                    {humanDuration(ts, now)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
