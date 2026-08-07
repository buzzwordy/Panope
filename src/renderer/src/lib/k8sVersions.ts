/**
 * Is the cluster's Kubernetes minor still getting patches?
 *
 * The project supports the latest three minors, roughly 14 months each. There
 * is no API for this, so the dates are a static table from
 * kubernetes.io/releases/patch-releases. A minor we have never heard of is
 * reported as unknown rather than guessed at, so a table that falls behind
 * stays quiet instead of crying wolf on a newer cluster than we know about.
 */

/** End of patch support, YYYY-MM-DD. Entries after TABLE_ASOF are projected. */
const EOL: Record<string, string> = {
  '1.24': '2023-07-28',
  '1.25': '2023-10-28',
  '1.26': '2024-02-28',
  '1.27': '2024-06-28',
  '1.28': '2024-10-28',
  '1.29': '2025-02-28',
  '1.30': '2025-06-28',
  '1.31': '2025-10-28',
  '1.32': '2026-02-28',
  '1.33': '2026-06-28',
  '1.34': '2026-10-28',
  '1.35': '2027-02-28'
}

export const TABLE_ASOF = '2026-09'

export type SupportState = 'supported' | 'ending' | 'eol' | 'unknown'

export interface VersionSupport {
  /** "1.33" */
  minor: string
  state: SupportState
  /** end of patch support, when known */
  eol?: string
  /** days until eol; negative once past it */
  days?: number
}

/** "v1.33.13+k3s1" -> "1.33". Returns null if it does not look like a version. */
export function minorOf(gitVersion: string | undefined): string | null {
  const m = /^v?(\d+)\.(\d+)/.exec((gitVersion ?? '').trim())
  return m ? `${m[1]}.${m[2]}` : null
}

/** `today` is injectable so the result is testable without a clock. */
export function versionSupport(gitVersion: string | undefined, today = new Date()): VersionSupport | null {
  const minor = minorOf(gitVersion)
  if (!minor) return null
  const eol = EOL[minor]
  if (!eol) return { minor, state: 'unknown' }
  const days = Math.round((Date.parse(eol) - today.getTime()) / 86_400_000)
  // "ending" gives a quarter's warning, which is about one minor release.
  const state: SupportState = days < 0 ? 'eol' : days <= 90 ? 'ending' : 'supported'
  return { minor, state, eol, days }
}

/** Patch number of a version string: "v1.33.2+k3s1" -> 2. null if unparseable. */
export function patchOf(gitVersion: string | undefined): number | null {
  const m = /^v?\d+\.\d+\.(\d+)/.exec((gitVersion ?? '').trim())
  return m ? Number(m[1]) : null
}

/**
 * How many patch releases behind `latest` the cluster is, within the same
 * minor. null when either side is unparseable or the minors differ, so a
 * mismatched answer can never be presented as a count.
 */
export function patchesBehind(current: string | undefined, latest: string | undefined): number | null {
  if (minorOf(current) === null || minorOf(current) !== minorOf(latest)) return null
  const a = patchOf(current)
  const b = patchOf(latest)
  if (a === null || b === null) return null
  return Math.max(0, b - a)
}

/** One line for a tooltip or a badge title. */
export function supportLabel(v: VersionSupport): string {
  switch (v.state) {
    case 'eol':
      return `Kubernetes ${v.minor} stopped getting patches on ${v.eol}. Plan an upgrade.`
    case 'ending':
      return `Kubernetes ${v.minor} stops getting patches on ${v.eol} (${v.days} days).`
    case 'supported':
      return `Kubernetes ${v.minor} is supported until ${v.eol}.`
    default:
      return `No support data for Kubernetes ${v.minor} (table as of ${TABLE_ASOF}).`
  }
}
