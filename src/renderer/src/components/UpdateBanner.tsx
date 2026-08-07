import React from 'react'
import type { UpdateCheck } from '@shared/types'
import { api } from '../api'
import { Icon } from './Icon'

interface Props {
  update: UpdateCheck
  onSkip: () => void
  onDismiss: () => void
}

/**
 * Panope never downloads or installs anything by itself - packages are unsigned
 * and half the targets (deb, rpm) have no updater path at all. This just says a
 * release exists and opens the download page.
 */
export function UpdateBanner({ update, onSkip, onDismiss }: Props): React.ReactElement {
  return (
    <div className="update-banner">
      <Icon name="download" size={15} />
      <span>
        Panope <strong>{update.latest}</strong> is available - you have {update.current}.
      </span>
      <span className="spacer" />
      <button
        className="btn btn--primary btn--xs"
        onClick={() => void api.openExternal(update.url ?? 'https://github.com/buzzwordy/Panope/releases/latest')}
      >
        Download
      </button>
      <button className="btn btn--secondary btn--xs" onClick={onSkip} title="Don't mention this version again">
        Skip
      </button>
      <button className="icon-btn" onClick={onDismiss} title="Dismiss until next launch">
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}
