import { describe, expect, it } from 'vitest'
import { redactForModel, redactValuesYaml } from './redact'

describe('redactForModel', () => {
  it('replaces secret data values with size markers', () => {
    const secret = {
      kind: 'Secret',
      metadata: { name: 'db' },
      data: { password: 'aHVudGVyMg==', token: 'eA==' }
    }
    const out = redactForModel(secret, true) as typeof secret
    expect(out.data.password).toBe('<redacted 12 bytes>')
    expect(out.data.token).toBe('<redacted 4 bytes>')
    // the original is untouched
    expect(secret.data.password).toBe('aHVudGVyMg==')
  })

  it('redacts stringData too', () => {
    const s = { kind: 'Secret', stringData: { key: 'plaintext' } }
    const out = redactForModel(s, true) as typeof s
    expect(out.stringData.key).toBe('<redacted 9 bytes>')
  })

  it('redacts list items even when they carry no kind of their own', () => {
    const list = {
      items: [{ metadata: { name: 'a' }, data: { v: 'c2VjcmV0' } }]
    }
    const out = redactForModel(list, true) as typeof list
    expect(out.items[0].data.v).toMatch(/^<redacted/)
  })

  it('drops the last-applied annotation from secrets (it embeds the values)', () => {
    const s = {
      kind: 'Secret',
      metadata: {
        annotations: {
          'kubectl.kubernetes.io/last-applied-configuration': '{"data":{"password":"aHVudGVyMg=="}}',
          keep: 'me'
        }
      },
      data: {}
    }
    const out = redactForModel(s, true) as typeof s
    expect(out.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration']).toBeUndefined()
    expect(out.metadata.annotations.keep).toBe('me')
  })

  it('strips managedFields from every kind but leaves the rest alone', () => {
    const pod: {
      kind: string
      metadata: { name: string; managedFields?: Array<{ manager: string }> }
      spec: { containers: Array<{ name: string; env: Array<{ name: string; value: string }> }> }
    } = {
      kind: 'Pod',
      metadata: { name: 'x', managedFields: [{ manager: 'kubectl' }] },
      spec: { containers: [{ name: 'app', env: [{ name: 'A', value: 'b' }] }] }
    }
    const out = redactForModel(pod, false)
    expect(out.metadata.managedFields).toBeUndefined()
    expect(out.spec.containers[0].env[0].value).toBe('b')
  })

  it('redacts by kind even when the caller did not flag it', () => {
    const s = { kind: 'Secret', data: { a: 'eA==' } }
    const out = redactForModel(s, false) as typeof s
    expect(out.data.a).toMatch(/^<redacted/)
  })
})

describe('redactValuesYaml', () => {
  it('masks credential-like keys and leaves the rest', () => {
    const yaml = [
      'replicaCount: 2',
      'adminPassword: hunter2',
      'auth:',
      '  postgresPassword: s3cret',
      '  username: app',
      'apiKey: abc123',
      'image:',
      '  repository: nginx'
    ].join('\n')
    const out = redactValuesYaml(yaml)
    expect(out).toContain('adminPassword: <redacted>')
    expect(out).toContain('postgresPassword: <redacted>')
    expect(out).toContain('apiKey: <redacted>')
    expect(out).toContain('username: app')
    expect(out).toContain('repository: nginx')
    expect(out).toContain('replicaCount: 2')
  })

  it('leaves structural lines alone', () => {
    const yaml = 'secrets:\n  - name: pull-secret\ntlsSecretName: my-cert'
    const out = redactValuesYaml(yaml)
    expect(out).toContain('secrets:')
    expect(out).toContain('tlsSecretName: <redacted>')
  })
})
