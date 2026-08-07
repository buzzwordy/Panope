/**
 * Claim mapping + authorization policy.
 *
 * There are deliberately TWO layers, because they answer different questions:
 *
 *  Layer 1 - IDENTITY. Map arbitrary OIDC claims onto a Kubernetes user +
 *  groups, which are then impersonated. Per-namespace / per-resource / per-verb
 *  authorization is therefore done by the API server against real RBAC. This is
 *  the hard security boundary: even a bug in Panope cannot grant access the
 *  cluster would refuse.
 *
 *  Layer 2 - CAPABILITIES. Map groups onto app-level roles that gate FEATURES
 *  (terminal, apply, node shell...) and narrow the UI. RBAC cannot express "this
 *  team may not use the web terminal even though they can exec via kubectl", so
 *  this layer exists - but it only ever SUBTRACTS. It is a guardrail, never a
 *  grant.
 *
 * Everything is config-driven so an operator can map any IdP's claim shape
 * (Keycloak realm roles, Entra groups, Okta, Google, plain `groups`) without
 * code changes.
 */

export type Feature =
  | 'logs'
  | 'events'
  | 'exec'
  | 'portForward'
  | 'apply'
  | 'delete'
  | 'scale'
  | 'nodeShell'
  | 'debugContainer'
  | 'helm'
  | 'argo'

export const ALL_FEATURES: Feature[] = [
  'logs',
  'events',
  'exec',
  'portForward',
  'apply',
  'delete',
  'scale',
  'nodeShell',
  'debugContainer',
  'helm',
  'argo'
]

/** How to pull a group list out of a token's claims. */
export interface GroupMapping {
  /** dot-path into the claims, e.g. "groups" or "realm_access.roles" */
  claim: string
  /** keep only values matching this regex (applied before prefix/strip) */
  match?: string
  /** drop this leading string from each value */
  strip?: string
  /** add this leading string to each value (namespacing, e.g. "role:") */
  prefix?: string
}

export interface IdentityMapping {
  /** claim to use as the Kubernetes username */
  usernameClaim: string
  /** optional prefix, to mirror the API server's --oidc-username-prefix */
  usernamePrefix?: string
  /** zero or more places to harvest groups from */
  groups: GroupMapping[]
  /** subjects that may never be impersonated (defence in depth; system:* is always denied) */
  forbidden: string[]
  /** if non-empty, ONLY these subjects may be impersonated */
  allowed: string[]
}

export interface RoleDef {
  /** force read-only regardless of what RBAC would permit */
  readOnly: boolean
  /** '*' for everything */
  features: Array<Feature | '*'>
  /** allow node shell / ephemeral debug containers */
  privileged?: boolean
  /** if non-empty, the UI is restricted to these namespaces (glob) */
  namespaces?: string[]
}

export interface Binding {
  /** match on mapped groups (glob), the username (glob), or always */
  groups?: string[]
  users?: string[]
  always?: boolean
  role: string
  /** narrow further than the role's own namespace list */
  namespaces?: string[]
}

export interface AuthzConfig {
  identity: IdentityMapping
  roles: Record<string, RoleDef>
  bindings: Binding[]
}

/** The resolved decision for one logged-in user. */
export interface Policy {
  role: string
  readOnly: boolean
  features: Set<Feature>
  privileged: boolean
  /** empty = all namespaces */
  namespaces: string[]
}

// ---------------------------------------------------------------------------

/** `a.b.c` lookup that tolerates missing intermediates. */
function claimAt(claims: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), claims)
}

/** Shell-style glob: `payments-*` / `*`. Anchored, so `dev` never matches `dev-secret`. */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true
  const re = new RegExp(
    '^' +
      pattern
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
    'i'
  )
  return re.test(value)
}

const isSystemSubject = (s: string): boolean => /^system:/i.test(s.trim())

/**
 * Map claims onto the Kubernetes identity to impersonate.
 *
 * SECURITY: `system:*` is unconditionally rejected here - it is the escalation
 * path that turns "user controls their own claim" into cluster-admin
 * (`system:masters` bypasses RBAC; `system:serviceaccount:...` borrows a SA).
 * Operator-supplied `forbidden`/`allowed` lists layer on top.
 */
export function mapIdentity(
  claims: Record<string, unknown>,
  cfg: IdentityMapping
): { user: string; groups: string[]; dropped: string[] } {
  const raw = claimAt(claims, cfg.usernameClaim)
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`token has no usable "${cfg.usernameClaim}" claim for the Kubernetes username`)
  }
  const user = `${cfg.usernamePrefix ?? ''}${raw.trim()}`

  const dropped: string[] = []
  const permitted = (subject: string): boolean => {
    if (isSystemSubject(subject)) return false
    if (cfg.forbidden.some((p) => globMatch(p, subject))) return false
    if (cfg.allowed.length && !cfg.allowed.some((p) => globMatch(p, subject))) return false
    return true
  }

  if (!permitted(user)) {
    // Never fall back to "no impersonation" here: that would silently run as
    // the ServiceAccount, i.e. MORE access than the user should have.
    throw new Error(`identity "${user}" is not permitted to be impersonated`)
  }

  const groups = new Set<string>()
  for (const m of cfg.groups) {
    const value = claimAt(claims, m.claim)
    const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : []
    for (const entry of list) {
      if (typeof entry !== 'string' || !entry.trim()) continue
      let g = entry.trim()
      if (m.match && !new RegExp(m.match).test(g)) continue
      if (m.strip && g.startsWith(m.strip)) g = g.slice(m.strip.length)
      if (m.prefix) g = `${m.prefix}${g}`
      if (!g) continue
      if (!permitted(g)) {
        dropped.push(g)
        continue
      }
      groups.add(g)
    }
  }
  return { user, groups: [...groups], dropped }
}

/** Resolve the app-level policy for a user from the first matching binding. */
export function resolvePolicy(user: string, groups: string[], cfg: AuthzConfig): Policy {
  const matches = (b: Binding): boolean => {
    if (b.always) return true
    if (b.users?.some((p) => globMatch(p, user))) return true
    if (b.groups?.some((p) => groups.some((g) => globMatch(p, g)))) return true
    return false
  }
  const binding = cfg.bindings.find(matches)
  const role = binding ? cfg.roles[binding.role] : undefined

  if (!binding || !role) {
    // Fail closed: an unmatched user gets read-only with nothing enabled.
    return { role: binding?.role ?? 'none', readOnly: true, features: new Set(), privileged: false, namespaces: [] }
  }

  const features = new Set<Feature>(
    role.features.includes('*') ? ALL_FEATURES : (role.features as Feature[])
  )
  return {
    role: binding.role,
    readOnly: !!role.readOnly,
    features,
    privileged: !!role.privileged && !role.readOnly,
    namespaces: narrowNamespaces(role.namespaces, binding.namespaces)
  }
}

/**
 * Namespace scope is the INTERSECTION of the role's list and the binding's -
 * a binding may only ever narrow.
 *
 * An empty list means "unrestricted", so whichever side is empty defers to the
 * other. When both are set, a binding pattern is kept only if the role would
 * also have allowed it; a binding naming a namespace outside the role's ceiling
 * is silently dropped rather than granting it. (Previously the binding's list
 * REPLACED the role's, so `role: {namespaces:[payments]}` bound with
 * `{namespaces:[kube-system]}` escaped to kube-system.)
 */
export function narrowNamespaces(roleNs?: string[], bindingNs?: string[]): string[] {
  const r = roleNs ?? []
  const b = bindingNs ?? []
  if (!r.length) return [...b]
  if (!b.length) return [...r]
  const kept = b.filter((pattern) => r.some((allowed) => patternWithin(allowed, pattern)))
  // An empty result would read as "unrestricted" downstream (namespaceAllowed
  // treats [] as no limit), so a binding that points entirely outside the role
  // would escape even harder than the bug this replaced. Fall back to the
  // role's own ceiling: the misconfigured binding is ignored, never honoured.
  return kept.length ? kept : [...r]
}

/** True if every namespace matching `pattern` would also match `allowed`. */
function patternWithin(allowed: string, pattern: string): boolean {
  // A literal is inside `allowed` when it matches it outright. For a wildcard
  // pattern we require it to be at least as specific as the role's, which the
  // glob test approximates safely: `payments-*` is within `payments-*`, and
  // within `*`, but `*` is not within `payments-*`.
  return globMatch(allowed, pattern) || allowed === pattern
}

export function namespaceAllowed(ns: string | undefined, policy: Policy): boolean {
  if (!policy.namespaces.length) return true
  if (!ns) return true // cluster-scoped reads are governed by RBAC
  return policy.namespaces.some((p) => globMatch(p, ns))
}

// ---------------------------------------------------------------------------

const DEFAULT_ROLES: Record<string, RoleDef> = {
  viewer: { readOnly: true, features: ['logs', 'events'] },
  developer: { readOnly: false, features: ['logs', 'events', 'exec', 'portForward', 'apply', 'scale', 'helm', 'argo'] },
  admin: { readOnly: false, features: ['*'], privileged: true }
}

/**
 * Load the policy from PANOPE_AUTHZ (JSON, rendered by the chart). Falls back to
 * a single deployment-wide role derived from readOnly/allowPrivileged, which is
 * what the simple no-auth deployment wants.
 */
export function authzFromEnv(fallback: { readOnly: boolean; allowPrivileged: boolean }): AuthzConfig {
  const raw = process.env.PANOPE_AUTHZ
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<AuthzConfig>
      const identity: IdentityMapping = {
        usernameClaim: parsed.identity?.usernameClaim || process.env.OIDC_USERNAME_CLAIM || 'preferred_username',
        usernamePrefix: parsed.identity?.usernamePrefix,
        groups: parsed.identity?.groups?.length
          ? parsed.identity.groups
          : [{ claim: process.env.OIDC_GROUPS_CLAIM || 'groups' }],
        forbidden: parsed.identity?.forbidden ?? [],
        allowed: parsed.identity?.allowed ?? []
      }
      return {
        identity,
        roles: { ...DEFAULT_ROLES, ...(parsed.roles ?? {}) },
        bindings: parsed.bindings?.length ? parsed.bindings : [{ always: true, role: 'viewer' }]
      }
    } catch (e) {
      // A malformed policy must not silently widen access.
      throw new Error(`PANOPE_AUTHZ is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return {
    identity: {
      usernameClaim: process.env.OIDC_USERNAME_CLAIM || 'preferred_username',
      groups: [{ claim: process.env.OIDC_GROUPS_CLAIM || 'groups' }],
      forbidden: [],
      allowed: []
    },
    roles: {
      _deployment: {
        readOnly: fallback.readOnly,
        features: ['*'],
        privileged: fallback.allowPrivileged
      }
    },
    bindings: [{ always: true, role: '_deployment' }]
  }
}
