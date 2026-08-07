import React from 'react'
import type { StatusVariant } from '../../lib/accessors'

export function StatusPill({ label, variant }: { label: string; variant: StatusVariant }): React.ReactElement {
  return (
    <span className={`pill is-${variant}`}>
      <span className="pill__dot" />
      {label}
    </span>
  )
}
