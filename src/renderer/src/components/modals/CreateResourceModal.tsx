import React, { useMemo, useState } from 'react'
import { api } from '../../api'
import { YamlEditor } from '../YamlEditor'
import { Icon } from '../Icon'
import { ConfirmModal } from './ConfirmModal'
import {
  allTemplates,
  deleteUserTemplate,
  fillTemplate,
  templateVars,
  type Template
} from '../../lib/templates'

interface Props {
  theme: 'dark' | 'light'
  /** Kind of the resource list the user is looking at - its templates sort first. */
  contextKind?: string
  initialTemplate?: string
  onClose: () => void
  onApplied: () => void
}

export function CreateResourceModal({
  theme,
  contextKind,
  initialTemplate,
  onClose,
  onApplied
}: Props): React.ReactElement {
  const [refresh, setRefresh] = useState(0)
  const templates = useMemo(() => {
    const all = allTemplates()
    if (!contextKind) return all
    // Templates for the kind currently in view first.
    return [...all.filter((t) => t.kind === contextKind), ...all.filter((t) => t.kind !== contextKind)]
  }, [contextKind, refresh])

  const initial = useMemo(
    () =>
      templates.find((t) => t.name === initialTemplate) ??
      (contextKind ? templates.find((t) => t.kind === contextKind) : undefined) ??
      templates[0],
    [templates, initialTemplate, contextKind]
  )

  const [selected, setSelected] = useState<Template | undefined>(initial)
  // Variable prompt step: shown when the chosen template has {{vars}}.
  const [pendingVars, setPendingVars] = useState<string[]>(() => (initial ? templateVars(initial.yaml) : []))
  const [varValues, setVarValues] = useState<Record<string, string>>({})
  const [text, setText] = useState(() => (initial && templateVars(initial.yaml).length === 0 ? initial.yaml : ''))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [conflict, setConflict] = useState<string | undefined>()

  const editing = pendingVars.length === 0

  function pickTemplate(name: string): void {
    const t = templates.find((x) => x.name === name)
    if (!t) return
    setSelected(t)
    setError(undefined)
    setConflict(undefined)
    const vars = templateVars(t.yaml)
    setPendingVars(vars)
    setVarValues({})
    setText(vars.length === 0 ? t.yaml : '')
  }

  const allFilled = pendingVars.every((v) => (varValues[v] ?? '').trim() !== '')

  function fillVars(): void {
    if (!selected || !allFilled) return
    setText(fillTemplate(selected.yaml, varValues))
    setPendingVars([])
  }

  async function apply(force = false): Promise<void> {
    setBusy(true)
    setError(undefined)
    setConflict(undefined)
    const dry = await api.applyYaml(text, { dryRun: true, force })
    if (!dry.ok) {
      setBusy(false)
      if (!force && /conflict/i.test(dry.error ?? '')) setConflict(dry.error)
      else setError(dry.error ?? 'Validation failed')
      return
    }
    const res = await api.applyYaml(text, { force })
    setBusy(false)
    if (res.ok) {
      onApplied()
      onClose()
    } else if (!force && /conflict/i.test(res.error ?? '')) {
      setConflict(res.error)
    } else {
      setError(res.error ?? 'Apply failed')
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--lg" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <Icon name="plus" size={18} />
          <span className="modal__title">Create resource</span>
          <select
            className="select"
            style={{ marginLeft: 'auto' }}
            value={selected?.name ?? ''}
            onChange={(e) => pickTemplate(e.target.value)}
          >
            {templates.map((t) => (
              <option key={t.name} value={t.name}>
                {t.builtin ? `${t.name} (built-in)` : t.name}
              </option>
            ))}
          </select>
          {selected && !selected.builtin && (
            <button
              className="icon-btn icon-btn--danger"
              title="Delete this template"
              onClick={() => {
                deleteUserTemplate(selected.name)
                setRefresh((n) => n + 1)
                const rest = allTemplates()
                const next =
                  rest.find((t) => t.kind === (contextKind ?? selected.kind)) ?? rest[0]
                setSelected(next)
                if (next) {
                  const vars = templateVars(next.yaml)
                  setPendingVars(vars)
                  setVarValues({})
                  setText(vars.length === 0 ? next.yaml : '')
                }
              }}
            >
              <Icon name="trash" size={14} />
            </button>
          )}
          <button className="icon-btn" onClick={onClose} title="Close">
            <Icon name="close" size={16} />
          </button>
        </div>

        {!editing ? (
          <div className="modal__body">
            <p style={{ marginTop: 0, color: 'var(--color-text-secondary)' }}>
              This template has variables - fill them in:
            </p>
            <div className="var-form">
              {pendingVars.map((v) => (
                <label key={v} className="var-form__row">
                  <span className="var-form__name">{v}</span>
                  <input
                    className="input"
                    value={varValues[v] ?? ''}
                    placeholder={v}
                    autoFocus={v === pendingVars[0]}
                    onChange={(e) => setVarValues((prev) => ({ ...prev, [v]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') fillVars()
                    }}
                  />
                </label>
              ))}
            </div>
          </div>
        ) : (
          <div className="modal__body modal__body--flush">
            <YamlEditor value={text} onChange={setText} theme={theme} />
          </div>
        )}

        {error && <div className="editor-status is-error">{error}</div>}
        {conflict && (
          <ConfirmModal
            title="Field ownership conflict"
            danger
            confirmLabel="Force apply"
            body={
              <>
                <p>Another manager owns some of the fields you are changing:</p>
                <pre className="conflict-pre">{conflict}</pre>
                <p>
                  Forcing takes ownership of those fields. If they are managed by a GitOps controller
                  (ArgoCD, Flux), it will likely revert your change on its next sync.
                </p>
              </>
            }
            onConfirm={() => {
              setConflict(undefined)
              apply(true)
            }}
            onCancel={() => setConflict(undefined)}
          />
        )}

        <div className="modal__footer">
          <span className="confirm-text">
            {editing
              ? 'Validated with a server dry-run before applying (field manager: panope).'
              : 'Values replace {{variables}} in the template.'}
          </span>
          <span className="spacer" />
          <button className="btn btn--secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {editing ? (
            <button className="btn btn--primary" onClick={() => apply(false)} disabled={busy || !text.trim()}>
              {busy ? 'Applying...' : 'Apply'}
            </button>
          ) : (
            <button className="btn btn--primary" onClick={fillVars} disabled={!allFilled}>
              Continue
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
