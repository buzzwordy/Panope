// Lightweight persisted preferences (Electron renderer localStorage lives in the
// app's user-data dir, so it survives restarts).

export type Density = 'comfortable' | 'compact'

export type ThemeId = 'dark' | 'light' | 'github-dark' | 'github-light'

/** Which CodeMirror / icon base a theme id maps to. */
export function themeBase(id: ThemeId): 'dark' | 'light' {
  return id === 'light' || id === 'github-light' ? 'light' : 'dark'
}

export const THEMES: Array<{ id: ThemeId; label: string }> = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'github-dark', label: 'GitHub Dark' },
  { id: 'github-light', label: 'GitHub Light' }
]

/** A named list configuration: filters + column set, recallable per resource. */
export interface SavedView {
  name: string
  search: string
  labelFilter: string
  namespace: string
  /** hidden column ids at save time (undefined = catalog defaults) */
  hiddenColumns?: string[]
}

export interface Prefs {
  theme: ThemeId
  favorites: string[]
  density: Density
  /** hidden column ids per resource key */
  hiddenColumns: Record<string, string[]>
  lastNamespace?: string
  /** flash dashboard panels when new problems / warnings appear */
  alertFlash: boolean
  /** dashboard panel arrangement: explicit order + hidden ids */
  dashboardLayout: { order: string[]; hidden: string[] }
  /** saved list views per resource key */
  savedViews: Record<string, SavedView[]>
  /** ask GitHub for a newer release on startup (the only non-cluster request) */
  updateCheck: boolean
  /** release the user dismissed, so the same version isn't announced twice */
  updateSkipped?: string
}

const KEY = 'panope.prefs.v1'
const DEFAULTS: Prefs = {
  theme: 'dark',
  favorites: [],
  density: 'comfortable',
  hiddenColumns: {},
  alertFlash: true,
  dashboardLayout: { order: [], hidden: [] },
  savedViews: {},
  updateCheck: true
}

export function loadPrefs(): Prefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Prefs>) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function savePrefs(patch: Partial<Prefs>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadPrefs(), ...patch }))
  } catch {
    /* ignore quota / disabled storage */
  }
}
