import React, { useEffect, useState } from 'react'
import type { CategoryGroup } from '@shared/catalog'
import type { CrdSection } from '../hooks/useCatalog'
import { Icon } from './Icon'

export interface FavItem {
  key: string
  label: string
  icon: string
}

interface Props {
  groups: CategoryGroup[]
  crdSections: CrdSection[]
  favorites: FavItem[]
  activeKey: string
  counts: Record<string, number | undefined>
  onSelect: (key: string) => void
  onUnfavorite: (key: string) => void
}

export function Sidebar({
  groups,
  crdSections,
  favorites,
  activeKey,
  counts,
  onSelect,
  onUnfavorite
}: Props): React.ReactElement {
  const [open, setOpen] = useState<Set<string>>(new Set())

  // auto-expand the CRD group that contains the active resource
  useEffect(() => {
    for (const section of crdSections) {
      const g = section.groups.find((grp) => grp.items.some((i) => i.key === activeKey))
      if (g && !open.has(g.name)) {
        setOpen((prev) => new Set(prev).add(g.name))
        break
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, crdSections])

  function toggle(name: string): void {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  return (
    <aside className="sidebar">
      <button className="sidebar__logo" onClick={() => onSelect('overview')} title="Cluster Overview">
        <span className="sidebar__logo-mark">
          <Icon name="cube" size={20} />
        </span>
        <span className="sidebar__logo-text">Panope</span>
      </button>
      <div className="sidebar__scroll">
        {/* cross-cluster views, above the per-cluster resource groups */}
        <div className="nav-section" key="__global">
          <div className="nav-section__label">Cluster</div>
          <button
            className={`nav-item${activeKey === 'overview' ? ' is-active' : ''}`}
            onClick={() => onSelect('overview')}
            title="This cluster's dashboard"
          >
            <span className="nav-item__icon">
              <Icon name="chart" size={15} />
            </span>
            <span className="nav-item__label">Cluster Overview</span>
          </button>
          <button
            className={`nav-item${activeKey === 'fleet' ? ' is-active' : ''}`}
            onClick={() => onSelect('fleet')}
            title="Every kubeconfig context at once"
          >
            <span className="nav-item__icon">
              <Icon name="layers" size={15} />
            </span>
            <span className="nav-item__label">Fleet</span>
          </button>
          <button
            className={`nav-item${activeKey === 'rightsizing' ? ' is-active' : ''}`}
            onClick={() => onSelect('rightsizing')}
            title="Container usage vs requests: waste, risk, missing limits"
          >
            <span className="nav-item__icon">
              <Icon name="scale" size={15} />
            </span>
            <span className="nav-item__label">Right-sizing</span>
          </button>
          <button
            className={`nav-item${activeKey === 'access' ? ' is-active' : ''}`}
            onClick={() => onSelect('access')}
            title="What can I (or a teammate) actually do here?"
          >
            <span className="nav-item__icon">
              <Icon name="lock" size={15} />
            </span>
            <span className="nav-item__label">Access</span>
          </button>
          <button
            className={`nav-item${activeKey === 'audit' ? ' is-active' : ''}`}
            onClick={() => onSelect('audit')}
            title="Every mutation performed through Panope"
          >
            <span className="nav-item__icon">
              <Icon name="list" size={15} />
            </span>
            <span className="nav-item__label">Audit</span>
          </button>
        </div>
        {favorites.length > 0 && (
          <div className="nav-section" key="__favorites">
            <div className="nav-section__label">Favorites</div>
            {favorites.map((item) => {
              const count = counts[item.key]
              return (
                <div
                  key={item.key}
                  className={`nav-item nav-fav${item.key === activeKey ? ' is-active' : ''}`}
                >
                  <button className="nav-fav__main" onClick={() => onSelect(item.key)} title={item.label}>
                    <span className="nav-item__icon">
                      <Icon name={item.icon} size={15} />
                    </span>
                    <span className="nav-item__label">{item.label}</span>
                  </button>
                  {count !== undefined && count > 0 && <span className="nav-item__count">{count}</span>}
                  <button
                    className="nav-fav__pin"
                    title="Remove from favorites"
                    onClick={(e) => {
                      e.stopPropagation()
                      onUnfavorite(item.key)
                    }}
                  >
                    <Icon name="star" size={13} filled />
                  </button>
                </div>
              )
            })}
          </div>
        )}
        {groups.map((group) => (
          <div className="nav-section" key={group.name}>
            <div className="nav-section__label">{group.name}</div>
            {group.items.map((item) => {
              const count = counts[item.key]
              return (
                <button
                  key={item.key}
                  className={`nav-item${item.key === activeKey ? ' is-active' : ''}`}
                  onClick={() => onSelect(item.key)}
                  title={item.label}
                >
                  <span className="nav-item__icon">
                    <Icon name={item.icon} size={15} />
                  </span>
                  <span className="nav-item__label">{item.label}</span>
                  {count !== undefined && count > 0 && <span className="nav-item__count">{count}</span>}
                </button>
              )
            })}
          </div>
        ))}

        {crdSections.map((section) => (
          <div className="nav-section" key={section.name}>
            <div className="nav-section__label">{section.name}</div>
            {section.groups.map((group) => {
              const isOpen = open.has(group.name)
              return (
                <div className={`nav-group${isOpen ? ' is-open' : ''}`} key={group.name}>
                  <button className="nav-group__header" onClick={() => toggle(group.name)} title={group.name}>
                    <span className="nav-group__chevron">
                      <Icon name="chevron-right" size={13} />
                    </span>
                    <span className="nav-item__label">{group.name}</span>
                    <span className="nav-item__count">{group.items.length}</span>
                  </button>
                  {isOpen &&
                    group.items.map((item) => (
                      <button
                        key={item.key}
                        className={`nav-item nav-item--nested${item.key === activeKey ? ' is-active' : ''}`}
                        onClick={() => onSelect(item.key)}
                        title={`${item.kind} · ${group.name}`}
                      >
                        <span className="nav-item__icon">
                          <Icon name={item.icon} size={14} />
                        </span>
                        <span className="nav-item__label">{item.label}</span>
                      </button>
                    ))}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </aside>
  )
}
