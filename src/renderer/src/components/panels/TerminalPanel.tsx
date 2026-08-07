import React, { useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { api } from '../../api'
import { Icon } from '../Icon'

interface Props {
  namespace: string
  pod: string
  containers: string[]
  /** Run this instead of a shell (e.g. nsenter for node shells). Hides the shell picker. */
  command?: string[]
  /** Pre-select a container (e.g. an ephemeral debug container). */
  initialContainer?: string
}

const SHELLS = ['/bin/sh', '/bin/bash', '/bin/ash', 'sh']

export function TerminalPanel({ namespace, pod, containers, command, initialContainer }: Props): React.ReactElement {
  const [container, setContainer] = useState(initialContainer ?? containers[0] ?? '')
  const [shell, setShell] = useState('/bin/sh')
  const [nonce, setNonce] = useState(0)
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const idRef = useRef('')

  // create the xterm instance once
  useEffect(() => {
    if (!hostRef.current) return
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace',
      fontSize: 12,
      cursorBlink: true,
      theme: { background: '#0b0c0e', foreground: '#cdd3db', cursor: '#22c55e' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    try {
      fit.fit()
    } catch {
      /* ignore */
    }
    termRef.current = term
    fitRef.current = fit

    const onData = term.onData((d) => {
      if (idRef.current) api.execInput(idRef.current, d)
    })
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        if (idRef.current) api.execResize(idRef.current, term.cols, term.rows)
      } catch {
        /* ignore */
      }
    })
    ro.observe(hostRef.current)

    return () => {
      onData.dispose()
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  // (re)connect the exec session
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    let disposed = false
    let id = ''
    term.reset()
    term.write(`\x1b[90mconnecting to ${container} using ${command ? command.join(' ') : shell} ...\x1b[0m\r\n`)

    const unsub = api.onExecData((chunk) => {
      if (chunk.id !== id) return
      if (chunk.data) term.write(chunk.data)
      if (chunk.error) term.write(`\r\n\x1b[31m${chunk.error}\x1b[0m\r\n`)
      if (chunk.closed) term.write(`\r\n\x1b[90m[session ended]\x1b[0m\r\n`)
    })

    api.execStart(namespace, pod, container, command ?? [shell]).then((newId) => {
      if (disposed) {
        if (newId) api.execStop(newId)
        return
      }
      id = newId
      idRef.current = newId
      try {
        fitRef.current?.fit()
        api.execResize(newId, term.cols, term.rows)
      } catch {
        /* ignore */
      }
      term.focus()
    })

    return () => {
      disposed = true
      unsub()
      if (id) api.execStop(id)
      idRef.current = ''
    }
  }, [namespace, pod, container, shell, nonce])

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
        {!command && (
          <select className="select" value={shell} onChange={(e) => setShell(e.target.value)}>
            {SHELLS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
        <div className="panel-toolbar__spacer" />
        <button className="btn btn--secondary" onClick={() => setNonce((n) => n + 1)} title="Reconnect">
          <Icon name="refresh" size={13} /> Reconnect
        </button>
      </div>
      <div className="terminal-host" ref={hostRef} />
    </>
  )
}
