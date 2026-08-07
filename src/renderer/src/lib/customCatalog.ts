import type { CrdInfo } from '@shared/types'
import type { ColumnDef, ResourceDef } from '@shared/catalog'

const AGE: ColumnDef = {
  id: 'age',
  header: 'Age',
  kind: 'age',
  field: 'metadata.creationTimestamp',
  align: 'right',
  sortable: true
}

/** ArgoCD Application gets sync/health status columns. */
function argoColumns(kind: string): ColumnDef[] {
  if (kind === 'Application') {
    return [
      { id: 'argo.sync', header: 'Sync', kind: 'status', sortable: true },
      { id: 'argo.health', header: 'Health', kind: 'status', sortable: true },
      { id: 'argo.project', header: 'Project', kind: 'text', field: 'spec.project' },
      { id: 'argo.revision', header: 'Revision', kind: 'text', field: 'status.sync.revision' },
      AGE
    ]
  }
  return [AGE]
}

export function crdKey(crd: { group: string; version: string; plural: string }): string {
  return `crd:${crd.group}/${crd.version}/${crd.plural}`
}

/** Build table columns from a CRD's additionalPrinterColumns (skipping ones with
 * jsonpath filters/arrays we can't resolve), always ending with Age. */
function crdColumns(crd: CrdInfo): ColumnDef[] {
  if (crd.group === 'argoproj.io') return argoColumns(crd.kind)
  const cols: ColumnDef[] = []
  for (const pc of crd.printerColumns ?? []) {
    const path = pc.jsonPath.replace(/^\./, '')
    if (/creationtimestamp/i.test(path) || /^age$/i.test(pc.name)) continue // Age added below
    if (/[[\]()@?*]/.test(path) || !path) continue // unresolvable jsonpath expression
    cols.push({ id: `pc:${pc.name}`, header: pc.name, kind: 'text', field: path })
  }
  cols.push(AGE)
  return cols
}

export function crdToDef(crd: CrdInfo): ResourceDef {
  const isArgo = crd.group === 'argoproj.io'
  return {
    key: crdKey(crd),
    label: crd.kind,
    kind: crd.kind,
    // Every CRD lives under a single "Custom Resources" area, divided by API group.
    category: 'Custom Resources',
    icon: isArgo ? 'argo' : 'crd',
    apiVersion: `${crd.group}/${crd.version}`,
    group: crd.group,
    namespaced: crd.namespaced,
    api: 'custom',
    listMethod: '',
    watchPath: `/apis/${crd.group}/${crd.version}/${crd.plural}`,
    custom: { group: crd.group, version: crd.version, plural: crd.plural, namespaced: crd.namespaced },
    // ArgoCD Application keeps its sync/health columns; other CRDs use their
    // additionalPrinterColumns (falling back to just Age).
    columns: crdColumns(crd)
  }
}
