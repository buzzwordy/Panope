import { Menu, shell, app, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { IPC } from '../shared/ipc'

/**
 * Panope's application menu.
 *
 * Menu items that need UI don't do the work here - they push an action name to
 * the renderer, which owns every dialog and view. That keeps one implementation
 * of "open Preferences" rather than a native and a web copy, and means the
 * in-cluster web build (which has no native menu) reaches the same screens from
 * the in-app account menu.
 */
export function buildAppMenu(getWindow: () => BrowserWindow | undefined): void {
  const send = (action: string) => (): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.menuAction, action)
  }
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { label: 'About Panope', click: send('about') },
              { type: 'separator' },
              { label: 'Preferences...', accelerator: 'Cmd+,', click: send('preferences') },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: '&File',
      submenu: [
        { label: 'Create resource...', accelerator: 'CmdOrCtrl+N', click: send('create') },
        { type: 'separator' },
        { label: 'Export list to CSV', click: send('export-csv') },
        { type: 'separator' },
        ...(isMac ? [] : ([{ label: 'Preferences...', accelerator: 'Ctrl+,', click: send('preferences') }] as MenuItemConstructorOptions[])),
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find in list', accelerator: 'CmdOrCtrl+F', click: send('search') },
        { label: 'Command palette', accelerator: 'CmdOrCtrl+K', click: send('palette') }
      ]
    },
    {
      label: '&View',
      submenu: [
        { label: 'Cluster Overview', accelerator: 'CmdOrCtrl+1', click: send('view:overview') },
        { label: 'Fleet (all contexts)', accelerator: 'CmdOrCtrl+2', click: send('view:fleet') },
        { label: 'Pods', accelerator: 'CmdOrCtrl+3', click: send('view:pods') },
        { label: 'Right-sizing', accelerator: 'CmdOrCtrl+4', click: send('view:rightsizing') },
        { label: 'Access (can I?)', accelerator: 'CmdOrCtrl+5', click: send('view:access') },
        { label: 'Audit log', accelerator: 'CmdOrCtrl+6', click: send('view:audit') },
        { type: 'separator' },
        { label: 'Assistant', accelerator: 'CmdOrCtrl+Shift+A', click: send('assistant') },
        { type: 'separator' },
        { label: 'Toggle theme', accelerator: 'CmdOrCtrl+Shift+L', click: send('toggle-theme') },
        { label: 'Toggle row density', click: send('toggle-density') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: '&Cluster',
      submenu: [
        { label: 'Switch context...', click: send('menu:contexts') },
        { label: 'Kubeconfigs...', click: send('menu:kubeconfigs') },
        { label: 'Namespaces...', click: send('menu:namespaces') },
        { type: 'separator' },
        { label: 'Helm repositories...', click: send('menu:repositories') },
        { label: 'Port forwards...', click: send('menu:portforwards') },
        { type: 'separator' },
        { label: 'Refresh current view', accelerator: 'CmdOrCtrl+R', click: send('refresh') }
      ]
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Keyboard shortcuts', accelerator: 'CmdOrCtrl+/', click: send('shortcuts') },
        { label: 'Check for updates...', click: send('check-updates') },
        { type: 'separator' },
        {
          label: 'Documentation',
          click: () => void shell.openExternal('https://github.com/buzzwordy/Panope')
        },
        {
          label: 'Report an issue',
          click: () => void shell.openExternal('https://github.com/buzzwordy/Panope/issues')
        },
        { type: 'separator' },
        ...(isMac ? [] : ([{ label: 'About Panope', click: send('about') }] as MenuItemConstructorOptions[]))
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
