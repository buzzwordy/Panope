import { app } from 'electron'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AuditEntry } from '../shared/types'

/**
 * Desktop action audit: every mutation this app performs, newest last.
 *
 * Kept in memory for the viewer and appended to a JSONL file in userData so a
 * "what did I break yesterday?" question survives a restart. The file is
 * best-effort (a failed append never blocks the action) and self-pruning.
 */

const MAX_MEMORY = 1000
const MAX_FILE_LINES = 5000

const entries: AuditEntry[] = []
let filePath: string | undefined
let loaded = false
let lines = 0

function file(): string {
  if (!filePath) filePath = join(app.getPath('userData'), 'audit.jsonl')
  return filePath
}

async function loadOnce(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const text = await readFile(file(), 'utf8')
    const rows = text.split('\n').filter(Boolean)
    lines = rows.length
    for (const row of rows.slice(-MAX_MEMORY)) {
      try {
        entries.push(JSON.parse(row) as AuditEntry)
      } catch {
        /* skip corrupt line */
      }
    }
  } catch {
    /* no file yet */
  }
}

export function recordAudit(method: string, target: string, ok: boolean, error?: string): void {
  const entry: AuditEntry = { ts: Date.now(), user: '', method, target, ok, ...(error ? { error } : {}) }
  void loadOnce().then(() => {
    entries.push(entry)
    if (entries.length > MAX_MEMORY) entries.splice(0, entries.length - MAX_MEMORY)
    lines += 1
    void appendFile(file(), JSON.stringify(entry) + '\n', 'utf8')
      .then(async () => {
        // Rewrite the file down to the in-memory tail when it grows too large.
        if (lines > MAX_FILE_LINES) {
          const { writeFile } = await import('node:fs/promises')
          await writeFile(file(), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
          lines = entries.length
        }
      })
      .catch(() => undefined)
  })
}

export async function auditEntries(): Promise<AuditEntry[]> {
  await loadOnce()
  return [...entries].reverse() // newest first for the viewer
}
