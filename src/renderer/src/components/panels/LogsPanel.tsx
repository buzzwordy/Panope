import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api'
import { parseAnsi, stripAnsi } from '../../lib/ansi'
import { Icon } from '../Icon'

interface Props {
  namespace: string
  pod: string
  containers: string[]
}

const MAX_CHARS = 2_000_000

const TAIL_OPTIONS = [
  { label: 'Last 100', value: 100 },
  { label: 'Last 500', value: 500 },
  { label: 'Last 1000', value: 1000 },
  { label: 'Last 5000', value: 5000 },
  { label: 'All lines', value: 0 }
]
const SINCE_OPTIONS = [
  { label: 'All time', value: 0 },
  { label: 'Last 5m', value: 300 },
  { label: 'Last 15m', value: 900 },
  { label: 'Last 1h', value: 3600 },
  { label: 'Last 6h', value: 21600 },
  { label: 'Last 24h', value: 86400 }
]

/** Case-insensitive highlight of `q` (regex if it parses, else literal).
 *  Built from match indices, so user capture groups can't break segmentation. */
function highlightLine(line: string, q: string): React.ReactNode {
  if (!q) return line
  let re: RegExp
  try {
    re = new RegExp(q, 'gi')
  } catch {
    re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  }
  const out: React.ReactNode[] = []
  let last = 0
  for (const m of line.matchAll(re)) {
    const start = m.index ?? 0
    const text = m[0]
    if (!text) break // zero-length match - bail to avoid an infinite segmenting loop
    if (start > last) out.push(line.slice(last, start))
    out.push(
      <mark key={start} className="log-hl">
        {text}
      </mark>
    )
    last = start + text.length
  }
  if (!out.length) return line
  if (last < line.length) out.push(line.slice(last))
  return out
}

/** One log line with ANSI colors. Memoized - streamed appends re-render the
 *  list, but unchanged line strings skip re-parsing. */
export const AnsiLine = React.memo(function AnsiLine({ line }: { line: string }): React.ReactElement {
  const segs = parseAnsi(line)
  return (
    <>
      {segs.map((s, i) =>
        s.fg || s.bg || s.bold || s.dim || s.italic || s.underline ? (
          <span
            key={i}
            style={{
              color: s.fg,
              backgroundColor: s.bg,
              fontWeight: s.bold ? 600 : undefined,
              opacity: s.dim ? 0.7 : undefined,
              fontStyle: s.italic ? 'italic' : undefined,
              textDecoration: s.underline ? 'underline' : undefined
            }}
          >
            {s.text}
          </span>
        ) : (
          s.text
        )
      )}
      {'\n'}
    </>
  )
})

export function LogsPanel({ namespace, pod, containers }: Props): React.ReactElement {
  const [container, setContainer] = useState(containers[0] ?? '')
  const [follow, setFollow] = useState(true)
  const [timestamps, setTimestamps] = useState(false)
  const [previous, setPrevious] = useState(false)
  const [tailLines, setTailLines] = useState(1000)
  const [sinceSeconds, setSinceSeconds] = useState(0)
  const [search, setSearch] = useState('')
  const [filterMode, setFilterMode] = useState<'filter' | 'highlight'>('filter')
  const [text, setText] = useState('')
  const [ended, setEnded] = useState(false)
  const [nonce, setNonce] = useState(0)
  const viewRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let disposed = false
    let id = ''
    setText('')
    setEnded(false)
    const unsub = api.onLogData((chunk) => {
      if (chunk.id !== id) return
      if (chunk.data) setText((prev) => (prev + chunk.data).slice(-MAX_CHARS))
      if (chunk.error) setText((prev) => `${prev}\n[stream error] ${chunk.error}\n`)
      if (chunk.closed) setEnded(true)
    })
    api
      .logsStart(namespace, pod, {
        container,
        // A terminated previous container has no live stream to follow.
        follow: previous ? false : follow,
        tailLines,
        timestamps,
        previous,
        sinceSeconds: sinceSeconds || undefined
      })
      .then((newId) => {
        if (disposed) {
          if (newId) api.logsStop(newId)
          return
        }
        id = newId
      })
    return () => {
      disposed = true
      unsub()
      if (id) api.logsStop(id)
    }
  }, [namespace, pod, container, follow, timestamps, previous, tailLines, sinceSeconds, nonce])

  useLayoutEffect(() => {
    if (follow && viewRef.current) viewRef.current.scrollTop = viewRef.current.scrollHeight
  }, [text, follow])

  const hasAnsi = text.includes('\x1b')

  const lines = useMemo(() => {
    const q = search.trim()
    const all = text.split('\n')
    if (!q || filterMode === 'highlight') return all
    let re: RegExp | null = null
    try {
      re = new RegExp(q, 'i')
    } catch {
      re = null
    }
    // Match against clean text so color codes can't break a filter.
    return all.filter((l) => {
      const clean = hasAnsi ? stripAnsi(l) : l
      return re ? re.test(clean) : clean.toLowerCase().includes(q.toLowerCase())
    })
  }, [text, search, filterMode, hasAnsi])

  function saveToFile(): void {
    const body = lines.join('\n')
    const blob = new Blob([hasAnsi ? stripAnsi(body) : body], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${pod}${container ? `-${container}` : ''}${previous ? '-previous' : ''}.log`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const q = search.trim()
  return (
    <>
      <div className="panel-toolbar">
        {containers.length > 1 && (
          <select className="select" value={container} onChange={(e) => setContainer(e.target.value)}>
            {containers.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
        <select
          className="select"
          value={tailLines}
          onChange={(e) => setTailLines(Number(e.target.value))}
          title="How many lines to fetch"
        >
          {TAIL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          className="select"
          value={sinceSeconds}
          onChange={(e) => setSinceSeconds(Number(e.target.value))}
          title="Only logs newer than"
        >
          {SINCE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <div className="input-wrap input-wrap--icon" style={{ width: 200 }}>
          <span className="input-wrap__icon">
            <Icon name="search" size={13} />
          </span>
          <input
            className="input"
            placeholder="Filter (regex ok)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {q && (
          <button
            className="btn btn--secondary"
            onClick={() => setFilterMode((m) => (m === 'filter' ? 'highlight' : 'filter'))}
            title={filterMode === 'filter' ? 'Showing matching lines only' : 'Showing all lines, matches highlighted'}
          >
            {filterMode === 'filter' ? 'Matches' : 'Highlight'}
          </button>
        )}
        <label className="checkbox" title="Logs of the previous (crashed) container instance">
          <input type="checkbox" checked={previous} onChange={(e) => setPrevious(e.target.checked)} /> Previous
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={follow} disabled={previous} onChange={(e) => setFollow(e.target.checked)} />{' '}
          Follow
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} />
          Timestamps
        </label>
        <div className="panel-toolbar__spacer" />
        <button className="btn btn--secondary" onClick={saveToFile} title="Save visible logs to a file">
          <Icon name="save" size={13} />
        </button>
        <button className="btn btn--secondary" onClick={() => setText('')} title="Clear">
          Clear
        </button>
        <button className="btn btn--secondary" onClick={() => setNonce((n) => n + 1)} title="Reconnect">
          <Icon name="refresh" size={13} />
        </button>
      </div>
      <div className="logs-view" ref={viewRef}>
        <pre className="logs-pre">
          {!text ? (
            previous ? (
              'No previous container logs (the container may not have restarted).'
            ) : ended ? (
              'Stream ended - no log output. Try a wider time range or another container.'
            ) : (
              'Waiting for logs...'
            )
          ) : q ? (
            // Search view: highlight on clean text (colors would fragment matches).
            lines.map((l, i) => (
              <React.Fragment key={i}>
                {highlightLine(hasAnsi ? stripAnsi(l) : l, q)}
                {'\n'}
              </React.Fragment>
            ))
          ) : hasAnsi ? (
            lines.map((l, i) => <AnsiLine key={i} line={l} />)
          ) : (
            lines.join('\n')
          )}
        </pre>
      </div>
    </>
  )
}
