import { describe, it, expect } from 'vitest'
import { parseLsOutput, joinPodPath, b64ToBytes } from './podfiles'

const COREUTILS = `total 64
drwxr-xr-x   1 root root 4096 Jan  4 10:00 .
drwxr-xr-x   1 root root 4096 Jan  4 10:00 ..
drwxr-xr-x   2 root root 4096 Jan  4 10:00 bin
-rw-r--r--   1 root root  220 Jan  4 10:01 config.yaml
lrwxrwxrwx   1 root root   11 Jan  4 10:00 sh -> /bin/dash
-rwxr-xr-x   1 app  app  9128 Dec 31 23:59 run.sh`

const BUSYBOX = `total 12
drwxr-xr-x    3 nginx    nginx         4096 Aug  1 08:30 cache
-rw-r--r--    1 nginx    nginx          612 Aug  1 08:30 index.html`

describe('parseLsOutput', () => {
  it('parses coreutils-style listings, skipping total/./..', () => {
    const entries = parseLsOutput(COREUTILS)
    expect(entries.map((e) => e.name)).toEqual(['bin', 'config.yaml', 'run.sh', 'sh'])
    const cfg = entries.find((e) => e.name === 'config.yaml')!
    expect(cfg.type).toBe('-')
    expect(cfg.size).toBe(220)
    expect(cfg.mode).toBe('-rw-r--r--')
  })

  it('parses busybox-style listings', () => {
    const entries = parseLsOutput(BUSYBOX)
    expect(entries).toHaveLength(2)
    expect(entries[0].name).toBe('cache') // directories sort first
    expect(entries[0].type).toBe('d')
    expect(entries[1].size).toBe(612)
  })

  it('captures symlink targets', () => {
    const sh = parseLsOutput(COREUTILS).find((e) => e.name === 'sh')!
    expect(sh.type).toBe('l')
    expect(sh.linkTo).toBe('/bin/dash')
  })

  it('returns nothing for garbage / error output', () => {
    expect(parseLsOutput('ls: /nope: No such file or directory')).toEqual([])
    expect(parseLsOutput('')).toEqual([])
  })
})

describe('joinPodPath', () => {
  it('descends and pops correctly', () => {
    expect(joinPodPath('/', 'etc')).toBe('/etc')
    expect(joinPodPath('/etc', 'nginx')).toBe('/etc/nginx')
    expect(joinPodPath('/etc/nginx', '..')).toBe('/etc')
    expect(joinPodPath('/etc', '..')).toBe('/')
    expect(joinPodPath('/', '..')).toBe('/')
  })
})

describe('b64ToBytes', () => {
  it('decodes including embedded newlines (base64 wraps at 76 cols)', () => {
    const bytes = b64ToBytes('aGVs\nbG8g\nd29ybGQ=')
    expect(new TextDecoder().decode(bytes)).toBe('hello world')
  })
})
