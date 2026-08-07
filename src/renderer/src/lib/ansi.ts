// Minimal ANSI SGR parser for log rendering: colors + bold/dim/italic/underline.
// Non-SGR escape sequences (cursor moves, erase, OSC titles) are stripped.

export interface AnsiSegment {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

// Standard 16-color palette tuned for dark backgrounds (xterm-ish).
const BASE: string[] = [
  '#3f4451', // black
  '#e05561', // red
  '#8cc265', // green
  '#d18f52', // yellow
  '#4aa5f0', // blue
  '#c162de', // magenta
  '#42b3c2', // cyan
  '#d7dae0', // white
  '#4f5666', // bright black
  '#ff616e', // bright red
  '#a5e075', // bright green
  '#f0a45d', // bright yellow
  '#4dc4ff', // bright blue
  '#de73ff', // bright magenta
  '#4cd1e0', // bright cyan
  '#e6e6e6' // bright white
]

/** xterm 256-color index -> hex. */
function color256(n: number): string {
  if (n < 16) return BASE[n] ?? '#d7dae0'
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return `rgb(${v},${v},${v})`
  }
  const i = n - 16
  const steps = [0, 95, 135, 175, 215, 255]
  const r = steps[Math.floor(i / 36) % 6]
  const g = steps[Math.floor(i / 6) % 6]
  const b = steps[i % 6]
  return `rgb(${r},${g},${b})`
}

interface Style {
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

function applySgr(style: Style, params: number[]): Style {
  const s = { ...style }
  for (let i = 0; i < params.length; i++) {
    const p = params[i]
    if (p === 0) return {}
    else if (p === 1) s.bold = true
    else if (p === 2) s.dim = true
    else if (p === 3) s.italic = true
    else if (p === 4) s.underline = true
    else if (p === 21 || p === 22) {
      delete s.bold
      delete s.dim
    } else if (p === 23) delete s.italic
    else if (p === 24) delete s.underline
    else if (p >= 30 && p <= 37) s.fg = BASE[p - 30]
    else if (p >= 90 && p <= 97) s.fg = BASE[p - 90 + 8]
    else if (p === 39) delete s.fg
    else if (p >= 40 && p <= 47) s.bg = BASE[p - 40]
    else if (p >= 100 && p <= 107) s.bg = BASE[p - 100 + 8]
    else if (p === 49) delete s.bg
    else if (p === 38 || p === 48) {
      // extended color: 38;5;n or 38;2;r;g;b
      const target = p === 38 ? 'fg' : 'bg'
      if (params[i + 1] === 5 && params[i + 2] !== undefined) {
        s[target] = color256(params[i + 2])
        i += 2
      } else if (params[i + 1] === 2 && params[i + 4] !== undefined) {
        s[target] = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`
        i += 4
      }
    }
  }
  return s
}

// SGR sequences we interpret; everything else escape-ish gets stripped.
const SGR = /\x1b\[([0-9;]*)m/
const OTHER_ESC = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-9;?]*[A-LN-Za-ln-z]|[@-Z\\-_])/g

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '').replace(OTHER_ESC, '')
}

/** Parse one line into styled segments. Lines without ESC return one segment. */
export function parseAnsi(line: string): AnsiSegment[] {
  if (!line.includes('\x1b')) return [{ text: line }]
  const clean = line.replace(OTHER_ESC, '')
  const segments: AnsiSegment[] = []
  let style: Style = {}
  let rest = clean
  while (rest.length) {
    const m = SGR.exec(rest)
    if (!m) {
      segments.push({ text: rest, ...style })
      break
    }
    if (m.index > 0) segments.push({ text: rest.slice(0, m.index), ...style })
    const params = m[1] === '' ? [0] : m[1].split(';').map((n) => parseInt(n, 10) || 0)
    style = applySgr(style, params)
    rest = rest.slice(m.index + m[0].length)
  }
  return segments.filter((s) => s.text.length > 0)
}
