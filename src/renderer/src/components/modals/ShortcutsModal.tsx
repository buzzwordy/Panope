import React from 'react'
import { Icon } from '../Icon'

/** Keyboard reference. Kept in sync with the handlers in App.tsx and
 *  ResourceTable.tsx - if you add a binding, add it here. */
const GROUPS: Array<[string, Array<[string, string]>]> = [
  [
    'Navigation',
    [
      ['Ctrl / ⌘ + K', 'Command palette - jump to a resource or a live object'],
      ['/', 'Focus the list search'],
      ['j / ↓', 'Move down the list'],
      ['k / ↑', 'Move up the list'],
      ['Enter', 'Open the highlighted row'],
      ['Esc', 'Back out of a detail view, or blur the search box']
    ]
  ],
  [
    'Lists',
    [
      ['Click checkbox', 'Select a row for bulk actions'],
      ['Shift + click', 'Select a range'],
      ['Header checkbox', 'Select every filtered row']
    ]
  ],
  [
    'Application',
    [
      ['Ctrl / ⌘ + N', 'Create resource'],
      ['Ctrl / ⌘ + R', 'Refresh the current view'],
      ['Ctrl / ⌘ + 1 ... 6', 'Overview · Fleet · Pods · Right-sizing · Access · Audit'],
      ['Ctrl / ⌘ + Shift + L', 'Toggle theme'],
      ['Ctrl / ⌘ + ,', 'Preferences'],
      ['Ctrl / ⌘ + /', 'This shortcut list']
    ]
  ]
]

export function ShortcutsModal({ onClose }: { onClose: () => void }): React.ReactElement {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--sm" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <Icon name="terminal" size={16} />
          <span className="modal__title">Keyboard shortcuts</span>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose} title="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="modal__body">
          {GROUPS.map(([title, rows]) => (
            <section key={title} className="shortcuts">
              <h3 className="shortcuts__title">{title}</h3>
              <dl className="shortcuts__grid">
                {rows.map(([key, what]) => (
                  <React.Fragment key={key}>
                    <dt>
                      <kbd>{key}</kbd>
                    </dt>
                    <dd>{what}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <div className="modal__footer">
          <span className="spacer" />
          <button className="btn btn--secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
