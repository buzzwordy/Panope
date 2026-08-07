import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { K8sObject } from '@shared/types'
import { api } from '../../api'
import { stripAnsi } from '../../lib/ansi'
import { Icon } from '../Icon'
import { AnsiLine } from './LogsPanel'

interface Props {
  namespace: string
  /** Live list of pods owned by the workload (auto attach/detach on churn). */
  pods: K8sObject[]
}

interface MergedLine {
  id: number
  pod: string
  container: string
  color: string
  text: string
}

const MAX_LINES = 5000
const MAX_STREAMS = 24
const TAIL_PER_POD = 200

// stern-style pod prefix colors (readable on dark + light)
const POD_COLORS = ['#4dc4ff', '#a5e075', '#f0a45d', '#de73ff', '#4cd1e0', '#ff9d9d', '#e5d068', '#8fa3ff']

function colorFor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return POD_COLORS[h % POD_COLORS.length]
}

function podContainerNames(pod: K8sObject): string[] {
  const spec = (pod.spec ?? {}) as { containers?: Array<{ name: string }> }
  return (spec.containers ?? []).map((c) => c.name)
}

export function WorkloadLogsPanel({ namespace, pods }: Props): React.ReactElement {
  const [lines, setLines] = useState<MergedLine[]>([])
  const [search, setSearch] = useState('')
  const [showContainer, setShowContainer] = useState(false)
  const [follow, setFollow] = useState(true)
  const [nonce, setNonce] = useState(0)
  const viewRef = useRef<HTMLDivElement>(null)
  // stream id -> source meta + partial-line buffer
  const streamsRef = useRef<Map<string, { pod: string; container: string; buf: string }>>(new Map())
  // pod/container keys we already attached, to diff on pod churn
  const attachedRef = useRef<Set<string>>(new Set())
  // monotonic id per emitted line - stable React keys survive front-trimming
  const lineIdRef = useRef(0)
  // how many pods were dropped by the MAX_STREAMS cap
  const [capped, setCapped] = useState(0)

  const multiContainer = useMemo(() => pods.some((p) => podContainerNames(p).length > 1), [pods])

  // One shared data listener for every stream in this panel.
  useEffect(() => {
    const unsub = api.onLogData((chunk) => {
      const meta = streamsRef.current.get(chunk.id)
      if (!meta) return
      if (chunk.data) {
        meta.buf += chunk.data
        const parts = meta.buf.split('\n')
        meta.buf = parts.pop() ?? ''
        if (parts.length) {
          const color = colorFor(meta.pod)
          setLines((prev) => {
            const next = prev.concat(
              parts.map((text) => ({ id: lineIdRef.current++, pod: meta.pod, container: meta.container, color, text }))
            )
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
          })
        }
      }
      if (chunk.error && !/context switched/i.test(chunk.error)) {
        setLines((prev) =>
          prev.concat({
            id: lineIdRef.current++,
            pod: meta.pod,
            container: meta.container,
            color: colorFor(meta.pod),
            text: `[stream: ${chunk.error}]`
          })
        )
      }
    })
    return unsub
  }, [])

  // The pods array identity changes on every watch commit, so this effect runs
  // often - disposal is handled ONLY by the unmount/reconnect teardown below,
  // otherwise in-flight stream starts would be killed on every list update.
  const disposedRef = useRef(false)
  // Generation token: a reconnect (nonce bump) advances it, so a logsStart that
  // was in flight across the reconnect resolves stale and stops itself instead
  // of registering a duplicate stream.
  const genRef = useRef(0)
  useEffect(() => {
    genRef.current = nonce
    const gen = nonce
    const want = new Map<string, { pod: string; container: string }>()
    let dropped = 0
    for (const p of pods) {
      const podName = p.metadata?.name ?? ''
      for (const c of podContainerNames(p)) {
        if (want.size >= MAX_STREAMS) {
          dropped++
          continue
        }
        want.set(`${podName}/${c}`, { pod: podName, container: c })
      }
    }
    setCapped(dropped)
    // detach vanished pods
    for (const [id, meta] of streamsRef.current) {
      const key = `${meta.pod}/${meta.container}`
      if (!want.has(key)) {
        api.logsStop(id)
        streamsRef.current.delete(id)
        attachedRef.current.delete(key)
      }
    }
    // attach new pods
    for (const [key, src] of want) {
      if (attachedRef.current.has(key)) continue
      attachedRef.current.add(key)
      api
        .logsStart(namespace, src.pod, { container: src.container, follow: true, tailLines: TAIL_PER_POD })
        .then((id) => {
          // stale (reconnect happened) or unmounted -> don't leave it running
          if (!id || disposedRef.current || gen !== genRef.current || !attachedRef.current.has(key)) {
            if (id) api.logsStop(id)
            return
          }
          streamsRef.current.set(id, { ...src, buf: '' })
        })
    }
  }, [namespace, pods, nonce])

  // Full teardown on unmount / reconnect.
  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      for (const id of streamsRef.current.keys()) api.logsStop(id)
      streamsRef.current.clear()
      attachedRef.current.clear()
    }
  }, [nonce])

  useLayoutEffect(() => {
    if (follow && viewRef.current) viewRef.current.scrollTop = viewRef.current.scrollHeight
  }, [lines, follow])

  const visible = useMemo(() => {
    const q = search.trim()
    if (!q) return lines
    let re: RegExp | null = null
    try {
      re = new RegExp(q, 'i')
    } catch {
      re = null
    }
    return lines.filter((l) => {
      const clean = `${l.pod} ${stripAnsi(l.text)}`
      return re ? re.test(clean) : clean.toLowerCase().includes(q.toLowerCase())
    })
  }, [lines, search])

  function saveToFile(): void {
    const body = visible.map((l) => `${l.pod}${showContainer ? `/${l.container}` : ''} | ${stripAnsi(l.text)}`).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([body], { type: 'text/plain' }))
    a.download = `workload-logs-${namespace}.log`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const attachedPods = new Set([...attachedRef.current].map((k) => k.split('/')[0]))
  return (
    <>
      <div className="panel-toolbar">
        <span className="wl-count" title={[...attachedPods].join(', ')}>
          {pods.length} pods{capped > 0 ? ` · streaming ${MAX_STREAMS}, ${capped} not shown` : ''}
        </span>
        <div className="input-wrap input-wrap--icon" style={{ width: 220 }}>
          <span className="input-wrap__icon">
            <Icon name="search" size={13} />
          </span>
          <input
            className="input"
            placeholder="Filter (pod name or regex)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {multiContainer && (
          <label className="checkbox">
            <input type="checkbox" checked={showContainer} onChange={(e) => setShowContainer(e.target.checked)} />
            Containers
          </label>
        )}
        <label className="checkbox">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
        </label>
        <div className="panel-toolbar__spacer" />
        <button className="btn btn--secondary" onClick={saveToFile} title="Save visible logs to a file">
          <Icon name="save" size={13} />
        </button>
        <button className="btn btn--secondary" onClick={() => setLines([])} title="Clear">
          Clear
        </button>
        <button
          className="btn btn--secondary"
          title="Reconnect all streams"
          onClick={() => {
            setLines([])
            setNonce((n) => n + 1)
          }}
        >
          <Icon name="refresh" size={13} />
        </button>
      </div>
      <div className="logs-view" ref={viewRef}>
        <pre className="logs-pre">
          {visible.length === 0 ? (
            pods.length === 0 ? (
              "No pods match this workload's selector."
            ) : (
              'Waiting for logs...'
            )
          ) : (
            visible.map((l) => (
              <React.Fragment key={l.id}>
                <span className="wl-prefix" style={{ color: l.color }}>
                  {l.pod}
                  {showContainer ? `/${l.container}` : ''}
                </span>
                {' '}
                <AnsiLine line={l.text} />
              </React.Fragment>
            ))
          )}
        </pre>
      </div>
    </>
  )
}
