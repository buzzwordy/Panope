import type { KubernetesService } from '../main/kube/client'
import type { K8sObject } from '../shared/types'
import { parseCpuToMillicores, parseMemoryToBytes } from '../shared/quantity'

/**
 * Alerting for the in-cluster deployment.
 *
 * Two sources, deliberately:
 *  - built-in rules over the same conditions the dashboard computes, for the
 *    things Prometheus usually does NOT cover (GitOps drift, sync failures,
 *    provider health, pod-slot exhaustion);
 *  - an optional Alertmanager reader, so we surface the rules you already
 *    maintain rather than duplicating them.
 *
 * Every alert is deduplicated by a stable key and re-sent only after a
 * cooldown, so a persistent problem doesn't spam the channel.
 */

export type Severity = 'warning' | 'critical'

export interface Alert {
  key: string
  severity: Severity
  title: string
  detail: string
  source: 'panope' | 'alertmanager'
}

interface Config {
  enabled: boolean
  intervalMs: number
  cooldownMs: number
  webhookUrl?: string
  slackWebhookUrl?: string
  /** Zero or more Alertmanagers to aggregate (comma/space/newline separated in env). */
  alertmanagerUrls: string[]
  cpuWarnPct: number
  memWarnPct: number
  podSlotWarnPct: number
  restartThreshold: number
}

function config(): Config {
  return {
    enabled: process.env.PANOPE_ALERTS === 'true',
    intervalMs: Number(process.env.PANOPE_ALERT_INTERVAL_MS || 60_000),
    cooldownMs: Number(process.env.PANOPE_ALERT_COOLDOWN_MS || 30 * 60_000),
    webhookUrl: process.env.PANOPE_ALERT_WEBHOOK,
    slackWebhookUrl: process.env.PANOPE_ALERT_SLACK_WEBHOOK,
    // Accept one or many: "url1,url2" or whitespace-separated. Back-compat with
    // the old single PANOPE_ALERTMANAGER_URL.
    alertmanagerUrls: [process.env.PANOPE_ALERTMANAGER_URLS, process.env.PANOPE_ALERTMANAGER_URL]
      .filter(Boolean)
      .join(',')
      .split(/[\s,]+/)
      .map((u) => u.trim())
      .filter(Boolean),
    cpuWarnPct: Number(process.env.PANOPE_ALERT_CPU_PCT || 90),
    memWarnPct: Number(process.env.PANOPE_ALERT_MEM_PCT || 90),
    podSlotWarnPct: Number(process.env.PANOPE_ALERT_PODSLOT_PCT || 90),
    restartThreshold: Number(process.env.PANOPE_ALERT_RESTARTS || 10)
  }
}

const get = (o: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], o)

function podStatusOf(p: K8sObject): string {
  const waiting = ((get(p, 'status.containerStatuses') as Array<{ state?: { waiting?: { reason?: string } } }>) ?? [])
    .map((c) => c.state?.waiting?.reason)
    .find(Boolean)
  return waiting || ((get(p, 'status.phase') as string) ?? 'Unknown')
}

/** Evaluate every built-in rule against the current cluster state. */
export async function evaluate(svc: KubernetesService, cfg: Config): Promise<Alert[]> {
  const alerts: Alert[] = []
  const [nodes, pods, metrics] = await Promise.all([
    svc.listResource('nodes').catch(() => null),
    svc.listResource('pods').catch(() => null),
    svc.getMetrics('nodes').catch(() => null)
  ])

  // --- node readiness + capacity ---
  if (nodes) {
    let cpuTotal = 0
    let memTotal = 0
    let podCapacity = 0
    for (const n of nodes.items) {
      const name = n.metadata?.name ?? ''
      const conds = (get(n, 'status.conditions') as Array<{ type?: string; status?: string }>) ?? []
      if (!conds.some((c) => c.type === 'Ready' && c.status === 'True')) {
        alerts.push({
          key: `node-notready/${name}`,
          severity: 'critical',
          title: `Node ${name} is NotReady`,
          detail: 'The kubelet is not reporting Ready.',
          source: 'panope'
        })
      }
      for (const c of conds) {
        if (c.type !== 'Ready' && c.status === 'True') {
          alerts.push({
            key: `node-pressure/${name}/${c.type}`,
            severity: 'warning',
            title: `Node ${name}: ${c.type}`,
            detail: `Node condition ${c.type} is True.`,
            source: 'panope'
          })
        }
      }
      cpuTotal += parseCpuToMillicores(get(n, 'status.allocatable.cpu') as string)
      memTotal += parseMemoryToBytes(get(n, 'status.allocatable.memory') as string)
      podCapacity += Number(get(n, 'status.allocatable.pods') ?? 0)
    }

    if (metrics?.available) {
      const cpuUsed = metrics.samples.reduce((a, s) => a + s.cpu, 0)
      const memUsed = metrics.samples.reduce((a, s) => a + s.memory, 0)
      const cpuPct = cpuTotal ? (cpuUsed / cpuTotal) * 100 : 0
      const memPct = memTotal ? (memUsed / memTotal) * 100 : 0
      if (cpuPct >= cfg.cpuWarnPct)
        alerts.push({
          key: 'cluster-cpu',
          severity: 'warning',
          title: `Cluster CPU at ${Math.round(cpuPct)}%`,
          detail: `Threshold is ${cfg.cpuWarnPct}%.`,
          source: 'panope'
        })
      if (memPct >= cfg.memWarnPct)
        alerts.push({
          key: 'cluster-mem',
          severity: 'warning',
          title: `Cluster memory at ${Math.round(memPct)}%`,
          detail: `Threshold is ${cfg.memWarnPct}%.`,
          source: 'panope'
        })
    }

    if (pods && podCapacity) {
      const slotPct = (pods.items.length / podCapacity) * 100
      if (slotPct >= cfg.podSlotWarnPct)
        alerts.push({
          key: 'cluster-podslots',
          severity: 'warning',
          title: `Pod slots ${pods.items.length}/${podCapacity} (${Math.round(slotPct)}%)`,
          detail: 'Nothing new will schedule once slots run out, regardless of spare CPU or memory.',
          source: 'panope'
        })
    }
  }

  // --- unhealthy pods + restart storms ---
  if (pods) {
    for (const p of pods.items) {
      const ns = p.metadata?.namespace
      const name = p.metadata?.name
      const st = podStatusOf(p)
      if (/CrashLoopBackOff|ImagePullBackOff|ErrImagePull|OOMKilled|CreateContainerConfigError/.test(st)) {
        alerts.push({
          key: `pod-unhealthy/${ns}/${name}/${st}`,
          severity: 'critical',
          title: `${ns}/${name} is ${st}`,
          detail: 'Pod is not running healthily.',
          source: 'panope'
        })
      }
      const restarts = ((get(p, 'status.containerStatuses') as Array<{ restartCount?: number }>) ?? []).reduce(
        (n, c) => n + (c.restartCount ?? 0),
        0
      )
      if (restarts >= cfg.restartThreshold) {
        alerts.push({
          key: `pod-restarts/${ns}/${name}`,
          severity: 'warning',
          title: `${ns}/${name} restarted ${restarts}x`,
          detail: `At or above the threshold of ${cfg.restartThreshold}.`,
          source: 'panope'
        })
      }
    }
  }

  // --- GitOps drift / failed syncs (the gap Prometheus usually leaves) ---
  try {
    const crds = await svc.listCRDs()
    const argo = crds.find((c) => c.group === 'argoproj.io' && c.kind === 'Application')
    if (argo) {
      const apps = await svc.listCustom({
        group: argo.group,
        version: argo.version,
        plural: argo.plural,
        namespaced: argo.namespaced
      })
      for (const a of apps.items) {
        const name = `${a.metadata?.namespace}/${a.metadata?.name}`
        const phase = (get(a, 'status.operationState.phase') as string) ?? ''
        const health = (get(a, 'status.health.status') as string) ?? ''
        if (/Failed|Error/i.test(phase))
          alerts.push({
            key: `argo-syncfail/${name}`,
            severity: 'critical',
            title: `ArgoCD sync failed: ${name}`,
            detail: String(get(a, 'status.operationState.message') ?? phase),
            source: 'panope'
          })
        else if (health === 'Degraded')
          alerts.push({
            key: `argo-degraded/${name}`,
            severity: 'warning',
            title: `ArgoCD app degraded: ${name}`,
            detail: 'Application health is Degraded.',
            source: 'panope'
          })
      }
    }
  } catch {
    /* no ArgoCD on this cluster, or no permission - not an alert */
  }

  return alerts
}

/** Pull currently-firing alerts from ONE Alertmanager. */
export async function fromAlertmanager(url: string): Promise<Alert[]> {
  const base = url.replace(/\/$/, '')
  const res = await fetch(`${base}/api/v2/alerts?active=true&silenced=false&inhibited=false`)
  if (!res.ok) throw new Error(`alertmanager HTTP ${res.status}`)
  const list = (await res.json()) as Array<{
    labels?: Record<string, string>
    annotations?: Record<string, string>
    fingerprint?: string
  }>
  // Prefix keys with the source host so identical alertnames from different
  // Alertmanagers don't collide in the dedupe map.
  let origin = base
  try {
    origin = new URL(base).host
  } catch {
    /* keep raw */
  }
  return list.map((a) => ({
    key: `am/${origin}/${a.fingerprint ?? a.labels?.alertname ?? 'unknown'}`,
    severity: a.labels?.severity === 'critical' ? 'critical' : 'warning',
    title: a.annotations?.summary || a.labels?.alertname || 'Alert',
    detail: `${a.annotations?.description || JSON.stringify(a.labels ?? {})}  (${origin})`,
    source: 'alertmanager' as const
  }))
}

/** Aggregate every configured Alertmanager; a failing one is logged, not fatal. */
export async function fromAlertmanagers(urls: string[]): Promise<Alert[]> {
  const results = await Promise.all(
    urls.map((u) =>
      fromAlertmanager(u).catch((e) => {
        console.error(`[alerts] alertmanager read failed (${u}):`, e instanceof Error ? e.message : e)
        return [] as Alert[]
      })
    )
  )
  return results.flat()
}

async function deliver(alerts: Alert[], cfg: Config): Promise<void> {
  if (!alerts.length) return
  const lines = alerts.map((a) => `${a.severity === 'critical' ? '🔴' : '🟠'} *${a.title}* - ${a.detail}`)

  if (cfg.slackWebhookUrl) {
    await fetch(cfg.slackWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `Panope alerts\n${lines.join('\n')}` })
    }).catch((e) => console.error('[alerts] slack delivery failed:', e))
  }
  if (cfg.webhookUrl) {
    await fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alerts })
    }).catch((e) => console.error('[alerts] webhook delivery failed:', e))
  }
  if (!cfg.slackWebhookUrl && !cfg.webhookUrl) {
    for (const a of alerts) console.log(`[alert] ${a.severity} ${a.title} - ${a.detail}`)
  }
}

/** Most recent evaluation, exposed to the UI. */
let current: Alert[] = []
export const currentAlerts = (): Alert[] => current

export function startAlerting(svc: KubernetesService): void {
  const cfg = config()
  if (!cfg.enabled) return
  const lastSent = new Map<string, number>()

  const tick = async (): Promise<void> => {
    try {
      const built = await evaluate(svc, cfg)
      const external = cfg.alertmanagerUrls.length ? await fromAlertmanagers(cfg.alertmanagerUrls) : []
      current = [...built, ...external]

      // Only deliver what we haven't delivered recently.
      const now = Date.now()
      const fresh = current.filter((a) => now - (lastSent.get(a.key) ?? 0) > cfg.cooldownMs)
      for (const a of fresh) lastSent.set(a.key, now)
      // Forget keys that stopped firing so recovery + recurrence alerts again.
      const live = new Set(current.map((a) => a.key))
      for (const k of [...lastSent.keys()]) if (!live.has(k)) lastSent.delete(k)

      await deliver(fresh, cfg)
    } catch (e) {
      console.error('[alerts] evaluation failed:', e)
    }
  }

  console.log(`[alerts] enabled - every ${cfg.intervalMs / 1000}s, cooldown ${cfg.cooldownMs / 60000}m`)
  void tick()
  setInterval(tick, cfg.intervalMs)
}
