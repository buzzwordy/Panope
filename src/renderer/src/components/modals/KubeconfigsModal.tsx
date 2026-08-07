import React, { useCallback, useEffect, useState } from 'react'
import type { KubeconfigFile } from '@shared/types'
import { api } from '../../api'
import { Icon } from '../Icon'
import { useToast } from '../../state/toast'

/**
 * Manage the kubeconfig files that feed the context list.
 *
 * Several files are merged into one view the way kubectl does it: the first
 * file to define a name wins. That rule is invisible until it bites, so a file
 * whose contexts were shadowed says so explicitly rather than appearing to
 * contribute nothing.
 */
export function KubeconfigsModal({ onClose }: { onClose: () => void }): React.ReactElement {
  const toast = useToast()
  const [files, setFiles] = useState<KubeconfigFile[] | null>(null)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    api
      .listKubeconfigs()
      .then(setFiles)
      .catch(() => setFiles([]))
  }, [])
  useEffect(load, [load])

  async function add(p: string): Promise<void> {
    const file = p.trim()
    if (!file) return
    setBusy(true)
    const res = await api.addKubeconfig(file)
    setBusy(false)
    if (res.ok) {
      setPath('')
      load()
      toast.success('Kubeconfig added')
    } else {
      toast.error(res.error ?? 'Could not add that file')
    }
  }

  async function browse(): Promise<void> {
    const picked = await api.browseForKubeconfig()
    if (picked) await add(picked)
  }

  async function remove(p: string): Promise<void> {
    setBusy(true)
    const res = await api.removeKubeconfig(p)
    setBusy(false)
    if (res.ok) {
      load()
      toast.info('Kubeconfig removed')
    } else toast.error(res.error ?? 'Could not remove that file')
  }

  const total = (files ?? []).reduce((n, f) => n + f.contexts.length, 0)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--lg kubeconfigs" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <Icon name="layers" size={16} />
          <span className="modal__title">Kubeconfigs</span>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose} title="Close">
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="modal__body">
          <p className="kc-intro">
            Every file below is merged into one context list. Where two files define the same name,
            the one higher in this list wins - the same rule <code>kubectl</code> applies to
            <code> $KUBECONFIG</code>.
          </p>

          <div className="kc-add">
            <input
              className="input"
              placeholder="/path/to/kubeconfig"
              value={path}
              disabled={busy}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add(path)}
            />
            <button className="btn btn--secondary" onClick={browse} disabled={busy}>
              <Icon name="box" size={13} /> Browse...
            </button>
            <button className="btn btn--primary" onClick={() => add(path)} disabled={busy || !path.trim()}>
              <Icon name="plus" size={13} /> Add
            </button>
          </div>

          {files === null ? (
            <div className="state">
              <div className="spinner" />
              <div className="state__title">Reading kubeconfigs...</div>
            </div>
          ) : (
            <div className="kc-list">
              {files.map((f) => (
                <div key={f.path} className={`kc-file${f.ok ? '' : ' is-bad'}`}>
                  <div className="kc-file__top">
                    <Icon name={f.ok ? 'check' : 'close'} size={14} />
                    <code className="kc-file__path" title={f.path}>{f.path}</code>
                    {f.isDefault && <span className="kc-tag">default</span>}
                    {!f.isDefault && (
                      <button
                        className="icon-btn kc-file__rm"
                        title="Remove from the list (the file itself is untouched)"
                        disabled={busy}
                        onClick={() => remove(f.path)}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    )}
                  </div>

                  {f.error ? (
                    <div className="kc-file__err">{f.error}</div>
                  ) : (
                    <div className="kc-file__ctx">
                      {f.contexts.length ? (
                        f.contexts.map((c) => (
                          <span key={c} className="kc-ctx">
                            {c}
                          </span>
                        ))
                      ) : (
                        <span className="kc-none">no contexts contributed</span>
                      )}
                    </div>
                  )}

                  {f.shadowed.length > 0 && (
                    <div className="kc-file__shadow">
                      Shadowed by an earlier file: {f.shadowed.join(', ')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modal__footer">
          <span className="confirm-text">
            {files === null ? '' : `${files.length} file${files.length === 1 ? '' : 's'}, ${total} context${total === 1 ? '' : 's'}`}
          </span>
          <span className="spacer" />
          <button className="btn btn--secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
