import React, { useEffect, useRef, useState } from 'react'
import type { ClusterInfo, KubeContextInfo } from '@shared/types'
import { Icon } from './Icon'

export type MenuKind =
  | 'contexts'
  | 'namespaces'
  | 'repositories'
  | 'preferences'
  | 'portforwards'
  | 'shortcuts'
  | 'about'

interface Props {
  clusterInfo?: ClusterInfo
  contexts: KubeContextInfo[]
  namespace: string
  namespaces: string[]
  theme: 'dark' | 'light'
  canBack: boolean
  canForward: boolean
  labelFilter: string
  pfCount: number
  onBack: () => void
  onForward: () => void
  onContextChange: (name: string) => void
  onNamespaceChange: (ns: string) => void
  onLabelFilter: (v: string) => void
  onToggleTheme: () => void
  onNewNamespace: () => void
  onOpenPortForwards: () => void
  onMenu: (kind: MenuKind) => void
}

export function TopBar({
  clusterInfo,
  contexts,
  namespace,
  namespaces,
  theme,
  canBack,
  canForward,
  labelFilter,
  pfCount,
  onBack,
  onForward,
  onContextChange,
  onNamespaceChange,
  onLabelFilter,
  onToggleTheme,
  onNewNamespace,
  onOpenPortForwards,
  onMenu
}: Props): React.ReactElement {
  const current = clusterInfo?.context ?? ''
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  const pick = (kind: MenuKind): void => {
    setMenuOpen(false)
    onMenu(kind)
  }
  const MENU: Array<[MenuKind, string, string]> = [
    ['contexts', 'layers', 'Contexts'],
    ['namespaces', 'box', 'Namespaces'],
    ['repositories', 'release', 'Repositories'],
    ['preferences', 'sliders', 'Preferences'],
    ['shortcuts', 'terminal', 'Keyboard shortcuts'],
    ['about', 'cube', 'About Panope'],
    ['portforwards', 'forward', 'Port forwards']
  ]

  return (
    <header className="topbar">
      <button className="icon-btn" onClick={onBack} disabled={!canBack} title="Back">
        <Icon name="chevron-left" size={18} />
      </button>
      <button className="icon-btn" onClick={onForward} disabled={!canForward} title="Forward">
        <Icon name="chevron-right" size={18} />
      </button>

      <div className="breadcrumb">
        <span className="breadcrumb__diamond">
          <Icon name="diamond" size={11} />
        </span>
        <select
          className="select"
          value={current}
          onChange={(e) => onContextChange(e.target.value)}
          title="Kubernetes context"
        >
          {contexts.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
          {contexts.length === 0 && current && <option value={current}>{current}</option>}
        </select>
        <span className="breadcrumb__sep">/</span>
        <select
          className="select"
          value={namespace}
          onChange={(e) => onNamespaceChange(e.target.value)}
          title="Namespace"
        >
          <option value="All">All</option>
          {namespaces.map((ns) => (
            <option key={ns} value={ns}>
              {ns}
            </option>
          ))}
        </select>
        <button className="icon-btn" title="New namespace" onClick={onNewNamespace}>
          <Icon name="plus" size={15} />
        </button>
      </div>

      <div className="topbar__spacer" />

      <button className="pf-badge" onClick={onOpenPortForwards} title="Port forwards">
        <Icon name="forward" size={13} />
        Forwards
        {pfCount > 0 && <span className="pf-badge__count">{pfCount}</span>}
      </button>

      <div className="input-wrap input-wrap--icon" style={{ width: 220 }}>
        <span className="input-wrap__icon">
          <Icon name="filter" size={13} />
        </span>
        <input
          className="input"
          placeholder="Filter by labels"
          value={labelFilter}
          onChange={(e) => onLabelFilter(e.target.value)}
        />
      </div>

      <button className="icon-btn" onClick={onToggleTheme} title="Toggle theme">
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
      </button>

      <div className="account-wrap" ref={menuRef}>
        <button
          className="account-btn"
          onClick={() => setMenuOpen((o) => !o)}
          title={clusterInfo?.version ? `Kubernetes ${clusterInfo.version}` : 'Menu'}
        >
          <span className="account">K</span>
          <Icon name="chevron-down" size={13} />
        </button>
        {menuOpen && (
          <div className="account-menu">
            {MENU.map(([kind, icon, label]) => (
              <button key={kind} className="account-menu__item" onClick={() => pick(kind)}>
                <Icon name={icon} size={14} />
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </header>
  )
}
