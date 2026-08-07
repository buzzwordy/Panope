import React, { useState } from 'react'
import { Icon } from './Icon'
import { isDesktop } from '../api'
import { reloadAll } from '../state/reload'

/** Reloads whatever view is on screen (see state/reload). Turns once per click. */
export function RefreshButton(): React.ReactElement {
  const [spinning, setSpinning] = useState(false)
  return (
    <button
      className={`btn btn--secondary refresh-btn${spinning ? ' is-spinning' : ''}`}
      data-safe
      title={isDesktop ? 'Reload this view (Ctrl/Cmd+R)' : 'Reload this view'}
      onClick={() => {
        reloadAll()
        setSpinning(true)
      }}
      onAnimationEnd={() => setSpinning(false)}
    >
      <Icon name="refresh" size={13} /> Refresh
    </button>
  )
}
