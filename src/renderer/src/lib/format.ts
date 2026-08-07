// Display formatters that mirror kubectl's conventions.

/**
 * Compact human duration, matching kubernetes' duration.HumanDuration
 * (the format kubectl uses for the AGE column): "5s", "3m12s", "2h12m", "111d".
 */
export function humanDuration(fromISO: string | undefined, now: number = Date.now()): string {
  if (!fromISO) return ''
  const start = Date.parse(fromISO)
  if (Number.isNaN(start)) return ''
  const d = Math.floor((now - start) / 1000) // seconds
  if (d < 0) return '0s'
  if (d < 60 * 2) return `${d}s`
  const minutes = Math.floor(d / 60)
  if (minutes < 10) {
    const s = d - minutes * 60
    return s === 0 ? `${minutes}m` : `${minutes}m${s}s`
  }
  if (minutes < 60 * 3) return `${minutes}m`
  const hours = Math.floor(d / 3600)
  if (hours < 8) {
    const m = minutes - hours * 60
    return m === 0 ? `${hours}h` : `${hours}h${m}m`
  }
  if (hours < 48) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 8) {
    const h = hours - days * 24
    return h === 0 ? `${days}d` : `${days}d${h}h`
  }
  if (days < 365 * 2) return `${days}d`
  const years = Math.floor(days / 365)
  return `${years}y`
}

/** millicores -> "186m" or "1.95" (cores) for very large values. */
export function formatCpu(millicores: number): string {
  if (!millicores) return '0'
  if (millicores < 10000) return `${Math.round(millicores)}m`
  return (millicores / 1000).toFixed(2)
}

/** bytes -> "785Mi" (mirrors kubectl top). */
export function formatMemory(bytes: number): string {
  if (!bytes) return '0'
  const mi = bytes / (1024 * 1024)
  if (mi < 1) return `${Math.round(bytes / 1024)}Ki`
  if (mi >= 1024) return `${(mi / 1024).toFixed(1)}Gi`
  return `${Math.round(mi)}Mi`
}

/** For a value against a per-column reference max, return fill % + severity level. */
export function usageLevel(value: number, reference: number): { percent: number; level: 'ok' | 'warn' | 'danger' } {
  if (reference <= 0 || value <= 0) return { percent: 0, level: 'ok' }
  const percent = Math.min(100, (value / reference) * 100)
  const level = percent >= 90 ? 'danger' : percent >= 70 ? 'warn' : 'ok'
  return { percent, level }
}
