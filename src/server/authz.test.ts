import { describe, it, expect } from 'vitest'
import { mapIdentity, resolvePolicy, namespaceAllowed, globMatch, type AuthzConfig, type IdentityMapping } from './authz'

const baseIdentity: IdentityMapping = {
  usernameClaim: 'preferred_username',
  groups: [{ claim: 'groups' }],
  forbidden: [],
  allowed: []
}

describe('globMatch', () => {
  it('is anchored - a prefix must not match a longer name', () => {
    expect(globMatch('dev', 'dev')).toBe(true)
    expect(globMatch('dev', 'dev-secret')).toBe(false)
  })
  it('supports wildcards and star-all', () => {
    expect(globMatch('payments-*', 'payments-prod')).toBe(true)
    expect(globMatch('payments-*', 'billing-prod')).toBe(false)
    expect(globMatch('*', 'anything')).toBe(true)
  })
})

describe('mapIdentity - escalation defences', () => {
  it('maps username and the FULL group set (not just the first)', () => {
    const out = mapIdentity({ preferred_username: 'alice', groups: ['dev', 'sre', 'oncall'] }, baseIdentity)
    expect(out.user).toBe('alice')
    expect(out.groups).toEqual(['dev', 'sre', 'oncall'])
  })

  it('REFUSES a system: username - this is the cluster-admin escalation path', () => {
    expect(() => mapIdentity({ preferred_username: 'system:masters' }, baseIdentity)).toThrow(/not permitted/i)
    expect(() =>
      mapIdentity({ preferred_username: 'system:serviceaccount:kube-system:default' }, baseIdentity)
    ).toThrow(/not permitted/i)
  })

  it('drops system: groups rather than impersonating them', () => {
    const out = mapIdentity({ preferred_username: 'alice', groups: ['dev', 'system:masters'] }, baseIdentity)
    expect(out.groups).toEqual(['dev'])
    expect(out.dropped).toContain('system:masters')
  })

  it('is case-insensitive about the system: prefix', () => {
    const out = mapIdentity({ preferred_username: 'alice', groups: ['System:Masters'] }, baseIdentity)
    expect(out.groups).toEqual([])
  })

  it('honours an operator denylist and allowlist', () => {
    const denied = mapIdentity(
      { preferred_username: 'alice', groups: ['dev', 'cluster-admin'] },
      { ...baseIdentity, forbidden: ['cluster-admin'] }
    )
    expect(denied.groups).toEqual(['dev'])

    const allowed = mapIdentity(
      { preferred_username: 'alice', groups: ['dev', 'sre'] },
      { ...baseIdentity, allowed: ['alice', 'dev'] }
    )
    expect(allowed.groups).toEqual(['dev'])
  })

  it('never falls back to no-impersonation when the user is disallowed', () => {
    // Falling back would run as the ServiceAccount - i.e. MORE access.
    expect(() => mapIdentity({ preferred_username: 'mallory' }, { ...baseIdentity, allowed: ['alice'] })).toThrow()
  })

  it('reads nested claims, with strip and prefix', () => {
    const out = mapIdentity(
      { sub: 'x', email: 'a@b.c', realm_access: { roles: ['panope-dev', 'panope-oncall'] } },
      {
        usernameClaim: 'email',
        groups: [{ claim: 'realm_access.roles', strip: 'panope-', prefix: 'role:' }],
        forbidden: [],
        allowed: []
      }
    )
    expect(out.user).toBe('a@b.c')
    expect(out.groups).toEqual(['role:dev', 'role:oncall'])
  })

  it('applies a username prefix (mirroring --oidc-username-prefix)', () => {
    const out = mapIdentity({ preferred_username: 'alice' }, { ...baseIdentity, usernamePrefix: 'oidc:' })
    expect(out.user).toBe('oidc:alice')
  })

  it('accepts a space/comma separated string claim, and dedupes', () => {
    const out = mapIdentity(
      { preferred_username: 'alice', groups: 'dev, sre dev' },
      baseIdentity
    )
    expect(out.groups).toEqual(['dev', 'sre'])
  })

  it('throws when the username claim is missing', () => {
    expect(() => mapIdentity({ sub: 'nope' }, baseIdentity)).toThrow(/no usable/i)
  })
})

const cfg: AuthzConfig = {
  identity: baseIdentity,
  roles: {
    viewer: { readOnly: true, features: ['logs'] },
    dev: { readOnly: false, features: ['logs', 'exec', 'apply'] },
    admin: { readOnly: false, features: ['*'], privileged: true },
    lockedAdmin: { readOnly: true, features: ['*'], privileged: true }
  },
  bindings: [
    { groups: ['platform-admins'], role: 'admin' },
    { groups: ['team-*'], role: 'dev', namespaces: ['payments', 'payments-*'] },
    { users: ['ops@example.com'], role: 'dev' },
    { always: true, role: 'viewer' }
  ]
}

describe('resolvePolicy', () => {
  it('first matching binding wins', () => {
    const p = resolvePolicy('alice', ['platform-admins', 'team-x'], cfg)
    expect(p.role).toBe('admin')
    expect(p.privileged).toBe(true)
    expect(p.features.has('nodeShell')).toBe(true)
  })
  it('matches group globs and applies namespace scope', () => {
    const p = resolvePolicy('bob', ['team-payments'], cfg)
    expect(p.role).toBe('dev')
    expect(p.namespaces).toEqual(['payments', 'payments-*'])
    expect(p.features.has('exec')).toBe(true)
    expect(p.features.has('nodeShell')).toBe(false)
  })
  it('matches on username too', () => {
    expect(resolvePolicy('ops@example.com', [], cfg).role).toBe('dev')
  })
  it('falls back to the always binding', () => {
    const p = resolvePolicy('nobody', ['random'], cfg)
    expect(p.role).toBe('viewer')
    expect(p.readOnly).toBe(true)
  })
  it('fails CLOSED when no binding matches at all', () => {
    const p = resolvePolicy('x', [], { ...cfg, bindings: [{ groups: ['nope'], role: 'admin' }] })
    expect(p.readOnly).toBe(true)
    expect(p.features.size).toBe(0)
    expect(p.privileged).toBe(false)
  })
  it('fails closed when a binding names a role that does not exist', () => {
    const p = resolvePolicy('x', [], { ...cfg, bindings: [{ always: true, role: 'ghost' }] })
    expect(p.readOnly).toBe(true)
    expect(p.features.size).toBe(0)
  })
  it('readOnly beats privileged - a read-only role can never be privileged', () => {
    const p = resolvePolicy('x', [], { ...cfg, bindings: [{ always: true, role: 'lockedAdmin' }] })
    expect(p.readOnly).toBe(true)
    expect(p.privileged).toBe(false)
  })
})

describe('namespaceAllowed', () => {
  const scoped = resolvePolicy('bob', ['team-payments'], cfg)
  it('permits matching namespaces', () => {
    expect(namespaceAllowed('payments', scoped)).toBe(true)
    expect(namespaceAllowed('payments-prod', scoped)).toBe(true)
  })
  it('denies others', () => {
    expect(namespaceAllowed('kube-system', scoped)).toBe(false)
  })
  it('an unscoped policy permits everything', () => {
    expect(namespaceAllowed('kube-system', resolvePolicy('a', ['platform-admins'], cfg))).toBe(true)
  })
})
