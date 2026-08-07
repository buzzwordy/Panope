import React, { useEffect, useRef, useState } from 'react'
import type { K8sObject } from '@shared/types'
import type { ResourceDef } from '@shared/catalog'
import { parseMemoryToBytes } from '@shared/quantity'
import { getByPath } from '../../lib/getByPath'
import { humanDuration } from '../../lib/format'
import { Icon } from '../Icon'

type Pair = [string, React.ReactNode]

function gb(v: unknown): string {
  const bytes = parseMemoryToBytes(v as string)
  if (!bytes) return '-'
  return `${(bytes / 1e9).toFixed(1)} GB`
}
function val(v: unknown): React.ReactNode {
  return v == null || v === '' ? '-' : String(v)
}

function Grid({ pairs }: { pairs: Pair[] }): React.ReactElement {
  return (
    <dl className="spec-grid">
      {pairs.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

function NodeSpec({ obj }: { obj: K8sObject }): React.ReactElement {
  const ni = (getByPath(obj, 'status.nodeInfo') ?? {}) as Record<string, string>
  const alloc = (getByPath(obj, 'status.allocatable') ?? {}) as Record<string, string>
  const left: Pair[] = [
    ['allocatable CPU', val(alloc.cpu)],
    ['allocatable memory', gb(alloc.memory)],
    ['allocatable pods', val(alloc.pods)],
    ['allocatable nvidia GPU', val(alloc['nvidia.com/gpu'])],
    ['architecture', val(ni.architecture)],
    ['boot ID', val(ni.bootID)],
    ['container runtime', val(ni.containerRuntimeVersion)]
  ]
  const right: Pair[] = [
    ['created', val(obj.metadata?.creationTimestamp)],
    ['kernel version', val(ni.kernelVersion)],
    ['kube proxy version', val(ni.kubeProxyVersion)],
    ['kubelet version', val(ni.kubeletVersion)],
    ['machine ID', val(ni.machineID)],
    ['operating system', val(ni.operatingSystem)],
    ['OS image', val(ni.osImage)],
    ['system UUID', val(ni.systemUUID)]
  ]
  const conditions = (getByPath(obj, 'status.conditions') as Array<Record<string, string>>) ?? []
  const addresses = (getByPath(obj, 'status.addresses') as Array<{ type: string; address: string }>) ?? []

  return (
    <div className="spec">
      <div className="spec-card spec-two">
        <Grid pairs={left} />
        <Grid pairs={right} />
      </div>

      {conditions.length > 0 && (
        <table className="table spec-table">
          <thead>
            <tr>
              <th style={{ width: 28 }} />
              <th>Condition</th>
              <th>Status</th>
              <th>Reason</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {conditions.map((c) => (
              <tr key={c.type}>
                <td>
                  <span className="cond-badge">{c.type?.[0]}</span>
                </td>
                <td>{c.type}</td>
                <td>{c.status}</td>
                <td>{c.reason}</td>
                <td style={{ whiteSpace: 'normal', userSelect: 'text' }}>{c.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {addresses.length > 0 && (
        <table className="table spec-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Address</th>
            </tr>
          </thead>
          <tbody>
            {addresses.map((a) => (
              <tr key={a.type + a.address}>
                <td>{a.type}</td>
                <td style={{ userSelect: 'text' }}>{a.address}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function PodSpec({ obj }: { obj: K8sObject }): React.ReactElement {
  const containers =
    (getByPath(obj, 'spec.containers') as Array<{
      name: string
      image: string
      resources?: { requests?: Record<string, string>; limits?: Record<string, string> }
    }>) ?? []
  const statuses = (getByPath(obj, 'status.containerStatuses') as Array<{ name: string; ready?: boolean }>) ?? []
  const readyOf = (n: string): boolean => statuses.find((s) => s.name === n)?.ready ?? false

  const left: Pair[] = [
    ['node', val(getByPath(obj, 'spec.nodeName'))],
    ['pod IP', val(getByPath(obj, 'status.podIP'))],
    ['host IP', val(getByPath(obj, 'status.hostIP'))],
    ['QoS class', val(getByPath(obj, 'status.qosClass'))]
  ]
  const right: Pair[] = [
    ['service account', val(getByPath(obj, 'spec.serviceAccountName'))],
    ['restart policy', val(getByPath(obj, 'spec.restartPolicy'))],
    ['priority', val(getByPath(obj, 'spec.priority'))],
    ['start time', val(getByPath(obj, 'status.startTime'))]
  ]

  const res = (c: { resources?: { requests?: Record<string, string>; limits?: Record<string, string> } }, k: string): string => {
    const req = c.resources?.requests?.[k]
    const lim = c.resources?.limits?.[k]
    if (!req && !lim) return '-'
    return `${req ?? '-'} / ${lim ?? '-'}`
  }

  return (
    <div className="spec">
      <div className="spec-card spec-two">
        <Grid pairs={left} />
        <Grid pairs={right} />
      </div>
      <table className="table spec-table">
        <thead>
          <tr>
            <th>Container</th>
            <th>Image</th>
            <th>CPU (req / lim)</th>
            <th>Memory (req / lim)</th>
            <th>Ready</th>
          </tr>
        </thead>
        <tbody>
          {containers.map((c) => (
            <tr key={c.name}>
              <td>{c.name}</td>
              <td style={{ userSelect: 'text' }}>{c.image}</td>
              <td className="cell--num">{res(c, 'cpu')}</td>
              <td className="cell--num">{res(c, 'memory')}</td>
              <td>{readyOf(c.name) ? 'Yes' : 'No'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function decodeB64(v: string): string {
  try {
    const bytes = Uint8Array.from(atob(v), (c) => c.charCodeAt(0))
    return new TextDecoder('utf-8').decode(bytes)
  } catch {
    return '<binary>'
  }
}

/** How long a revealed secret value stays visible before auto-concealing. */
const REVEAL_TIMEOUT_MS = 30_000

/** Secret / ConfigMap: header + a decoded KEY/VALUE table.
 *  Secret values are MASKED by default; reveal is per-key and auto-conceals
 *  after 30s. Copy always copies the decoded value without revealing it. */
function DataSpec({ obj, isSecret }: { obj: K8sObject; isSecret: boolean }): React.ReactElement {
  const data = (obj.data ?? {}) as Record<string, string>
  const binaryData = (obj.binaryData ?? {}) as Record<string, string>
  const entries = [...Object.entries(data), ...Object.entries(binaryData)]
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState<string | null>(null)
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Auto-conceal timers cleared on unmount; reset reveals when object changes.
  useEffect(() => {
    setRevealed(new Set())
    const timers = timersRef.current
    return () => {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
  }, [obj.metadata?.uid])

  function toggleReveal(key: string): void {
    setRevealed((prev) => {
      const next = new Set(prev)
      const timer = timersRef.current.get(key)
      if (timer) {
        clearTimeout(timer)
        timersRef.current.delete(key)
      }
      if (next.has(key)) next.delete(key)
      else {
        next.add(key)
        timersRef.current.set(
          key,
          setTimeout(() => {
            setRevealed((p) => {
              const n = new Set(p)
              n.delete(key)
              return n
            })
            timersRef.current.delete(key)
          }, REVEAL_TIMEOUT_MS)
        )
      }
      return next
    })
  }

  async function copyValue(key: string, raw: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(isSecret ? decodeB64(raw) : raw)
      setCopied(key)
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  const left: Pair[] = isSecret
    ? [['type', val(obj.type)], ['keys', entries.length]]
    : [['keys', entries.length]]
  const right: Pair[] = [['created', val(obj.metadata?.creationTimestamp)], ['namespace', val(obj.metadata?.namespace)]]

  const render = (k: string, v: string): string => {
    if (isSecret && !revealed.has(k)) return '••••••••••'
    return isSecret ? decodeB64(v) : v
  }

  return (
    <div className="spec">
      <div className="spec-card spec-two">
        <Grid pairs={left} />
        <Grid pairs={right} />
      </div>
      {isSecret && entries.length > 0 && (
        <div className="secret-hint">
          Values are masked in this table - reveal is per-key and re-masks after {REVEAL_TIMEOUT_MS / 1000}s; copy
          never reveals. Note: the View tab shows the raw object including base64 data.
        </div>
      )}
      {entries.length === 0 ? (
        <div className="empty-hint" style={{ textAlign: 'left' }}>No data.</div>
      ) : (
        <table className="table spec-table">
          <thead>
            <tr>
              <th style={{ width: '34%' }}>Key</th>
              <th>Value</th>
              <th style={{ width: 84 }} />
            </tr>
          </thead>
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k}>
                <td style={{ fontFamily: 'var(--font-mono)', userSelect: 'text' }}>{k}</td>
                <td style={{ fontFamily: 'var(--font-mono)', userSelect: 'text', whiteSpace: 'normal', wordBreak: 'break-all' }}>
                  {render(k, v)}
                </td>
                <td>
                  <div className="row-actions" style={{ opacity: 1 }}>
                    {isSecret && (
                      <button
                        className="icon-btn"
                        title={revealed.has(k) ? 'Conceal' : 'Reveal (auto-conceals)'}
                        onClick={() => toggleReveal(k)}
                      >
                        <Icon name={revealed.has(k) ? 'eye-off' : 'eye'} size={13} />
                      </button>
                    )}
                    <button
                      className="icon-btn"
                      title={copied === k ? 'Copied!' : 'Copy decoded value'}
                      onClick={() => copyValue(k, v)}
                    >
                      <Icon name={copied === k ? 'check' : 'copy'} size={13} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export function SpecificationsPanel({
  def,
  obj,
  now
}: {
  def: ResourceDef
  obj: K8sObject
  now: number
}): React.ReactElement {
  if (def.kind === 'Node') return <NodeSpec obj={obj} />
  if (def.kind === 'Pod') return <PodSpec obj={obj} />
  if (def.kind === 'Secret') return <DataSpec obj={obj} isSecret />
  if (def.kind === 'ConfigMap') return <DataSpec obj={obj} isSecret={false} />

  const meta = obj.metadata ?? {}
  const pairs: Pair[] = [
    ['name', val(meta.name)],
    ['namespace', val(meta.namespace)],
    ['kind', val(obj.kind ?? def.kind)],
    ['api version', val(obj.apiVersion ?? def.apiVersion)],
    ['created', meta.creationTimestamp ? `${humanDuration(meta.creationTimestamp, now)} ago` : '-'],
    ['uid', val(meta.uid)]
  ]
  return (
    <div className="spec">
      <div className="spec-card">
        <Grid pairs={pairs} />
      </div>
    </div>
  )
}
