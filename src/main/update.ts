import { get } from 'node:https'

/**
 * Update notification, not auto-update.
 *
 * Panope ships as AppImage/deb/rpm/nsis/dmg. electron-updater can only install
 * two of those (AppImage and nsis), and its macOS path needs a signed build,
 * which these aren't. So instead of half an updater we ask GitHub what the
 * latest release is and point the user at it. Nothing downloads, nothing
 * restarts on its own.
 *
 * The request is the only outbound call Panope makes that isn't to a cluster,
 * so it is easy to turn off and it fails silently.
 */

const RELEASES_API = 'https://api.github.com/repos/buzzwordy/Panope/releases/latest'
const TIMEOUT_MS = 6000
const MAX_BYTES = 512 * 1024

export interface UpdateCheck {
  current: string
  latest?: string
  url?: string
  /** true when `latest` is a higher version than `current` */
  newer: boolean
  error?: string
}

/** Parse "v2.7.0", "2.7.0-rc.1" into comparable parts. Returns null if unparseable. */
function parse(v: string): { nums: number[]; pre: string } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim())
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' }
}

/** 1 if a > b, -1 if a < b, 0 if equal or either is unparseable. */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i] ? 1 : -1
  }
  // 2.7.0 is newer than 2.7.0-rc.1; between two prereleases, compare as text.
  if (pa.pre === pb.pre) return 0
  if (!pa.pre) return 1
  if (!pb.pre) return -1
  return pa.pre > pb.pre ? 1 : -1
}

function fetchLatest(): Promise<{ tag_name?: string; html_url?: string; draft?: boolean }> {
  return new Promise((resolve, reject) => {
    const req = get(
      RELEASES_API,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Panope'
        },
        timeout: TIMEOUT_MS
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`GitHub returned ${res.statusCode}`))
          return
        }
        let body = ''
        res.setEncoding('utf8')
        // A proxy that half-closes mid-body emits 'error' on the response, not
        // the request. Without this the promise would never settle.
        res.on('error', reject)
        res.on('data', (c: string) => {
          body += c
          if (body.length > MAX_BYTES) {
            req.destroy()
            reject(new Error('response too large'))
          }
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch {
            reject(new Error('malformed response'))
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', reject)
  })
}

/**
 * Ask GitHub for the newest published release. Never throws - a machine with no
 * internet (or behind a proxy that blocks github.com) gets `error` set and the
 * caller stays quiet about it.
 */
export async function checkForUpdate(current: string): Promise<UpdateCheck> {
  try {
    const rel = await fetchLatest()
    const latest = rel.tag_name?.replace(/^v/, '')
    if (!latest || rel.draft) return { current, newer: false, error: 'no published release' }
    return {
      current,
      latest,
      url: rel.html_url ?? 'https://github.com/buzzwordy/Panope/releases/latest',
      newer: compareVersions(latest, current) > 0
    }
  } catch (e) {
    return { current, newer: false, error: e instanceof Error ? e.message : String(e) }
  }
}
