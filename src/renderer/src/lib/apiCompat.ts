/**
 * Finds apiVersions in a manifest that the connected cluster no longer serves.
 *
 * The authority is the cluster's own discovery, not a baked-in table of
 * Kubernetes deprecations. That catches CRDs too: a chart pinned to
 * gateway.networking.k8s.io/v1alpha2 or kyverno.io/v2alpha1 breaks on an
 * operator upgrade exactly like a removed built-in does, and a static table
 * knows nothing about either.
 */

export interface ApiFinding {
  apiVersion: string
  kind: string
  /** group/versions the cluster does serve for this group, newest first */
  alternatives: string[]
  /** the group is gone entirely, not just this version */
  groupMissing: boolean
}

export interface ManifestRef {
  apiVersion: string
  kind: string
}

const GROUP_OF = (apiVersion: string): string =>
  apiVersion.includes('/') ? apiVersion.split('/')[0] : ''

/** apiVersion/kind pairs in a multi-doc YAML manifest, deduped. */
export function parseManifestRefs(text: string): ManifestRef[] {
  const out = new Map<string, ManifestRef>()
  // Split on document separators, then read the top-level keys of each doc.
  for (const doc of text.split(/^---\s*$/m)) {
    const apiVersion = /^apiVersion:\s*["']?([\w./-]+)["']?\s*$/m.exec(doc)?.[1]
    const kind = /^kind:\s*["']?([\w.-]+)["']?\s*$/m.exec(doc)?.[1]
    if (apiVersion && kind) out.set(`${apiVersion}/${kind}`, { apiVersion, kind })
  }
  return [...out.values()]
}

/**
 * Version ordering as Kubernetes itself ranks them: GA beats beta beats alpha,
 * then by number. v2 > v1 > v2beta1 > v1beta2 > v1beta1 > v1alpha1.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): [number, number, number] => {
    const m = /^v(\d+)(?:(alpha|beta)(\d+))?$/.exec(v)
    if (!m) return [-1, 0, 0]
    const stage = m[2] === 'alpha' ? 0 : m[2] === 'beta' ? 1 : 2
    return [stage, Number(m[1]), Number(m[3] ?? 0)]
  }
  const [as, an, ap] = parse(a)
  const [bs, bn, bp] = parse(b)
  if (as !== bs) return bs - as
  if (an !== bn) return bn - an
  return bp - ap
}

/**
 * Compare the manifest against what the cluster serves.
 * `served` is the full set, e.g. ['v1', 'apps/v1', 'networking.k8s.io/v1'].
 */
export function scanApiVersions(refs: ManifestRef[], served: string[]): ApiFinding[] {
  const servedSet = new Set(served)
  // group -> the versions it still serves
  const byGroup = new Map<string, string[]>()
  for (const s of served) {
    const g = GROUP_OF(s)
    const v = s.includes('/') ? s.split('/')[1] : s
    byGroup.set(g, [...(byGroup.get(g) ?? []), v])
  }

  const out: ApiFinding[] = []
  for (const ref of refs) {
    if (servedSet.has(ref.apiVersion)) continue
    const group = GROUP_OF(ref.apiVersion)
    const versions = byGroup.get(group) ?? []
    out.push({
      apiVersion: ref.apiVersion,
      kind: ref.kind,
      alternatives: [...versions].sort(compareVersions).map((v) => (group ? `${group}/${v}` : v)),
      groupMissing: versions.length === 0
    })
  }
  return out
}
