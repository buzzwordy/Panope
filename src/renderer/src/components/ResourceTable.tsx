import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { ResourceDef, ColumnDef } from '@shared/catalog'
import type { K8sObject } from '@shared/types'
import type { MetricsMap } from '../hooks/useResourceData'
import { metricKey } from '../hooks/useResourceData'
import { COMPUTE, type StatusValue } from '../lib/accessors'
import { getByPath } from '../lib/getByPath'
import { formatCpu, formatMemory, humanDuration } from '../lib/format'
import { usageReference } from '../lib/usage'
import { computeWindow, type VirtualWindow } from '../lib/virtual'
import { StatusPill } from './cells/StatusPill'
import { UsageBar } from './cells/UsageBar'
import { Icon } from './Icon'

interface Props {
  def: ResourceDef
  /** Already filtered by namespace + search in the parent. */
  items: K8sObject[]
  metrics: MetricsMap
  now: number
  selectedUid?: string
  /** Column ids hidden by the user (or defaultHidden). 'namespace' hides that auto column. */
  hiddenColumns?: Set<string>
  /** Multi-select: uids currently ticked. Providing both enables the checkbox column. */
  checked?: Set<string>
  /** Tick/untick a batch of rows (single click, shift-range or select-all). */
  onCheckMany?: (objs: K8sObject[], checked: boolean) => void
  /** Mutating quick actions get disabled when true. */
  readOnly?: boolean
  /** Enable j/k/Enter keyboard navigation. Only ONE table on screen should own it. */
  keyboardNav?: boolean
  /** Kind-aware quick actions (logs/terminal/forward/restart/...). */
  onRowAction?: (action: RowAction, obj: K8sObject) => void
  onSelect: (obj: K8sObject) => void
  onDelete: (obj: K8sObject) => void
}

const uidOf = (o: K8sObject): string => o.metadata?.uid ?? `${o.metadata?.namespace}/${o.metadata?.name}`

export type RowAction = 'edit' | 'logs' | 'terminal' | 'ports' | 'copy' | 'restart' | 'trigger' | 'rerun'

interface RowActionDef {
  action: RowAction
  icon: string
  title: string
  /** blocked in read-only mode */
  mutating?: boolean
}

/** Kind-aware quick actions shown at the right of each row (before Delete). */
function rowActionsFor(def: ResourceDef): RowActionDef[] {
  const out: RowActionDef[] = []
  if (def.api === 'helm') {
    out.push({ action: 'copy', icon: 'copy', title: 'Copy name' })
    return out
  }
  if (def.key === 'pods') {
    out.push(
      { action: 'logs', icon: 'logs', title: 'Logs' },
      { action: 'terminal', icon: 'terminal', title: 'Terminal' },
      { action: 'ports', icon: 'forward', title: 'Port forward' },
      { action: 'restart', icon: 'refresh', title: 'Restart (delete & recreate)', mutating: true }
    )
  }
  if (def.key === 'services') out.push({ action: 'ports', icon: 'forward', title: 'Port forward' })
  if (['deployments', 'statefulsets', 'daemonsets'].includes(def.key))
    out.push({ action: 'restart', icon: 'refresh', title: 'Rollout restart', mutating: true })
  if (def.key === 'cronjobs') out.push({ action: 'trigger', icon: 'play', title: 'Trigger now', mutating: true })
  if (def.key === 'jobs') out.push({ action: 'rerun', icon: 'play', title: 'Re-run', mutating: true })
  out.push({ action: 'copy', icon: 'copy', title: 'Copy name' })
  out.push({ action: 'edit', icon: 'pencil', title: 'Edit YAML' })
  return out
}

type SortDir = 'asc' | 'desc'
interface SortState {
  col: string
  dir: SortDir
}

function isStatusValue(v: unknown): v is StatusValue {
  return typeof v === 'object' && v !== null && 'variant' in v
}

// Initial sort: normally Name ascending; for tables that lead with a column
// (e.g. Events -> Last Seen) sort by that column, newest/highest first if it's
// a time or metric column.
function defaultSortFor(def: ResourceDef): SortState {
  if (def.leadColumn) {
    const lc = def.columns.find((c) => c.id === def.leadColumn)
    const desc = lc?.kind === 'age' || lc?.kind === 'metric'
    return { col: def.leadColumn, dir: desc ? 'desc' : 'asc' }
  }
  return { col: 'name', dir: 'asc' }
}

// Raw comparable value for a column (used for sorting).
function sortValue(col: ColumnDef | { id: string; kind: string; field?: string }, obj: K8sObject): number | string {
  switch (col.id) {
    case 'name':
      return obj.metadata?.name ?? ''
    case 'namespace':
      return obj.metadata?.namespace ?? ''
  }
  if (col.kind === 'age') {
    const ts = getByPath(obj, (col as ColumnDef).field ?? 'metadata.creationTimestamp') as string
    return ts ? Date.parse(ts) : 0
  }
  const compute = COMPUTE[col.id]
  if (compute) {
    const v = compute(obj)
    if (isStatusValue(v)) return v.label
    if (typeof v === 'string') {
      const n = parseFloat(v)
      return Number.isNaN(n) ? v : n
    }
    return v
  }
  if (col.field) {
    const v = getByPath(obj, col.field)
    if (typeof v === 'number') return v
    return v == null ? '' : String(v)
  }
  return ''
}

export function ResourceTable({
  def,
  items,
  metrics,
  now,
  selectedUid,
  hiddenColumns,
  checked,
  onCheckMany,
  readOnly = false,
  keyboardNav = false,
  onRowAction,
  onSelect,
  onDelete
}: Props): React.ReactElement {
  const [sort, setSort] = useState<SortState>(() => defaultSortFor(def))
  const selectable = !!checked && !!onCheckMany
  const lastCheckIdx = useRef<number | null>(null)
  const quickActions = useMemo(() => (onRowAction ? rowActionsFor(def) : []), [def, onRowAction])

  // reset sort when switching resource type
  useEffect(() => setSort(defaultSortFor(def)), [def.key])

  const columns = useMemo(() => {
    const hidden = hiddenColumns ?? new Set(def.columns.filter((c) => c.defaultHidden).map((c) => c.id))
    const cols: ColumnDef[] = []
    if (!def.hideName) cols.push({ id: 'name', header: 'Name', kind: 'text', sortable: true })
    if (def.namespaced && !hidden.has('namespace'))
      cols.push({ id: 'namespace', header: 'Namespace', kind: 'text', sortable: true })
    for (const c of def.columns) {
      if (hidden.has(c.id)) continue
      cols.push({ ...c, sortable: c.sortable ?? (c.kind === 'age' || c.kind === 'metric') })
    }
    // Pull a designated column to the very front (e.g. Events -> Last Seen).
    if (def.leadColumn) {
      const i = cols.findIndex((c) => c.id === def.leadColumn)
      if (i > 0) cols.unshift(cols.splice(i, 1)[0])
    }
    return cols
  }, [def, hiddenColumns])

  const metricValue = (col: ColumnDef, obj: K8sObject): number => {
    const s = metrics.byKey.get(metricKey(obj.metadata?.namespace, obj.metadata?.name))
    if (!s) return -1 // rows without metrics sort below any real value
    return col.metric === 'cpu' ? s.cpu : s.memory
  }

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.id === sort.col) ?? columns[0]
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...items].sort((a, b) => {
      if (col.kind === 'metric') return (metricValue(col, a) - metricValue(col, b)) * dir
      const va = sortValue(col, a)
      const vb = sortValue(col, b)
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir
      return String(va).localeCompare(String(vb)) * dir
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, sort, columns, metrics])

  // ---- virtualization: mount only the rows near the viewport -------------
  // Above this row count, spacer rows stand in for everything off-screen.
  const VIRTUAL_THRESHOLD = 150
  const tableRef = useRef<HTMLTableElement>(null)
  const rowHeightRef = useRef(36)
  const [vwin, setVwin] = useState<VirtualWindow>(() => computeWindow(0, 4000, 36, items.length))
  const virtual = sorted.length > VIRTUAL_THRESHOLD

  useEffect(() => {
    if (!virtual) return
    const table = tableRef.current
    if (!table) return
    // nearest scrollable ancestor (.table-region in lists, .detail-body in detail)
    let parent: HTMLElement | null = table.parentElement
    while (parent && !/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) parent = parent.parentElement
    if (!parent) return
    const scrollEl = parent
    const update = (): void => {
      const first = table.querySelector('tbody tr:not(.vrow)') as HTMLElement | null
      if (first && first.offsetHeight > 8) rowHeightRef.current = first.offsetHeight
      const headerH = (table.querySelector('thead') as HTMLElement | null)?.offsetHeight ?? 0
      const offset = table.offsetTop + headerH
      const next = computeWindow(
        scrollEl.scrollTop - offset,
        scrollEl.clientHeight,
        rowHeightRef.current,
        sorted.length
      )
      setVwin((w) => (w.start === next.start && w.end === next.end ? w : next))
    }
    update()
    scrollEl.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(scrollEl)
    return () => {
      scrollEl.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [virtual, sorted.length, def.key])

  const rowStart = virtual ? Math.min(vwin.start, Math.max(0, sorted.length - 1)) : 0
  const rowEnd = virtual ? Math.min(vwin.end, sorted.length) : sorted.length
  const visibleRows = sorted.slice(rowStart, rowEnd)
  const rh = rowHeightRef.current

  // ---- keyboard navigation: j/k or arrows move, Enter opens ---------------
  const [cursor, setCursor] = useState(-1)
  useEffect(() => setCursor(-1), [def.key])
  useEffect(() => {
    if (!keyboardNav) return
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      // don't steal keys from inputs, editors or modals
      if (target && (target.closest('input, textarea, select, .cm-editor') || target.isContentEditable)) return
      if (document.querySelector('.modal-overlay')) return
      const down = e.key === 'j' || e.key === 'ArrowDown'
      const up = e.key === 'k' || e.key === 'ArrowUp'
      if (!down && !up && e.key !== 'Enter') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (down || up) {
        e.preventDefault()
        setCursor((c) => {
          const next = Math.max(0, Math.min(sorted.length - 1, c + (down ? 1 : -1)))
          // keep the cursor row in view (works with virtualization)
          const table = tableRef.current
          let parent: HTMLElement | null = table?.parentElement ?? null
          while (parent && !/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) parent = parent.parentElement
          if (parent && table) {
            const headerH = (table.querySelector('thead') as HTMLElement | null)?.offsetHeight ?? 0
            const rowTop = table.offsetTop + headerH + next * rowHeightRef.current
            if (rowTop < parent.scrollTop + headerH) parent.scrollTop = rowTop - headerH
            else if (rowTop + rowHeightRef.current > parent.scrollTop + parent.clientHeight)
              parent.scrollTop = rowTop + rowHeightRef.current - parent.clientHeight
          }
          return next
        })
      } else if (e.key === 'Enter') {
        setCursor((c) => {
          if (c >= 0 && c < sorted.length) onSelect(sorted[c])
          return c
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorted, def.key, keyboardNav])

  // per-column metric references (max across visible rows) for bar scaling
  const metricRefs = useMemo(() => {
    const refs: Record<string, number> = { cpu: 100, memory: 100 * 1024 * 1024 }
    if (!metrics.available) return refs
    for (const o of items) {
      const s = metrics.byKey.get(metricKey(o.metadata?.namespace, o.metadata?.name))
      if (!s) continue
      refs.cpu = Math.max(refs.cpu, s.cpu)
      refs.memory = Math.max(refs.memory, s.memory)
    }
    return refs
  }, [items, metrics])

  function toggleSort(colId: string): void {
    setSort((prev) =>
      prev.col === colId ? { col: colId, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { col: colId, dir: 'asc' }
    )
  }

  function renderCell(col: ColumnDef, obj: K8sObject): React.ReactNode {
    if (col.id === 'name') return <span className="cell-name">{obj.metadata?.name}</span>
    if (col.id === 'namespace') return <span className="cell-muted">{obj.metadata?.namespace}</span>

    if (col.kind === 'metric') {
      const metric = col.metric ?? 'cpu'
      const s = metrics.byKey.get(metricKey(obj.metadata?.namespace, obj.metadata?.name))
      const value = s ? (metric === 'cpu' ? s.cpu : s.memory) : 0
      const display = metric === 'cpu' ? formatCpu(value) : formatMemory(value)
      const { ref, isPercent } = usageReference(def.kind, obj, metric, metricRefs[metric])
      return (
        <UsageBar
          display={display}
          value={value}
          reference={ref}
          showPercent={isPercent}
          available={metrics.available && !!s}
        />
      )
    }

    if (col.kind === 'age') {
      const ts = getByPath(obj, col.field ?? 'metadata.creationTimestamp') as string
      return (
        <span className="cell--num" title={ts ? new Date(ts).toLocaleString() : undefined}>
          {humanDuration(ts, now)}
        </span>
      )
    }

    const compute = COMPUTE[col.id]
    if (col.kind === 'status') {
      let sv: StatusValue
      if (compute) sv = compute(obj) as StatusValue
      else {
        const raw = String(getByPath(obj, col.field ?? '') ?? '')
        sv = { label: raw, variant: 'unknown' }
      }
      return <StatusPill label={sv.label} variant={sv.variant} />
    }

    if (compute) {
      const v = compute(obj)
      const text = isStatusValue(v) ? v.label : String(v)
      return <span className={col.kind === 'number' ? 'cell--num' : ''}>{text}</span>
    }

    const raw = col.field ? getByPath(obj, col.field) : undefined
    const text = raw == null ? '' : String(raw)
    return <span className={col.kind === 'number' ? 'cell--num' : ''}>{text}</span>
  }

  const allChecked = selectable && sorted.length > 0 && sorted.every((o) => checked!.has(uidOf(o)))
  const someChecked = selectable && !allChecked && sorted.some((o) => checked!.has(uidOf(o)))

  function toggleRow(idx: number, shiftKey: boolean): void {
    if (!selectable) return
    const target = !checked!.has(uidOf(sorted[idx]))
    if (shiftKey && lastCheckIdx.current !== null) {
      const [a, b] = [Math.min(lastCheckIdx.current, idx), Math.max(lastCheckIdx.current, idx)]
      onCheckMany!(sorted.slice(a, b + 1), target)
    } else {
      onCheckMany!([sorted[idx]], target)
    }
    lastCheckIdx.current = idx
  }

  return (
    <table className="table" ref={tableRef}>
      <thead>
        <tr>
          {selectable && (
            <th className="cell-check" onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                title={allChecked ? 'Clear selection' : 'Select all (filtered)'}
                checked={allChecked}
                ref={(el) => {
                  if (el) el.indeterminate = someChecked
                }}
                onChange={() => onCheckMany!(sorted, !allChecked)}
              />
            </th>
          )}
          {columns.map((c) => {
            const active = sort.col === c.id
            const align = c.align === 'right' ? { textAlign: 'right' as const } : undefined
            return (
              <th
                key={c.id}
                className={c.sortable ? 'is-sortable' : undefined}
                style={align}
                onClick={c.sortable ? () => toggleSort(c.id) : undefined}
              >
                <span className="th-inner">
                  {c.header}
                  {c.sortable &&
                    (active ? (
                      <span className="th-arrow">{sort.dir === 'asc' ? '▲' : '▾'}</span>
                    ) : (
                      <span className="th-arrow th-arrow--inactive">▲</span>
                    ))}
                </span>
              </th>
            )
          })}
          <th style={{ width: 40 + (quickActions.length + 1) * 26 }} />
        </tr>
      </thead>
      <tbody>
        {virtual && rowStart > 0 && (
          <tr className="vrow" aria-hidden="true">
            <td
              colSpan={columns.length + 1 + (selectable ? 1 : 0)}
              style={{ height: rowStart * rh, padding: 0, border: 0 }}
            />
          </tr>
        )}
        {visibleRows.map((obj, i) => {
          const uid = obj.metadata?.uid
          const rowUid = uidOf(obj)
          const isChecked = selectable && checked!.has(rowUid)
          const rowClasses = [
            uid && uid === selectedUid ? 'is-selected' : '',
            isChecked ? 'is-checked' : '',
            rowStart + i === cursor ? 'is-cursor' : ''
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <tr
              key={rowUid}
              className={rowClasses || undefined}
              onClick={() => onSelect(obj)}
            >
              {selectable && (
                <td className="cell-check" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => undefined}
                    onClick={(e) => toggleRow(rowStart + i, e.shiftKey)}
                  />
                </td>
              )}
              {columns.map((c) => (
                <td key={c.id} style={c.align === 'right' ? { textAlign: 'right' } : undefined}>
                  {renderCell(c, obj)}
                </td>
              ))}
              <td>
                <div className="row-actions">
                  {quickActions.map((a) => (
                    <button
                      key={a.action}
                      className="icon-btn"
                      title={a.title}
                      disabled={a.mutating && readOnly}
                      onClick={(e) => {
                        e.stopPropagation()
                        onRowAction?.(a.action, obj)
                      }}
                    >
                      <Icon name={a.icon} size={13} />
                    </button>
                  ))}
                  {quickActions.length === 0 && (
                    <button
                      className="icon-btn"
                      title="View"
                      onClick={(e) => {
                        e.stopPropagation()
                        onSelect(obj)
                      }}
                    >
                      <Icon name="pencil" size={13} />
                    </button>
                  )}
                  <button
                    className="icon-btn icon-btn--danger"
                    title="Delete"
                    disabled={readOnly}
                    onClick={(e) => {
                      e.stopPropagation()
                      onDelete(obj)
                    }}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              </td>
            </tr>
          )
        })}
        {virtual && rowEnd < sorted.length && (
          <tr className="vrow" aria-hidden="true">
            <td
              colSpan={columns.length + 1 + (selectable ? 1 : 0)}
              style={{ height: (sorted.length - rowEnd) * rh, padding: 0, border: 0 }}
            />
          </tr>
        )}
      </tbody>
    </table>
  )
}
