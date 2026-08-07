import React from 'react'
import { usageLevel } from '../../lib/format'

interface UsageBarProps {
  /** Formatted display value, e.g. "186m" / "785Mi". */
  display: string
  /** Raw numeric value (millicores or bytes). */
  value: number
  /** Reference used to scale the bar (limit / allocatable / column-max). */
  reference: number
  /** True when metrics-server data is present. */
  available: boolean
  /** Show a "%" label (only meaningful when reference is a real denominator). */
  showPercent?: boolean
}

export function UsageBar({ display, value, reference, available, showPercent }: UsageBarProps): React.ReactElement {
  if (!available) {
    return (
      <div className="usage">
        <span className="usage__value usage__value--empty">-</span>
      </div>
    )
  }
  const { percent, level } = usageLevel(value, reference)
  return (
    <div className="usage">
      <div className="usage__row">
        <span className="usage__value">{display}</span>
        {showPercent && (
          <span className="usage__pct" data-level={level}>
            {Math.round(percent)}%
          </span>
        )}
      </div>
      <div className="usage__track">
        <div className="usage__fill" data-level={level} style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}
