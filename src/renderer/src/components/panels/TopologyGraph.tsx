import React, { useMemo } from 'react'
import type { K8sObject } from '@shared/types'
import type { ResourceDef } from '@shared/catalog'
import { Icon } from '../Icon'

/**
 * The Related neighbourhood drawn as a node-link graph instead of a tree.
 * Layout is a tidy top-down tree: every child sits under its parent and a
 * parent centres over its children, so the owner chain reads top to bottom and
 * Services/Ingresses branch off cleanly. Edges are SVG; each node is a real
 * button in a foreignObject, so hover, click and theming come from the same
 * related-card CSS the tree uses.
 */

export interface TopoNode {
  def: ResourceDef
  obj: K8sObject
  note?: string
  children: TopoNode[]
}

interface Props {
  root: TopoNode
  selfUid?: string
  onDrill: (def: ResourceDef, obj: K8sObject) => void
}

const NODE_W = 190
const NODE_H = 52
const H_GAP = 26
const V_GAP = 74

interface Placed {
  id: string
  node: TopoNode
  x: number // centre x
  y: number // top y
}

function nodeId(n: TopoNode): string {
  return `${n.def.key}-${n.obj.metadata?.uid ?? n.obj.metadata?.name}`
}

export function TopologyGraph({ root, selfUid, onDrill }: Props): React.ReactElement {
  const { placed, edges, width, height } = useMemo(() => {
    const placed: Placed[] = []
    const edges: Array<{ from: string; to: string }> = []
    let slot = 0

    // Post-order: a leaf takes the next horizontal slot; a parent centres over
    // the span of its children. Returns the node's centre x in pixels.
    const place = (n: TopoNode, depth: number): number => {
      const id = nodeId(n)
      let cx: number
      if (n.children.length === 0) {
        cx = slot * (NODE_W + H_GAP) + NODE_W / 2
        slot++
      } else {
        const xs = n.children.map((c) => {
          edges.push({ from: id, to: nodeId(c) })
          return place(c, depth + 1)
        })
        cx = (xs[0] + xs[xs.length - 1]) / 2
      }
      placed.push({ id, node: n, x: cx, y: depth * (NODE_H + V_GAP) })
      return cx
    }
    place(root, 0)

    const maxDepth = placed.reduce((m, p) => Math.max(m, p.y), 0)
    return {
      placed,
      edges,
      width: Math.max(slot * (NODE_W + H_GAP), NODE_W + H_GAP),
      height: maxDepth + NODE_H
    }
  }, [root])

  const pos = useMemo(() => new Map(placed.map((p) => [p.id, p])), [placed])

  return (
    <div className="topo">
      <svg className="topo__svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <g className="topo__edges">
          {edges.map((e, i) => {
            const a = pos.get(e.from)
            const b = pos.get(e.to)
            if (!a || !b) return null
            const x1 = a.x
            const y1 = a.y + NODE_H
            const x2 = b.x
            const y2 = b.y
            const mid = (y1 + y2) / 2
            return <path key={i} className="topo__edge" d={`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`} />
          })}
        </g>
        {placed.map((p) => {
          const isSelf = p.node.obj.metadata?.uid === selfUid
          return (
            <foreignObject key={p.id} x={p.x - NODE_W / 2} y={p.y} width={NODE_W} height={NODE_H}>
              <button
                className={`related-card topo__card${isSelf ? ' is-self' : ''}`}
                onClick={() => !isSelf && onDrill(p.node.def, p.node.obj)}
                title={isSelf ? 'This object' : `Open ${p.node.def.kind} ${p.node.obj.metadata?.name}`}
              >
                <Icon name={p.node.def.icon} size={14} />
                <span className="topo__card-body">
                  <span className="related-card__kind">{p.node.def.kind}</span>
                  <span className="related-card__name">{p.node.obj.metadata?.name}</span>
                </span>
                {p.node.note && <span className="related-card__note">{p.node.note}</span>}
              </button>
            </foreignObject>
          )
        })}
      </svg>
    </div>
  )
}
