import { describe, it, expect } from 'vitest'
import type { K8sObject, MetricSample } from '@shared/types'
import { analyzePods, severityRank } from './rightsize'

function runningPod(opts: {
  ns?: string
  name: string
  containers: Array<{ name: string; requests?: Record<string, string>; limits?: Record<string, string> }>
  statuses?: Array<{ name: string; restartCount?: number; oom?: boolean }>
  owner?: { kind: string; name: string }
}): K8sObject {
  return {
    metadata: {
      namespace: opts.ns ?? 'default',
      name: opts.name,
      ownerReferences: opts.owner ? [{ ...opts.owner, uid: 'u1' }] : undefined
    },
    spec: {
      containers: opts.containers.map((c) => ({
        name: c.name,
        resources: { requests: c.requests, limits: c.limits }
      }))
    },
    status: {
      phase: 'Running',
      containerStatuses: (opts.statuses ?? []).map((s) => ({
        name: s.name,
        restartCount: s.restartCount ?? 0,
        lastState: s.oom ? { terminated: { reason: 'OOMKilled' } } : {}
      }))
    }
  } as unknown as K8sObject
}

function metricsOf(entries: Array<[string, number, number]>): Map<string, MetricSample> {
  const m = new Map<string, MetricSample>()
  for (const [key, cpu, memory] of entries) {
    const [ns, name] = key.split('/')
    m.set(key, { namespace: ns, name, cpu, memory })
  }
  return m
}

describe('analyzePods', () => {
  it('flags over-provisioned containers (<10% of request used)', () => {
    const pods = [runningPod({ name: 'idle', containers: [{ name: 'app', requests: { cpu: '1000m', memory: '1Gi' } }] })]
    const rows = analyzePods(pods, metricsOf([['default/idle', 20, 40 * 1024 * 1024]]))
    expect(rows).toHaveLength(1)
    expect(rows[0].cpuPct).toBe(2)
    expect(rows[0].issues).toContain('cpu-overprovisioned')
    expect(rows[0].issues).toContain('mem-overprovisioned')
  })

  it('flags containers near their request (>90%)', () => {
    const pods = [runningPod({ name: 'hot', containers: [{ name: 'app', requests: { cpu: '100m', memory: '100Mi' } }] })]
    const rows = analyzePods(pods, metricsOf([['default/hot', 95, 99 * 1024 * 1024]]))
    expect(rows[0].issues).toContain('cpu-underprovisioned')
    expect(rows[0].issues).toContain('mem-underprovisioned')
  })

  it('flags missing requests and limits, with null percentages', () => {
    const pods = [runningPod({ name: 'naked', containers: [{ name: 'app' }] })]
    const rows = analyzePods(pods, metricsOf([['default/naked', 50, 1024]]))
    expect(rows[0].issues).toContain('no-requests')
    expect(rows[0].issues).toContain('no-limits')
    expect(rows[0].cpuPct).toBeNull()
    // pod usage still attributed (evenly) even without requests
    expect(rows[0].cpuUsage).toBe(50)
  })

  it('splits pod usage across containers proportionally to requests', () => {
    const pods = [
      runningPod({
        name: 'multi',
        containers: [
          { name: 'big', requests: { cpu: '300m' } },
          { name: 'small', requests: { cpu: '100m' } }
        ]
      })
    ]
    const rows = analyzePods(pods, metricsOf([['default/multi', 200, 0]]))
    const big = rows.find((r) => r.container === 'big')!
    const small = rows.find((r) => r.container === 'small')!
    expect(big.cpuUsage).toBe(150)
    expect(small.cpuUsage).toBe(50)
  })

  it('reports OOMKilled from lastState and records the owner', () => {
    const pods = [
      runningPod({
        name: 'oomy',
        containers: [{ name: 'app', requests: { memory: '64Mi' } }],
        statuses: [{ name: 'app', restartCount: 7, oom: true }],
        owner: { kind: 'Deployment', name: 'api' }
      })
    ]
    const rows = analyzePods(pods, new Map())
    expect(rows[0].oomKilled).toBe(true)
    expect(rows[0].issues).toContain('oom-killed')
    expect(rows[0].restarts).toBe(7)
    expect(rows[0].owner).toBe('Deployment/api')
  })

  it('skips non-running pods', () => {
    const done = runningPod({ name: 'job', containers: [{ name: 'app' }] })
    ;(done.status as Record<string, unknown>).phase = 'Succeeded'
    expect(analyzePods([done], new Map())).toHaveLength(0)
  })
})

describe('severityRank', () => {
  it('orders OOM < underprovisioned < no-requests < overprovisioned < no-limits < clean', () => {
    const mk = (issues: string[]): number =>
      severityRank({ issues } as unknown as Parameters<typeof severityRank>[0])
    expect(mk(['oom-killed'])).toBeLessThan(mk(['mem-underprovisioned']))
    expect(mk(['mem-underprovisioned'])).toBeLessThan(mk(['no-requests']))
    expect(mk(['no-requests'])).toBeLessThan(mk(['cpu-overprovisioned']))
    expect(mk(['cpu-overprovisioned'])).toBeLessThan(mk(['no-limits']))
    expect(mk(['no-limits'])).toBeLessThan(mk([]))
  })
})
