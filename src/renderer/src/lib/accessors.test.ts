import { describe, it, expect } from 'vitest'
import type { K8sObject } from '@shared/types'
import { statusVariant, podStatus, COMPUTE } from './accessors'

describe('statusVariant', () => {
  it('maps healthy states to running', () => {
    expect(statusVariant('Running')).toBe('running')
    expect(statusVariant('Active')).toBe('running')
    expect(statusVariant('Bound')).toBe('running')
    expect(statusVariant('True')).toBe('running')
  })
  it('maps terminal-success states to succeeded', () => {
    expect(statusVariant('Succeeded')).toBe('succeeded')
    expect(statusVariant('Completed')).toBe('succeeded')
  })
  it('maps error states to failed', () => {
    expect(statusVariant('CrashLoopBackOff')).toBe('failed')
    expect(statusVariant('ImagePullBackOff')).toBe('failed')
    expect(statusVariant('OOMKilled')).toBe('failed')
    expect(statusVariant('Error')).toBe('failed')
  })
  it('maps in-flight states to pending', () => {
    expect(statusVariant('Pending')).toBe('pending')
    expect(statusVariant('ContainerCreating')).toBe('pending')
    expect(statusVariant('Terminating')).toBe('pending')
  })
  it('defaults to unknown', () => {
    expect(statusVariant('')).toBe('unknown')
    expect(statusVariant('SomethingElse')).toBe('unknown')
  })
})

function pod(
  status: Record<string, unknown>,
  meta: Record<string, unknown> = {},
  spec: Record<string, unknown> = {}
): K8sObject {
  return { metadata: meta, spec, status } as unknown as K8sObject
}

describe('podStatus', () => {
  it('reports Terminating when a deletionTimestamp is set', () => {
    expect(podStatus(pod({ phase: 'Running' }, { deletionTimestamp: '2020-01-01T00:00:00Z' }))).toBe('Terminating')
  })
  it('reports the phase for a plain pending pod', () => {
    expect(podStatus(pod({ phase: 'Pending' }))).toBe('Pending')
  })
  it('surfaces a waiting container reason', () => {
    expect(
      podStatus(pod({ phase: 'Running', containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }] }))
    ).toBe('CrashLoopBackOff')
  })
  it('reports a running & ready pod as Running', () => {
    expect(
      podStatus(pod({ phase: 'Running', containerStatuses: [{ ready: true, state: { running: {} } }] }))
    ).toBe('Running')
  })
  it('prefixes init-container failures with Init:', () => {
    expect(
      podStatus(
        pod({
          phase: 'Pending',
          initContainerStatuses: [{ state: { terminated: { reason: 'Error', exitCode: 1 } } }]
        })
      )
    ).toBe('Init:Error')
  })
  it('does not treat a started native sidecar as initializing', () => {
    const p = pod(
      {
        phase: 'Running',
        initContainerStatuses: [
          { name: 'bootstrap', ready: true, state: { terminated: { reason: 'Completed', exitCode: 0 } } },
          { name: 'sidecar', ready: true, started: true, state: { running: {} } }
        ],
        containerStatuses: [{ name: 'main', ready: true, state: { running: {} } }]
      },
      {},
      { initContainers: [{ name: 'bootstrap' }, { name: 'sidecar', restartPolicy: 'Always' }] }
    )
    expect(podStatus(p)).toBe('Running')
    expect(COMPUTE['pod.ready'](p)).toBe('2/2')
  })
  it('still reports a not-yet-started sidecar as initializing', () => {
    const p = pod(
      {
        phase: 'Pending',
        initContainerStatuses: [{ name: 'sidecar', started: false, state: { waiting: { reason: 'PodInitializing' } } }]
      },
      {},
      { initContainers: [{ name: 'sidecar', restartPolicy: 'Always' }] }
    )
    expect(podStatus(p)).toBe('Init:0/1')
  })
})
