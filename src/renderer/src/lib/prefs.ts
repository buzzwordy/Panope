// Lightweight persisted preferences (Electron renderer localStorage lives in the
// app's user-data dir, so it survives restarts).

export type Density = 'comfortable' | 'compact'

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
  theme: 'dark' | 'light'
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
}

const KEY = 'panope.prefs.v1'
const DEFAULTS: Prefs = {
  theme: 'dark',
  favorites: [],
  density: 'comfortable',
  hiddenColumns: {},
  alertFlash: true,
  dashboardLayout: { order: [], hidden: [] },
  savedViews: {}
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
