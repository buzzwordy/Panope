import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { Icon } from '../Icon'
import { YamlEditor } from '../YamlEditor'
import { useToast } from '../../state/toast'
import { diffLines, diffStat } from '../../lib/lineDiff'

/**
 * Install a chart or upgrade a release, with the values in front of you.
 *
 * Install prefills the editor with `helm show values` (the chart's defaults);
 * upgrade prefills with the release's CURRENT user-supplied values and shows a
 * live diff against them, so what you're about to change is explicit before
 * anything hits the cluster.
 */

interface Props {
  mode: 'install' | 'upgrade'
  /** repo chart ref, e.g. "bitnami/redis" (install: required; upgrade: default from release) */
  chart?: string
  chartVersion?: string
  /** upgrade only */
  release?: string
  namespace?: string
  theme: 'dark' | 'light'
  onClose: () => void
  onDone: () => void
}

export function HelmDeployModal({
  mode,
  chart: initialChart,
  chartVersion,
  release,
  namespace,
  theme,
  onClose,
  onDone
}: Props): React.ReactElement {
  const toast = useToast()
  const isUpgrade = mode === 'upgrade'

  const [chart, setChart] = useState(initialChart ?? '')
  const [version, setVersion] = useState(chartVersion ?? '')
  const [name, setName] = useState(release ?? suggestedName(initialChart))
  const [ns, setNs] = useState(namespace ?? 'default')
  const [namespaces, setNamespaces] = useState<string[]>([])
  useEffect(() => {
    api.getNamespaces().then(setNamespaces).catch(() => undefined)
  }, [])
  const [values, setValues] = useState('')
  const [baseValues, setBaseValues] = useState('')
  const [loadingValues, setLoadingValues] = useState(true)
  const [showDiff, setShowDiff] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    setLoadingValues(true)
    const load = isUpgrade
      ? api.helmGet(release ?? '', namespace ?? '', 'values')
      : initialChart
        ? api.helmShowValues(initialChart, chartVersion)
        : Promise.resolve('')
    load
      .then((v) => {
        if (disposed) return
        const text = v.startsWith('USER-SUPPLIED VALUES:') ? v.replace(/^USER-SUPPLIED VALUES:\n?/, '') : v
        const clean = text.trim() === 'null' ? '' : text
        setValues(clean)
        setBaseValues(clean)
      })
      .catch(() => undefined)
      .finally(() => !disposed && setLoadingValues(false))
    return () => {
      disposed = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const diffRows = useMemo(() => diffLines(baseValues, values), [baseValues, values])
  const stat = diffStat(diffRows)
  const dirty = stat.added > 0 || stat.removed > 0

  async function run(): Promise<void> {
    setBusy(true)
    setError(null)
    const spec = {
      release: name.trim(),
      chart: chart.trim(),
      namespace: ns.trim(),
      values: values.trim() ? values : undefined,
      version: version.trim() || undefined
    }
    const res = isUpgrade ? await api.helmUpgrade(spec) : await api.helmInstall(spec)
    setBusy(false)
    if (res.ok) {
      toast.success(`${isUpgrade ? 'Upgraded' : 'Installed'} ${spec.release} in ${spec.namespace}`)
      onDone()
      onClose()
    } else {
      setError(res.error ?? `${isUpgrade ? 'Upgrade' : 'Install'} failed`)
    }
  }

  const valid = !!chart.trim() && !!name.trim() && !!ns.trim()

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--lg helm-deploy" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <Icon name="chart" size={16} />
          <span className="modal__title">
            {isUpgrade ? `Upgrade ${release}` : 'Install chart'}
          </span>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose} title="Close">
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="modal__body helm-deploy__body">
          <div className="helm-deploy__form">
            <label className="field">
              <span className="field__label">Chart</span>
              <input
                className="input"
                placeholder="repo/chart"
                value={chart}
                onChange={(e) => setChart(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field__label">Version</span>
              <input className="input" placeholder="latest" value={version} onChange={(e) => setVersion(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">Release name</span>
              <input className="input" value={name} disabled={isUpgrade} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">Namespace</span>
              {isUpgrade ? (
                <input className="input" value={ns} disabled />
              ) : (
                <>
                  <input className="input" list="helm-ns-list" value={ns} onChange={(e) => setNs(e.target.value)} />
                  <datalist id="helm-ns-list">
                    {namespaces.map((n) => (
                      <option key={n} value={n} />
                    ))}
                  </datalist>
                </>
              )}
            </label>
          </div>

          <div className="panel-toolbar" style={{ marginTop: 'var(--space-5)' }}>
            <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-sm)' }}>
              {isUpgrade ? 'Current user-supplied values - edit and upgrade' : 'Chart default values - trim to what you override'}
            </span>
            {dirty && (
              <span className="diff-stat">
                <span className="diff-stat__add">+{stat.added}</span>
                <span className="diff-stat__del">-{stat.removed}</span>
              </span>
            )}
            <div className="panel-toolbar__spacer" />
            {isUpgrade && (
              <button
                className={`btn btn--secondary${showDiff ? ' is-active' : ''}`}
                disabled={!dirty}
                onClick={() => setShowDiff((d) => !d)}
                title={dirty ? 'Diff against the running values' : 'No changes yet'}
              >
                <Icon name="git-branch" size={13} /> Diff
              </button>
            )}
          </div>

          <div className="helm-deploy__editor">
            {loadingValues ? (
              <div className="state">
                <div className="spinner" />
                <div className="state__title">Loading values...</div>
              </div>
            ) : showDiff && dirty ? (
              <div className="yaml-diff">
                {diffRows.map((r, idx) => (
                  <div key={idx} className={`yaml-diff__row yaml-diff__row--${r.kind}`}>
                    <span className="yaml-diff__gutter">{r.oldNo ?? ''}</span>
                    <span className="yaml-diff__gutter">{r.newNo ?? ''}</span>
                    <span className="yaml-diff__sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '}</span>
                    <span className="yaml-diff__text">{r.text || ' '}</span>
                  </div>
                ))}
              </div>
            ) : (
              <YamlEditor value={values} onChange={setValues} theme={theme} />
            )}
          </div>

          {error && <div className="editor-status is-error">{error}</div>}
        </div>

        <div className="modal__footer">
          <span className="confirm-text">
            {isUpgrade
              ? 'helm upgrade - a new revision you can roll back from History.'
              : 'helm install --create-namespace'}
          </span>
          <span className="spacer" />
          <button className="btn btn--secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={run} disabled={!valid || busy || loadingValues}>
            <Icon name="save" size={13} /> {busy ? (isUpgrade ? 'Upgrading...' : 'Installing...') : isUpgrade ? 'Upgrade' : 'Install'}
          </button>
        </div>
      </div>
    </div>
  )
}

function suggestedName(chart?: string): string {
  if (!chart) return ''
  const last = chart.split('/').pop() ?? chart
  return last.toLowerCase().replace(/[^a-z0-9-]/g, '-')
}
