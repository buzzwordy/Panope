import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete'
import { api } from '../api'

/**
 * Field-name completion for the YAML editor, driven by the cluster's own
 * OpenAPI v3 schema. It reads the document's apiVersion/kind, resolves the
 * schema at the cursor's key path (following $ref / allOf / array items), and
 * offers the fields valid at that level with their type and description.
 *
 * Schema-backed, not a token guesser: if the cluster does not serve a schema
 * for the apiVersion, it simply offers nothing.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Schemas = Record<string, any>

const cache = new Map<string, Promise<Schemas | null>>()
function schemasFor(apiVersion: string): Promise<Schemas | null> {
  let p = cache.get(apiVersion)
  if (!p) {
    p = api.openApiSchemas(apiVersion).catch(() => null) as Promise<Schemas | null>
    cache.set(apiVersion, p)
  }
  return p
}

function refName(ref: string): string {
  return ref.split('/').pop() ?? ref
}

/** Follow $ref / allOf down to the concrete object (or array/scalar) schema. */
export function deref(node: any, schemas: Schemas, depth = 0): any {
  if (!node || depth > 20) return node
  if (node.$ref) return deref(schemas[refName(node.$ref)], schemas, depth + 1)
  if (Array.isArray(node.allOf)) {
    for (const m of node.allOf) {
      const d = deref(m, schemas, depth + 1)
      if (d && (d.properties || d.type)) return { description: node.description, ...d }
    }
  }
  return node
}

/** The key path from the document root to the current line, by indentation. */
export function pathToCursor(lines: string[], curIdx: number): string[] {
  // A "- key:" line puts the key after the dash, so its effective indent is the
  // column of the key, not the leading whitespace. Without this the dash line's
  // key is mistaken for a parent of its own sibling fields.
  const keyIndent = (l: string): number => {
    const dash = /^\s*-\s+/.exec(l)
    return dash ? dash[0].length : l.match(/^ */)?.[0].length ?? 0
  }
  const path: string[] = []
  let need = keyIndent(lines[curIdx])
  for (let i = curIdx - 1; i >= 0; i--) {
    const l = lines[i]
    if (!l.trim() || l.trim().startsWith('#')) continue
    const ind = keyIndent(l)
    if (ind < need) {
      const m = /^-?\s*([A-Za-z0-9_.-]+):/.exec(l.trim())
      if (m) path.unshift(m[1])
      need = ind
      if (ind === 0) break
    }
  }
  return path
}

/** Walk the schema down the key path, stepping into array items as needed. */
export function schemaAtPath(root: any, path: string[], schemas: Schemas): any {
  let cur = deref(root, schemas)
  for (const key of path) {
    const child = cur?.properties?.[key] ?? cur?.additionalProperties
    if (!child) return null
    let r = deref(child, schemas)
    if (r?.type === 'array' && r.items) r = deref(r.items, schemas)
    cur = r
  }
  return cur
}

export function findRootSchema(schemas: Schemas, apiVersion: string, kind: string): any {
  const group = apiVersion.includes('/') ? apiVersion.split('/')[0] : ''
  const version = apiVersion.includes('/') ? apiVersion.split('/')[1] : apiVersion
  for (const key of Object.keys(schemas)) {
    const gvks = schemas[key]['x-kubernetes-group-version-kind'] as
      | Array<{ group?: string; version?: string; kind?: string }>
      | undefined
    if (gvks?.some((g) => (g.group ?? '') === group && g.version === version && g.kind === kind)) {
      return schemas[key]
    }
  }
  return null
}

function typeLabel(node: any, schemas: Schemas): string {
  const d = deref(node, schemas)
  if (d?.type === 'array') return `${deref(d.items, schemas)?.type ?? 'object'}[]`
  if (d?.properties || d?.type === 'object') return 'object'
  return d?.type ?? ''
}

/** A CodeMirror async completion source. Returns null when nothing applies. */
export async function yamlSchemaCompletions(ctx: CompletionContext): Promise<CompletionResult | null> {
  const doc = ctx.state.doc
  const full = doc.toString()
  const apiVersion = /^\s*apiVersion:\s*["']?([\w./-]+)/m.exec(full)?.[1]
  const kind = /^\s*kind:\s*["']?([\w.-]+)/m.exec(full)?.[1]
  if (!apiVersion || !kind) return null

  const line = doc.lineAt(ctx.pos)
  const before = line.text.slice(0, ctx.pos - line.from)
  // only when typing a key: indentation, optional "- ", a bare word, no colon yet
  const m = /^(\s*)(-\s*)?([A-Za-z0-9_.-]*)$/.exec(before)
  if (!m) return null
  const word = m[3]
  if (!ctx.explicit && word.length === 0) return null

  const schemas = await schemasFor(apiVersion)
  if (!schemas) return null
  const root = findRootSchema(schemas, apiVersion, kind)
  if (!root) return null

  const lines: string[] = []
  for (let i = 1; i <= doc.lines; i++) lines.push(doc.line(i).text)
  const path = pathToCursor(lines, line.number - 1)
  const node = schemaAtPath(root, path, schemas)
  const props = node?.properties as Record<string, any> | undefined
  if (!props) return null

  // don't re-suggest keys already present as siblings at this indent
  const indent = m[1].length
  const siblings = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    if (i === line.number - 1) continue
    const l = lines[i]
    if ((l.match(/^ */)?.[0].length ?? 0) !== indent) continue
    const km = /^-?\s*([A-Za-z0-9_.-]+):/.exec(l.trim())
    if (km) siblings.add(km[1])
  }

  const options: Completion[] = Object.keys(props)
    .filter((k) => !siblings.has(k))
    .map((k) => ({
      label: k,
      type: 'property',
      detail: typeLabel(props[k], schemas),
      info: (deref(props[k], schemas)?.description as string | undefined) ?? undefined,
      apply: `${k}: `
    }))
  if (!options.length) return null
  return { from: ctx.pos - word.length, options, validFor: /^[\w.-]*$/ }
}
