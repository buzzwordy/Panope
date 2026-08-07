import type { PodFileEntry } from '@shared/types'

/**
 * Parse `ls -la` output from a container into structured entries.
 *
 * Deliberately tolerant: busybox, coreutils and alpine all format slightly
 * differently (column counts differ with hardlink counts and date styles), so
 * this splits on whitespace and reassembles the name from the remainder.
 */
export function parseLsOutput(text: string): PodFileEntry[] {
  const out: PodFileEntry[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (!line || line.startsWith('total ')) continue
    // mode links owner group size (date: 3 tokens) name...
    const m = line.match(
      /^([\w-]{10}[.+@]?)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\w+\s+\d+\s+[\d:]+)\s+(.+)$/
    )
    if (!m) continue
    const mode = m[1]
    const size = Number(m[5])
    const modified = m[6]
    let name = m[7]
    let linkTo: string | undefined
    const arrow = name.indexOf(' -> ')
    if (arrow >= 0) {
      linkTo = name.slice(arrow + 4)
      name = name.slice(0, arrow)
    }
    if (name === '.' || name === '..') continue
    out.push({ name, type: mode[0], size, mode, modified, linkTo })
  }
  // directories first, then alphabetical
  return out.sort((a, b) => (a.type === 'd' ? 0 : 1) - (b.type === 'd' ? 0 : 1) || a.name.localeCompare(b.name))
}

/** Join + normalise a container path (no '..' escapes past root). */
export function joinPodPath(base: string, entry: string): string {
  if (entry === '..') {
    const parts = base.split('/').filter(Boolean)
    parts.pop()
    return '/' + parts.join('/')
  }
  return (base === '/' ? '' : base) + '/' + entry
}

/** Decode a base64 payload into bytes (for file downloads). */
export function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, '')
  const bin = atob(clean)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}
