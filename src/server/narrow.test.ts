import { describe, it, expect } from 'vitest'
import { narrowNamespaces, resolvePolicy, namespaceAllowed, type AuthzConfig } from './authz'

describe('narrowNamespaces - a binding may only narrow, never widen', () => {
  it('treats an empty list as unrestricted and defers to the other side', () => {
    expect(narrowNamespaces([], ['payments'])).toEqual(['payments'])
    expect(narrowNamespaces(['payments'], [])).toEqual(['payments'])
    expect(narrowNamespaces(undefined, undefined)).toEqual([])
  })

  it('ignores a binding that points entirely outside the role, keeping the ceiling', () => {
    // The regression: this used to resolve to ['kube-system']. It must not
    // resolve to [] either - downstream that means "unrestricted".
    expect(narrowNamespaces(['payments'], ['kube-system'])).toEqual(['payments'])
    expect(narrowNamespaces(['payments'], ['payments'])).toEqual(['payments'])
  })

  it('keeps the subset when a binding narrows within the role', () => {
    expect(narrowNamespaces(['payments', 'billing'], ['payments'])).toEqual(['payments'])
    expect(narrowNamespaces(['payments-*'], ['payments-eu'])).toEqual(['payments-eu'])
  })

  it('does not let a wildcard binding escape a narrower role', () => {
    expect(narrowNamespaces(['payments-*'], ['*'])).toEqual(['payments-*'])
    expect(narrowNamespaces(['*'], ['payments'])).toEqual(['payments'])
  })
})

describe('resolvePolicy namespace scope', () => {
  const cfg: AuthzConfig = {
    identity: { usernameClaim: 'preferred_username', groups: [{ claim: 'groups' }], forbidden: [], allowed: [] },
    roles: {
      scoped: { readOnly: false, features: ['logs'], namespaces: ['payments'] },
      open: { readOnly: false, features: ['logs'] }
    },
    bindings: [
      { groups: ['escalate'], role: 'scoped', namespaces: ['kube-system'] },
      { groups: ['narrow'], role: 'open', namespaces: ['team-a'] },
      { always: true, role: 'open' }
    ]
  }

  it('refuses a binding that points outside the role ceiling', () => {
    const p = resolvePolicy('mallory', ['escalate'], cfg)
    // Falls back to the role's ceiling - NOT the binding, and not [] (which
    // namespaceAllowed would read as unrestricted).
    expect(p.namespaces).toEqual(['payments'])
    expect(namespaceAllowed('kube-system', p)).toBe(false)
    expect(namespaceAllowed('payments', p)).toBe(true)
  })

  it('applies a binding that narrows an unrestricted role', () => {
    const p = resolvePolicy('alice', ['narrow'], cfg)
    expect(p.namespaces).toEqual(['team-a'])
    expect(namespaceAllowed('team-a', p)).toBe(true)
    expect(namespaceAllowed('kube-system', p)).toBe(false)
  })
})
