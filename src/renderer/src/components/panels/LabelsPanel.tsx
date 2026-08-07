import React from 'react'
import type { K8sObject } from '@shared/types'

function KV({ title, data }: { title: string; data: Record<string, string> }): React.ReactElement {
  const entries = Object.entries(data)
  return (
    <div className="spec-card">
      <div className="nav-section__label" style={{ padding: '0 0 var(--space-4)' }}>
        {title} ({entries.length})
      </div>
      {entries.length === 0 ? (
        <div className="empty-hint" style={{ textAlign: 'left', padding: 0 }}>
          None.
        </div>
      ) : (
        <dl className="spec-grid spec-grid--kv">
          {entries.map(([k, v]) => (
            <React.Fragment key={k}>
              <dt title={k}>{k}</dt>
              <dd style={{ userSelect: 'text', wordBreak: 'break-word' }}>{v}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
    </div>
  )
}

export function LabelsPanel({ obj }: { obj: K8sObject }): React.ReactElement {
  const labels = obj.metadata?.labels ?? {}
  const annotations = obj.metadata?.annotations ?? {}
  return (
    <div className="spec">
      <KV title="Labels" data={labels} />
      <KV title="Annotations" data={annotations} />
    </div>
  )
}
