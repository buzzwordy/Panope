// CSV export for resource lists: same accessors the table uses, plain text out.

import type { ColumnDef, ResourceDef } from '@shared/catalog'
import type { K8sObject } from '@shared/types'
import { COMPUTE } from './accessors'
import { getByPath } from './getByPath'

function cellText(col: ColumnDef, obj: K8sObject): string {
  if (col.id === 'name') return obj.metadata?.name ?? ''
  if (col.id === 'namespace') return obj.metadata?.namespace ?? ''
  if (col.kind === 'age') {
    const ts = getByPath(obj, col.field ?? 'metadata.creationTimestamp') as string
    return ts ?? ''
  }
  const compute = COMPUTE[col.id]
  if (compute) {
    const v = compute(obj)
    if (v && typeof v === 'object' && 'label' in v) return String(v.label)
    return String(v ?? '')
  }
  if (col.field) {
    const v = getByPath(obj, col.field)
    return v == null ? '' : String(v)
  }
  return ''
}

function escape(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/** Rows in current sort order x the visible columns, as CSV text. */
export function toCsv(def: ResourceDef, items: K8sObject[], hidden: Set<string>): string {
  const cols: ColumnDef[] = []
  if (!def.hideName) cols.push({ id: 'name', header: 'Name', kind: 'text' })
  if (def.namespaced && !hidden.has('namespace')) cols.push({ id: 'namespace', header: 'Namespace', kind: 'text' })
  for (const c of def.columns) if (!hidden.has(c.id) && c.kind !== 'metric') cols.push(c)
  const head = cols.map((c) => escape(c.header)).join(',')
  const rows = items.map((o) => cols.map((c) => escape(cellText(c, o))).join(','))
  return [head, ...rows].join('\n')
}
