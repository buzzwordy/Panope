import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { PodFileEntry } from '@shared/types'
import { api } from '../../api'
import { Icon } from '../Icon'
import { useToast } from '../../state/toast'
import { parseLsOutput, joinPodPath, b64ToBytes } from '../../lib/podfiles'
import { formatMemory } from '../../lib/format'

/**
 * Pod file browser over non-interactive exec: `ls -la` to list, `base64` to
 * move file bytes safely through the text stream. Needs a shell + coreutils
 * in the container (busybox is fine); distroless images will simply error.
 */

const DOWNLOAD_CAP = 6 * 1024 * 1024 // base64 of this fits the 8MB exec cap
const UPLOAD_CAP = 2 * 1024 * 1024

interface Props {
  namespace: string
  pod: string
  containers: string[]
  readOnly?: boolean
}

export function FilesPanel({ namespace, pod, containers, readOnly = false }: Props): React.ReactElement {
  const toast = useToast()
  const [container, setContainer] = useState(containers[0] ?? '')
  const [path, setPath] = useState('/')
  const [entries, setEntries] = useState<PodFileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyFile, setBusyFile] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const list = useCallback(
    async (dir: string): Promise<void> => {
      setLoading(true)
      setError(null)
      try {
        const res = await api.podExecCapture(namespace, pod, container, ['sh', '-c', 'ls -la "$0"', dir])
        if (res.code !== 0 && !res.out.trim()) {
          setError(res.err.trim() || 'Could not list directory (no shell in this container?)')
          setEntries([])
        } else {
          setEntries(parseLsOutput(res.out))
          setPath(dir)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setEntries([])
      }
      setLoading(false)
    },
    [namespace, pod, container]
  )

  useEffect(() => {
    void list('/')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container])

  async function download(entry: PodFileEntry): Promise<void> {
    if (entry.size > DOWNLOAD_CAP) {
      toast.error(`File is ${formatMemory(entry.size)} - downloads are capped at ${formatMemory(DOWNLOAD_CAP)}.`)
      return
    }
    const full = joinPodPath(path, entry.name)
    setBusyFile(entry.name)
    try {
      const res = await api.podExecCapture(namespace, pod, container, ['sh', '-c', 'base64 "$0"', full])
      if (res.code !== 0 && !res.out.trim()) throw new Error(res.err.trim() || 'read failed')
      const bytes = b64ToBytes(res.out)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer]))
      a.download = entry.name
      a.click()
      URL.revokeObjectURL(a.href)
      toast.success(`Downloaded ${entry.name} (${formatMemory(bytes.length)})`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
    setBusyFile(null)
  }

  async function upload(file: File): Promise<void> {
    if (file.size > UPLOAD_CAP) {
      toast.error(`Uploads are capped at ${formatMemory(UPLOAD_CAP)}.`)
      return
    }
    setBusyFile(file.name)
    try {
      const buf = new Uint8Array(await file.arrayBuffer())
      let bin = ''
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
      const b64 = btoa(bin)
      const dest = joinPodPath(path, file.name)
      const res = await api.podWriteFile(namespace, pod, container, dest, b64)
      if (!res.ok) throw new Error(res.error ?? 'write failed')
      toast.success(`Uploaded ${file.name} -> ${dest}`)
      void list(path)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
    setBusyFile(null)
  }

  const crumbs = path.split('/').filter(Boolean)

  return (
    <div className="files-panel">
      <div className="panel-toolbar">
        {containers.length > 1 && (
          <select className="input" style={{ width: 180 }} value={container} onChange={(e) => setContainer(e.target.value)}>
            {containers.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
        <div className="files-crumbs">
          <button className="files-crumb" onClick={() => void list('/')}>/</button>
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              <button className="files-crumb" onClick={() => void list('/' + crumbs.slice(0, i + 1).join('/'))}>
                {c}
              </button>
              {i < crumbs.length - 1 && <span className="files-crumb__sep">/</span>}
            </React.Fragment>
          ))}
        </div>
        <div className="panel-toolbar__spacer" />
        <button className="btn btn--secondary" onClick={() => void list(path)} disabled={loading}>
          <Icon name="refresh" size={13} /> Refresh
        </button>
        <button
          className="btn btn--secondary"
          disabled={readOnly || !!busyFile}
          title={readOnly ? 'Read-only mode' : `Upload a small file into ${path}`}
          onClick={() => fileInput.current?.click()}
        >
          <Icon name="plus" size={13} /> Upload
        </button>
        <input
          ref={fileInput}
          type="file"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void upload(f)
            e.target.value = ''
          }}
        />
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading ? (
        <div className="state">
          <div className="spinner" />
          <div className="state__title">Listing {path}...</div>
        </div>
      ) : (
        <div className="table-region">
          <table className="table files-table">
            <thead>
              <tr>
                <th>Name</th>
                <th style={{ width: 110 }}>Size</th>
                <th style={{ width: 120 }}>Mode</th>
                <th style={{ width: 140 }}>Modified</th>
                <th style={{ width: 110 }} />
              </tr>
            </thead>
            <tbody>
              {path !== '/' && (
                <tr className="files-row files-row--dir" onClick={() => void list(joinPodPath(path, '..'))}>
                  <td colSpan={5}>
                    <Icon name="chevron-left" size={13} /> ..
                  </td>
                </tr>
              )}
              {entries.map((e) => {
                const isDir = e.type === 'd'
                const isLink = e.type === 'l'
                return (
                  <tr
                    key={e.name}
                    className={`files-row${isDir ? ' files-row--dir' : ''}`}
                    onClick={() => {
                      if (isDir) void list(joinPodPath(path, e.name))
                      else if (isLink && e.linkTo?.startsWith('/')) void list(e.linkTo)
                    }}
                  >
                    <td className="files-name">
                      <Icon name={isDir ? 'box' : isLink ? 'forward' : 'code'} size={13} />
                      {e.name}
                      {e.linkTo && <span className="files-link"> {'->'} {e.linkTo}</span>}
                    </td>
                    <td>{isDir ? '' : formatMemory(e.size)}</td>
                    <td>
                      <code className="files-mode">{e.mode}</code>
                    </td>
                    <td>{e.modified}</td>
                    <td>
                      {!isDir && !isLink && (
                        <button
                          className="btn btn--secondary btn--xs"
                          disabled={busyFile === e.name}
                          onClick={(ev) => {
                            ev.stopPropagation()
                            void download(e)
                          }}
                        >
                          <Icon name="save" size={12} /> {busyFile === e.name ? '...' : 'Download'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {entries.length === 0 && !error && (
                <tr>
                  <td colSpan={5} className="files-empty">Empty directory</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
