import React from 'react'
import type { K8sObject } from '@shared/types'
import { getByPath } from '../../lib/getByPath'
import { formatMemory } from '../../lib/format'

function bestName(names: string[]): string {
  if (!names || names.length === 0) return '<none>'
  // prefer a human-readable tag over a sha digest
  const tagged = names.find((n) => n.includes(':') && !n.includes('@sha256'))
  return tagged ?? names.find((n) => !n.includes('@sha256')) ?? names[0]
}

export function ImagesPanel({ obj }: { obj: K8sObject }): React.ReactElement {
  const images =
    ((getByPath(obj, 'status.images') as Array<{ names?: string[]; sizeBytes?: number }>) ?? []).slice()
  images.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))

  if (images.length === 0) return <div className="empty-hint">No images reported for this node.</div>

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Image</th>
          <th style={{ textAlign: 'right', width: 120 }}>Size</th>
        </tr>
      </thead>
      <tbody>
        {images.map((img, i) => (
          <tr key={i}>
            <td style={{ userSelect: 'text', whiteSpace: 'normal', wordBreak: 'break-all' }}>
              {bestName(img.names ?? [])}
            </td>
            <td className="cell--num" style={{ textAlign: 'right' }}>
              {formatMemory(img.sizeBytes ?? 0)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
