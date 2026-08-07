/**
 * Strip material that must never leave the process for a model endpoint.
 *
 * Secret values are replaced with a size marker (the model can still reason
 * about which keys exist and how big they are). The last-applied annotation is
 * dropped from Secrets because kubectl stores a full copy of the object there,
 * values included. managedFields goes for every kind - pure token noise.
 */

const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration'

function redactMap(obj: Record<string, unknown>, field: string): void {
  const d = obj[field]
  if (!d || typeof d !== 'object') return
  const m = d as Record<string, unknown>
  for (const k of Object.keys(m)) {
    m[k] = `<redacted ${String(m[k] ?? '').length} bytes>`
  }
}

/** In-place. `isSecret` covers list items, which often lack a kind of their own. */
function scrub(obj: Record<string, unknown>, isSecret: boolean): void {
  const meta = obj.metadata as Record<string, unknown> | undefined
  if (meta) {
    delete meta.managedFields
    const ann = meta.annotations as Record<string, unknown> | undefined
    if (ann && (isSecret || obj.kind === 'Secret')) delete ann[LAST_APPLIED]
  }
  if (isSecret || obj.kind === 'Secret') {
    redactMap(obj, 'data')
    redactMap(obj, 'stringData')
  }
  if (Array.isArray(obj.items)) {
    for (const i of obj.items) {
      if (i && typeof i === 'object') scrub(i as Record<string, unknown>, isSecret)
    }
  }
}

/** Deep-copies, so callers can hand over live cache objects safely. */
export function redactForModel<T>(value: T, isSecret: boolean): T {
  if (!value || typeof value !== 'object') return value
  const copy = JSON.parse(JSON.stringify(value)) as T
  if (Array.isArray(copy)) {
    for (const i of copy) {
      if (i && typeof i === 'object') scrub(i as Record<string, unknown>, isSecret)
    }
  } else {
    scrub(copy as Record<string, unknown>, isSecret)
  }
  return copy
}

const SENSITIVE_KEY = /(password|passwd|secret|token|api[_-]?key|access[_-]?key|credential|cert|private[_-]?key)/i

/**
 * Heuristic mask for helm values YAML: any scalar whose key sounds like a
 * credential gets replaced. Coarser than the Secret redactor by design -
 * values files are freeform, so key names are all there is to go on.
 */
export function redactValuesYaml(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const m = /^(\s*(?:- )?)([A-Za-z0-9_.-]+)(\s*:\s*)(\S.*)$/.exec(line)
      if (!m || !SENSITIVE_KEY.test(m[2])) return line
      const value = m[4].trim()
      if (value === '' || value === '{}' || value === '[]' || value === '|' || value === '>') return line
      return `${m[1]}${m[2]}${m[3]}<redacted>`
    })
    .join('\n')
}
