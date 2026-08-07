import { app, shell, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { registerIpcHandlers } from './ipc'
import { buildAppMenu } from './menu'
import { loadSettings, saveSetting } from './settings'

const isDev = !app.isPackaged

// Offscreen capture is more reliable without hardware acceleration.
if (process.env.PANOPE_SHOT) app.disableHardwareAcceleration()

// Safety net: a stray stream/socket error (logs, exec, port-forward) must never
// take down the whole app.
process.on('uncaughtException', (e) => console.error('[main] uncaughtException:', e))
process.on('unhandledRejection', (e) => console.error('[main] unhandledRejection:', e))

// App icon for the running window / taskbar (Linux & Windows use this; macOS
// uses the bundle .icns). Bundled as an extraResource when packaged.
const iconPath = app.isPackaged
  ? join(process.resourcesPath, 'icon.png')
  : join(__dirname, '../../build/icon.png')

interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

function savedBounds(): WindowBounds {
  const raw = loadSettings().windowBounds as WindowBounds | undefined
  if (raw && typeof raw.width === 'number' && raw.width >= 940 && typeof raw.height === 'number' && raw.height >= 600)
    return raw
  return { width: 1920, height: 1080 }
}

function createWindow(): BrowserWindow {
  // When capturing a verification screenshot, render offscreen so no OS window
  // is created (avoids stray input on shared displays); otherwise show normally.
  const shooting = !!process.env.PANOPE_SHOT
  const bounds = shooting ? { width: 1920, height: 1080 } : savedBounds()
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#0d0e11',
    title: 'Panope',
    icon: iconPath,
    autoHideMenuBar: shooting,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Security: isolate the renderer from Node entirely. All privileged work
      // (kubeconfig, cluster API) happens in the main process behind IPC.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs Node module resolution for the bridge
      offscreen: shooting
    }
  })

  win.on('ready-to-show', () => {
    if (!shooting && bounds.maximized) win.maximize()
    win.show()
  })

  // Persist window geometry (debounced) so the app reopens where it was left.
  if (!shooting) {
    let boundsTimer: ReturnType<typeof setTimeout> | undefined
    const persistBounds = (): void => {
      clearTimeout(boundsTimer)
      boundsTimer = setTimeout(() => {
        if (win.isDestroyed()) return
        const b = win.getNormalBounds()
        saveSetting('windowBounds', { ...b, maximized: win.isMaximized() } satisfies WindowBounds)
      }, 400)
    }
    win.on('resize', persistBounds)
    win.on('move', persistBounds)
    win.on('maximize', persistBounds)
    win.on('unmaximize', persistBounds)
  }

  // Optional automated screenshot: PANOPE_SHOT=/path/out.png captures the
  // rendered window after data settles, then quits. Used for verification only.
  const shotPath = process.env.PANOPE_SHOT
  if (shotPath) {
    let seeded = false
    win.webContents.on('did-finish-load', () => {
      const delay = Number(process.env.PANOPE_SHOT_DELAY || 5000)
      setTimeout(async () => {
        try {
          // Seed persisted favorites, then reload so the app picks them up.
          if (process.env.PANOPE_FAVORITES && !seeded) {
            seeded = true
            const favs = JSON.stringify(process.env.PANOPE_FAVORITES.split(','))
            await win.webContents.executeJavaScript(
              `(()=>{const k='panope.prefs.v1';const p=JSON.parse(localStorage.getItem(k)||'{}');p.favorites=${favs};localStorage.setItem(k,JSON.stringify(p));return true})()`
            )
            win.webContents.reload()
            return
          }
          if (process.env.PANOPE_SIDEBAR_BOTTOM) {
            await win.webContents.executeJavaScript(
              "(()=>{const el=document.querySelector('.sidebar__scroll'); if(el) el.scrollTop = el.scrollHeight; return true})()"
            )
            await new Promise((r) => setTimeout(r, 300))
          }
          if (process.env.PANOPE_SIDEBAR_ACTIVE) {
            await win.webContents.executeJavaScript(
              "(()=>{const el=document.querySelector('.nav-item.is-active'); if(el) el.scrollIntoView({block:'center'}); return true})()"
            )
            await new Promise((r) => setTimeout(r, 300))
          }
          if (process.env.PANOPE_SCROLL_TO) {
            const label = JSON.stringify(process.env.PANOPE_SCROLL_TO)
            const found = await win.webContents.executeJavaScript(
              `(()=>{const c=document.querySelector('.sidebar__scroll');const els=[...document.querySelectorAll('.nav-section__label')];const el=els.find(e=>(e.textContent||'').trim()===${label});if(c&&el){let t=0,n=el;while(n&&n!==c){t+=n.offsetTop;n=n.offsetParent}c.scrollTop=Math.max(0,t-12)}return {found:!!el,labels:els.map(e=>e.textContent.trim())}})()`
            )
            console.log('SHOT_SCROLL', JSON.stringify(found))
            await new Promise((r) => setTimeout(r, 300))
          }
          if (process.env.PANOPE_SORT) {
            const label = JSON.stringify(process.env.PANOPE_SORT.toLowerCase())
            const clicks = Number(process.env.PANOPE_SORT_CLICKS || 1)
            await win.webContents.executeJavaScript(
              `(()=>{const ths=[...document.querySelectorAll('table thead th')];const th=ths.find(t=>(t.textContent||'').trim().toLowerCase().includes(${label}));if(th){for(let i=0;i<${clicks};i++)th.click();}return !!th})()`
            )
            await new Promise((r) => setTimeout(r, 300))
          }
          if (process.env.PANOPE_EVAL) {
            const res = await win.webContents.executeJavaScript(process.env.PANOPE_EVAL)
            console.log('EVAL_RESULT', JSON.stringify(res))
            // let React re-render + paint before capture
            await new Promise((r) => setTimeout(r, 400))
          }
          if (process.env.PANOPE_CLICK) {
            const sel = JSON.stringify(process.env.PANOPE_CLICK)
            await win.webContents.executeJavaScript(
              `(()=>{const el=document.querySelector(${sel});if(el)el.click();return !!el})()`
            )
            await new Promise((r) => setTimeout(r, 350))
          }
          if (process.env.PANOPE_OPEN_MENU) {
            await win.webContents.executeJavaScript(
              "(()=>{const b=document.querySelector('.account-btn');if(b)b.click();return !!b})()"
            )
            await new Promise((r) => setTimeout(r, 300))
          }
          if (process.env.PANOPE_PALETTE) {
            await win.webContents.executeJavaScript(
              "(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));return true})()"
            )
            await new Promise((r) => setTimeout(r, 250))
            if (process.env.PANOPE_PALETTE !== '1') {
              const q = String(process.env.PANOPE_PALETTE)
              await win.webContents.executeJavaScript(
                `(()=>{const i=document.querySelector('.palette-input .input');if(i){const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;set.call(i,${JSON.stringify(q)});i.dispatchEvent(new Event('input',{bubbles:true}));}return true})()`
              )
              await new Promise((r) => setTimeout(r, 250))
            }
          }
          if (process.env.PANOPE_DENSITY) {
            await win.webContents.executeJavaScript(
              "(()=>{const b=[...document.querySelectorAll('button.btn')].find(x=>/Comfortable|Compact/.test(x.textContent||''));if(b)b.click();return !!b})()"
            )
            await new Promise((r) => setTimeout(r, 250))
          }
          if (process.env.PANOPE_VIEW_EDIT) {
            // Open the View tab, inject an edit into CodeMirror, then open the Diff view.
            await win.webContents.executeJavaScript(
              `(()=>{const t=[...document.querySelectorAll('.detail-tab')].find(x=>(x.textContent||'').trim()==='View');if(t)t.click();return !!t})()`
            )
            await new Promise((r) => setTimeout(r, 500))
            await win.webContents.executeJavaScript(
              `(()=>{const c=document.querySelector('.cm-content');if(!c)return false;c.focus();const sel=window.getSelection();const line=c.querySelector('.cm-line');if(line){const rng=document.createRange();rng.selectNodeContents(line);rng.collapse(true);sel.removeAllRanges();sel.addRange(rng);}document.execCommand('insertText',false,'  edited-by-panope: "true"\\n');return true})()`
            )
            await new Promise((r) => setTimeout(r, 400))
            await win.webContents.executeJavaScript(
              `(()=>{const b=[...document.querySelectorAll('button.btn')].find(x=>/Diff/.test(x.textContent||'')&&!x.disabled);if(b)b.click();return !!b})()`
            )
            await new Promise((r) => setTimeout(r, 400))
          }
          const img = await win.webContents.capturePage()
          writeFileSync(shotPath, img.toPNG())
          console.log('SHOT_WRITTEN', shotPath, img.getSize())
        } catch (e) {
          console.error('SHOT_ERR', e)
        }
        app.quit()
      }, delay)
    })
  }

  // Open external links in the OS browser rather than a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Optional launch params (used for verification screenshots).
  const q: Record<string, string> = {}
  if (process.env.PANOPE_INITIAL) q.resource = process.env.PANOPE_INITIAL
  if (process.env.PANOPE_CONTEXT) q.context = process.env.PANOPE_CONTEXT
  if (process.env.PANOPE_NS) q.ns = process.env.PANOPE_NS
  if (process.env.PANOPE_OPEN) q.open = process.env.PANOPE_OPEN
  if (process.env.PANOPE_TAB) q.tab = process.env.PANOPE_TAB
  if (process.env.PANOPE_CREATE) q.create = process.env.PANOPE_CREATE
  const qs = new URLSearchParams(q).toString()
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL + (qs ? `?${qs}` : ''))
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), qs ? { search: qs } : undefined)
  }

  return win
}

app.whenReady().then(() => {
  registerIpcHandlers()
  const win = createWindow()
  // Screenshot runs must not show a menu bar (it would shift the layout).
  if (!process.env.PANOPE_SHOT) buildAppMenu(() => BrowserWindow.getAllWindows()[0] ?? win)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
