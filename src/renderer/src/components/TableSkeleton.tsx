import React from 'react'

/**
 * Shimmer placeholder shown while the first page of a list loads. Reads as the
 * table that is about to appear, so the switch to real rows is calm rather than
 * a spinner popping into a full grid.
 */
export function TableSkeleton({ rows = 10 }: { rows?: number }): React.ReactElement {
  return (
    <div className="skel" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div className="skel__row" key={i}>
          <span className="skel__bar" style={{ width: '32%' }} />
          <span className="skel__bar" style={{ width: '14%' }} />
          <span className="skel__bar" style={{ width: '10%' }} />
          <span className="skel__bar" style={{ width: '18%' }} />
          <span className="skel__bar" style={{ width: '8%' }} />
        </div>
      ))}
    </div>
  )
}
