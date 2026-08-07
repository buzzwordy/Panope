// Parsers for Kubernetes resource.Quantity strings.
// CPU is normalized to millicores; memory to bytes.

/** Parse a CPU quantity ("100m", "2", "250000000n", "1500u") into millicores. */
export function parseCpuToMillicores(q: string | number | undefined): number {
  if (q === undefined || q === null) return 0
  if (typeof q === 'number') return q * 1000
  const s = q.trim()
  if (s === '') return 0
  const m = s.match(/^([0-9.eE+-]+)([a-zµμ]*)$/)
  if (!m) return 0
  const val = parseFloat(m[1])
  if (Number.isNaN(val)) return 0
  switch (m[2]) {
    case 'n':
      return val / 1e6
    case 'u':
    case 'µ':
    case 'μ':
      return val / 1e3
    case 'm':
      return val
    case '':
      return val * 1000
    case 'k':
      return val * 1000 * 1000
    default:
      return val * 1000
  }
}

const BINARY: Record<string, number> = {
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60
}
const DECIMAL: Record<string, number> = {
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18
}

/** Parse a memory quantity ("128Mi", "1Gi", "1000000", "500M") into bytes. */
export function parseMemoryToBytes(q: string | number | undefined): number {
  if (q === undefined || q === null) return 0
  if (typeof q === 'number') return q
  const s = q.trim()
  if (s === '') return 0
  const m = s.match(/^([0-9.eE+-]+)([a-zA-Z]*)$/)
  if (!m) return 0
  const val = parseFloat(m[1])
  if (Number.isNaN(val)) return 0
  const suffix = m[2]
  if (suffix === '') return val
  if (BINARY[suffix]) return val * BINARY[suffix]
  if (DECIMAL[suffix]) return val * DECIMAL[suffix]
  // exponent notation like "1e3" leaves no suffix; anything else -> raw
  return val
}
