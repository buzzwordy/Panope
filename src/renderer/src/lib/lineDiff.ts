// Minimal LCS-based line diff - no external dependency.
// Produces a flat list of rows for side-less unified rendering.

export type DiffKind = 'same' | 'add' | 'del'

export interface DiffRow {
  kind: DiffKind
  /** line number in the "old" text (undefined for adds) */
  oldNo?: number
  /** line number in the "new" text (undefined for dels) */
  newNo?: number
  text: string
}

/**
 * Unified line diff of two texts. Returns rows in display order:
 * removed lines immediately followed by their added replacements.
 */
export function diffLines(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  const n = a.length
  const m = b.length

  // LCS length table
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'same', oldNo: i + 1, newNo: j + 1, text: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ kind: 'del', oldNo: i + 1, text: a[i] })
      i++
    } else {
      rows.push({ kind: 'add', newNo: j + 1, text: b[j] })
      j++
    }
  }
  while (i < n) rows.push({ kind: 'del', oldNo: i + 1, text: a[i++] })
  while (j < m) rows.push({ kind: 'add', newNo: j + 1, text: b[j++] })
  return rows
}

/** Count of changed (added/removed) lines. */
export function diffStat(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const r of rows) {
    if (r.kind === 'add') added++
    else if (r.kind === 'del') removed++
  }
  return { added, removed }
}
