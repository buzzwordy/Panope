import React, { useState } from 'react'
import { api } from '../../api'
import { usePortForwards } from '../../state/portForwards'
import { Icon } from '../Icon'

interface Props {
  namespace: string
  ports: number[]
  /** Provide exactly one of pod / service. */
  pod?: string
  service?: string
}

export function ForwardPanel({ namespace, ports, pod, service }: Props): React.ReactElement {
  const { forwards, start, startService, stop } = usePortForwards()
  const [override, setOverride] = useState('')
  const [customRemote, setCustomRemote] = useState('')
  const [busy, setBusy] = useState(false)
  const isService = !!service
  const mine = isService
    ? forwards.filter((f) => f.namespace === namespace && f.service === service)
    : forwards.filter((f) => f.namespace === namespace && f.pod === pod && !f.service)

  // Automatic: local port defaults to the remote port (kubectl-style); the
  // backend falls back to any free port if it's taken. Optionally open a browser.
  async function forward(remote: number, open: boolean): Promise<void> {
    setBusy(true)
    try {
      const explicit = override ? parseInt(override, 10) : NaN
      const local = Number.isNaN(explicit) ? remote : explicit
      const info = isService
        ? await startService(namespace, service as string, remote, local)
        : await start(namespace, pod as string, remote, local)
      if (open && info.localPort && !info.error) {
        api.openExternal(`http://127.0.0.1:${info.localPort}`)
      }
    } finally {
      setBusy(false)
    }
  }

  async function forwardAll(): Promise<void> {
    for (const p of ports) await forward(p, false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <div className="panel-toolbar" style={{ border: 'none', padding: 0, gap: 'var(--space-5)' }}>
        <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-sm)' }}>
          Local port
        </span>
        <input
          className="input"
          placeholder="auto (match remote)"
          value={override}
          onChange={(e) => setOverride(e.target.value)}
          style={{ width: 170 }}
        />
        {ports.length > 0 && (
          <button className="btn btn--secondary" onClick={forwardAll} disabled={busy}>
            <Icon name="forward" size={13} /> Forward all
          </button>
        )}
      </div>

      <div>
        <div className="nav-section__label" style={{ padding: '0 0 var(--space-3)' }}>
          {isService ? 'Service ports' : 'Container ports'}
        </div>
        {ports.length === 0 && (
          <div className="empty-hint" style={{ textAlign: 'left' }}>
            No declared {isService ? 'service' : 'container'} ports - enter one below.
          </div>
        )}
        <div className="pf-list">
          {ports.map((p) => (
            <div className="pf-row" key={p}>
              <span className="pf-row__addr">:{p}</span>
              <span style={{ marginLeft: 'auto' }} />
              <button className="btn btn--primary" onClick={() => forward(p, true)} disabled={busy}>
                Forward &amp; open
              </button>
            </div>
          ))}
          <div className="pf-row">
            <input
              className="input"
              placeholder="custom remote port"
              value={customRemote}
              onChange={(e) => setCustomRemote(e.target.value)}
              style={{ width: 180 }}
            />
            <span style={{ marginLeft: 'auto' }} />
            <button
              className="btn btn--secondary"
              disabled={!customRemote || busy}
              onClick={() => {
                const r = parseInt(customRemote, 10)
                if (!Number.isNaN(r)) forward(r, true)
              }}
            >
              Forward
            </button>
          </div>
        </div>
      </div>

      {mine.length > 0 && (
        <div>
          <div className="nav-section__label" style={{ padding: '0 0 var(--space-3)' }}>
            Active
          </div>
          <div className="pf-list">
            {mine.map((f) => (
              <div className="pf-row" key={f.id}>
                <span className="pf-row__addr">127.0.0.1:{f.localPort}</span>
                <span className="pf-row__meta">{'->'} :{f.remotePort}</span>
                {f.error && <span className="pf-row__meta" style={{ color: 'var(--color-danger)' }}>{f.error}</span>}
                <span style={{ marginLeft: 'auto' }} />
                <button
                  className="btn btn--secondary"
                  onClick={() => api.openExternal(`http://127.0.0.1:${f.localPort}`)}
                >
                  Open
                </button>
                <button className="btn btn--secondary" onClick={() => stop(f.id)}>
                  Stop
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
