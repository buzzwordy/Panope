import { app } from 'electron'
import { join } from 'node:path'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

// Tiny persisted settings store in userData. Writes are merge-preserving and
// atomic (tmp + rename) so concurrent keys and crashes can't clobber the file.

const settingsPath = (): string => join(app.getPath('userData'), 'settings.json')

export function loadSettings(): Record<string, unknown> {
  try {
    const s = JSON.parse(readFileSync(settingsPath(), 'utf8')) as unknown
    return s && typeof s === 'object' ? (s as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function saveSetting(key: string, value: unknown): void {
  try {
    const merged = { ...loadSettings(), [key]: value }
    const tmp = settingsPath() + '.tmp'
    writeFileSync(tmp, JSON.stringify(merged, null, 2))
    renameSync(tmp, settingsPath())
  } catch (e) {
    console.error('[main] failed to persist settings:', e)
  }
}
