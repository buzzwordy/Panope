// Windowing math for list virtualization: which slice of `total` rows to
// mount for the current scroll position, plus spacer heights that keep the
// scrollbar honest.

export interface VirtualWindow {
  /** first mounted row index (inclusive) */
  start: number
  /** last mounted row index (exclusive) */
  end: number
  topPad: number
  bottomPad: number
}

export function computeWindow(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  total: number,
  overscan = 12
): VirtualWindow {
  const rh = Math.max(1, rowHeight)
  const start = Math.max(0, Math.floor(Math.max(0, scrollTop) / rh) - overscan)
  const visible = Math.ceil(Math.max(0, viewportHeight) / rh) + overscan * 2
  const end = Math.min(total, start + visible)
  return {
    start,
    end,
    topPad: start * rh,
    bottomPad: Math.max(0, (total - end) * rh)
  }
}
