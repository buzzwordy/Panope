import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { CATALOG, groupedCatalog, type CategoryGroup, type ResourceDef } from '@shared/catalog'
import { crdToDef } from '../lib/customCatalog'

/** A named super-section of CRDs (e.g. Crossplane, Custom Resources), itself
 * divided into collapsible per-API-group subgroups. */
export interface CrdSection {
  name: string
  groups: CategoryGroup[]
}

export interface Catalog {
  byKey: Map<string, ResourceDef>
  /** Static built-in groups + the ArgoCD group (flat, top-level). */
  groups: CategoryGroup[]
  /** CRD super-sections (Crossplane, Custom Resources) with per-group subgroups. */
  crdSections: CrdSection[]
  crdsLoaded: boolean
}

const STATIC_GROUPS = groupedCatalog()

/** Crossplane core + provider (upbound) API groups get their own section. */
function isCrossplaneGroup(g: string): boolean {
  return g === 'crossplane.io' || g.endsWith('.crossplane.io') || g.endsWith('.upbound.io')
}

export function useCatalog(contextVersion: number): Catalog {
  const [customDefs, setCustomDefs] = useState<ResourceDef[]>([])
  const [crdsLoaded, setCrdsLoaded] = useState(false)

  useEffect(() => {
    let disposed = false
    setCustomDefs([])
    setCrdsLoaded(false)
    api.listCRDs().then((crds) => {
      if (disposed) return
      setCustomDefs(crds.map(crdToDef))
      setCrdsLoaded(true)
    })
    return () => {
      disposed = true
    }
  }, [contextVersion])

  return useMemo(() => {
    const byKey = new Map<string, ResourceDef>()
    for (const d of CATALOG) byKey.set(d.key, d)
    for (const d of customDefs) byKey.set(d.key, d)

    const groups: CategoryGroup[] = [...STATIC_GROUPS]

    // ArgoCD gets its own top-level section (all argoproj.io kinds), like the
    // built-in Storage / Configuration / etc. sections.
    const argoOrder = ['Application', 'ApplicationSet', 'AppProject']
    const argo = customDefs
      .filter((d) => (d.custom?.group || d.group) === 'argoproj.io')
      .sort((a, b) => {
        const ia = argoOrder.indexOf(a.kind)
        const ib = argoOrder.indexOf(b.kind)
        if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
        return a.kind.localeCompare(b.kind)
      })
    if (argo.length) groups.push({ name: 'ArgoCD', items: argo })

    // Remaining CRDs divided into a subgroup per API group (excl. argoproj.io).
    const byGroup = new Map<string, ResourceDef[]>()
    for (const d of customDefs) {
      const g = d.custom?.group || d.group || 'core'
      if (g === 'argoproj.io') continue
      const arr = byGroup.get(g)
      if (arr) arr.push(d)
      else byGroup.set(g, [d])
    }
    const allGroups: CategoryGroup[] = Array.from(byGroup.entries())
      .map(([name, items]) => ({ name, items: items.sort((a, b) => a.kind.localeCompare(b.kind)) }))
      .sort((a, b) => a.name.localeCompare(b.name))

    // Split into named super-sections: Crossplane (its own), then everything else.
    const crossplane = allGroups.filter((g) => isCrossplaneGroup(g.name))
    const others = allGroups.filter((g) => !isCrossplaneGroup(g.name))
    const crdSections: CrdSection[] = []
    if (crossplane.length) crdSections.push({ name: 'Crossplane', groups: crossplane })
    if (others.length) crdSections.push({ name: 'Custom Resources', groups: others })

    return { byKey, groups, crdSections, crdsLoaded }
  }, [customDefs, crdsLoaded])
}
