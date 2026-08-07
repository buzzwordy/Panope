import React, { useEffect, useMemo, useState } from 'react'
import type { K8sObject } from '@shared/types'
import { getResourceDef, type ResourceDef } from '@shared/catalog'
import { api } from '../../api'
import { Icon } from '../Icon'
import { getByPath } from '../../lib/getByPath'
import { getSelector, matchesSelector } from '../../lib/owned'
import { TopologyGraph } from './TopologyGraph'

/**
 * Everything this object is connected to, as a navigable tree:
 * up the owner chain (Pod -> ReplicaSet -> Deployment), down to what it manages,
 * and sideways to what it references (Services selecting it, ConfigMaps and
 * Secrets it mounts, PVCs, Ingresses routing to its Services).
 */

interface Props {
  def: ResourceDef
  obj: K8sObject
  onDrill: (def: ResourceDef, obj: K8sObject) => void
}

interface Node {
  def: ResourceDef
  obj: K8sObject
  note?: string
  children: Node[]
}

const KIND_TO_KEY: Record<string, string> = {
  Deployment: 'deployments',
  ReplicaSet: 'replicasets',
  StatefulSet: 'statefulsets',
  DaemonSet: 'daemonsets',
  Job: 'jobs',
  CronJob: 'cronjobs',
  ReplicationController: 'replicationcontrollers',
  Pod: 'pods'
}

export function RelatedPanel({ def, obj, onDrill }: Props): React.ReactElement {
  const [tree, setTree] = useState<Node | null>(null)
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<'graph' | 'tree'>('graph')

  const ns = obj.metadata?.namespace

  useEffect(() => {
    let disposed = false
    setLoading(true)

    async function listKey(key: string): Promise<K8sObject[]> {
      try {
        const res = await api.listResource(key)
        return res.items.filter((o) => !ns || o.metadata?.namespace === ns)
      } catch {
        return []
      }
    }

    async function build(): Promise<void> {
      const wanted = ['pods', 'replicasets', 'deployments', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs', 'services', 'ingresses', 'configmaps', 'secrets', 'persistentvolumeclaims']
      const lists = new Map<string, K8sObject[]>()
      await Promise.all(
        wanted.map(async (k) => {
          lists.set(k, await listKey(k))
        })
      )
      if (disposed) return

      const defOf = (key: string): ResourceDef | undefined => getResourceDef(key)
      const byUid = new Map<string, { key: string; obj: K8sObject }>()
      for (const [key, items] of lists) {
        for (const o of items) if (o.metadata?.uid) byUid.set(o.metadata.uid, { key, obj: o })
      }

      // ---- climb the owner chain to the root controller
      let rootKey = def.key
      let root = obj
      const seen = new Set<string>()
      for (;;) {
        const uid = root.metadata?.uid ?? ''
        if (seen.has(uid)) break
        seen.add(uid)
        const ref = root.metadata?.ownerReferences?.[0]
        if (!ref) break
        const parent = byUid.get(ref.uid)
        if (!parent) {
          // owner exists but isn't in one of the lists we loaded (e.g. a CRD) -
          // stop climbing; the chain below still shows this object.
          break
        }
        rootKey = parent.key
        root = parent.obj
      }

      // ---- descend: children by ownerReferences, recursively
      const childOf = (parentUid: string): Array<{ key: string; obj: K8sObject }> => {
        const out: Array<{ key: string; obj: K8sObject }> = []
        for (const [key, items] of lists) {
          for (const o of items) {
            if ((o.metadata?.ownerReferences ?? []).some((r) => r.uid === parentUid)) out.push({ key, obj: o })
          }
        }
        return out
      }

      const mkNode = (key: string, o: K8sObject, note?: string, depth = 0): Node => {
        const d = defOf(key) ?? def
        const children: Node[] = []
        if (depth < 4) {
          for (const c of childOf(o.metadata?.uid ?? '')) {
            children.push(mkNode(c.key, c.obj, undefined, depth + 1))
          }
        }
        // Pods: attach referenced config/secrets/PVCs as leaves
        if (key === 'pods' && depth < 4) {
          const volumes = (getByPath(o, 'spec.volumes') as Array<Record<string, { name?: string; secretName?: string; claimName?: string }>> | undefined) ?? []
          for (const v of volumes) {
            const cm = (v.configMap as { name?: string } | undefined)?.name
            const sec = (v.secret as { secretName?: string } | undefined)?.secretName
            const pvc = (v.persistentVolumeClaim as { claimName?: string } | undefined)?.claimName
            const attach = (lkey: string, name: string | undefined, note: string): void => {
              if (!name) return
              const target = lists.get(lkey)?.find((x) => x.metadata?.name === name)
              const ld = defOf(lkey)
              if (target && ld && !children.some((c) => c.obj.metadata?.uid === target.metadata?.uid)) {
                children.push({ def: ld, obj: target, note, children: [] })
              }
            }
            attach('configmaps', cm, 'mounted')
            attach('secrets', sec, 'mounted')
            attach('persistentvolumeclaims', pvc, 'mounted')
          }
        }
        return { def: d, obj: o, note, children }
      }

      const rootNode = mkNode(rootKey, root, rootKey !== def.key ? 'owner' : undefined)

      // ---- sideways: Services selecting the root's pods; Ingresses -> those Services
      const rootSelector = getSelector(root)
      const pods = lists.get('pods') ?? []
      const ourPods = rootSelector
        ? pods.filter((p) => matchesSelector(p, rootSelector))
        : rootKey === 'pods'
          ? [root]
          : []
      const services = (lists.get('services') ?? []).filter((svc) => {
        const sel = (getByPath(svc, 'spec.selector') as Record<string, string> | undefined) ?? {}
        if (!Object.keys(sel).length) return false
        return ourPods.some((p) => Object.entries(sel).every(([k, v]) => (p.metadata?.labels ?? {})[k] === v))
      })
      const svcDef = defOf('services')
      const ingDef = defOf('ingresses')
      for (const svc of services) {
        if (!svcDef) break
        const svcNode: Node = { def: svcDef, obj: svc, note: 'routes to these pods', children: [] }
        const ingresses = (lists.get('ingresses') ?? []).filter((ing) =>
          JSON.stringify(ing.spec ?? {}).includes(`"${svc.metadata?.name}"`)
        )
        if (ingDef) {
          for (const ing of ingresses) svcNode.children.push({ def: ingDef, obj: ing, note: 'exposes', children: [] })
        }
        rootNode.children.push(svcNode)
      }

      if (!disposed) {
        setTree(rootNode)
        setLoading(false)
      }
    }

    void build()
    return () => {
      disposed = true
    }
  }, [obj.metadata?.uid]) // eslint-disable-line react-hooks/exhaustive-deps

  const selfUid = obj.metadata?.uid

  const render = useMemo(() => {
    const renderNode = (n: Node, depth: number): React.ReactElement => {
      const isSelf = n.obj.metadata?.uid === selfUid
      return (
        <div key={`${n.def.key}-${n.obj.metadata?.uid}`} className="related-node" style={{ marginLeft: depth ? 22 : 0 }}>
          <button
            className={`related-card${isSelf ? ' is-self' : ''}`}
            onClick={() => !isSelf && onDrill(n.def, n.obj)}
            title={isSelf ? 'This object' : `Open ${n.def.kind} ${n.obj.metadata?.name}`}
          >
            <Icon name={n.def.icon} size={14} />
            <span className="related-card__kind">{n.def.kind}</span>
            <span className="related-card__name">{n.obj.metadata?.name}</span>
            {n.note && <span className="related-card__note">{n.note}</span>}
            {isSelf && <span className="related-card__self">you are here</span>}
          </button>
          {n.children.map((c) => renderNode(c, depth + 1))}
        </div>
      )
    }
    return tree ? renderNode(tree, 0) : null
  }, [tree, selfUid, onDrill])

  if (loading) {
    return (
      <div className="state">
        <div className="spinner" />
        <div className="state__title">Resolving relationships...</div>
      </div>
    )
  }

  return (
    <div className="related">
      <div className="related__bar">
        <div className="related__hint">
          Owner chain, managed objects, mounted config and exposure - click any card to open it.
        </div>
        <div className="seg">
          <button className={`seg__btn${view === 'graph' ? ' is-active' : ''}`} onClick={() => setView('graph')}>
            <Icon name="layers" size={13} /> Graph
          </button>
          <button className={`seg__btn${view === 'tree' ? ' is-active' : ''}`} onClick={() => setView('tree')}>
            <Icon name="list" size={13} /> Tree
          </button>
        </div>
      </div>
      {view === 'tree' ? render : tree && <TopologyGraph root={tree} selfUid={selfUid} onDrill={onDrill} />}
    </div>
  )
}
