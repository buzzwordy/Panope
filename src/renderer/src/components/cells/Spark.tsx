import React from 'react'

interface Props {
  /** raw values, oldest first */
  values: number[]
  width?: number
  height?: number
  /** stroke colour; defaults to the accent */
  color?: string
  /** show a soft fill under the line */
  fill?: boolean
  title?: string
}

/**
 * Dependency-free SVG sparkline. Scales to its own min/max (a flat line renders
 * mid-height), so it shows shape, not absolute magnitude - pair it with a
 * number for that.
 */
export function Spark({ values, width = 120, height = 28, color, fill = true, title }: Props): React.ReactElement | null {
  if (values.length < 2) return null
  const w = width
  const h = height
  const pad = 2
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const span = max - min
  const x = (i: number): number => pad + (i / (values.length - 1)) * (w - pad * 2)
  const y = (v: number): number => (span === 0 ? h / 2 : pad + (1 - (v - min) / span) * (h - pad * 2))
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
  const line = pts.join(' ')
  const area = `${pad},${h - pad} ${line} ${(w - pad).toFixed(1)},${h - pad}`
  const stroke = color ?? 'var(--color-accent)'
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      {title && <title>{title}</title>}
      {fill && <polygon points={area} fill={stroke} opacity={0.12} />}
      <polyline points={line} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
