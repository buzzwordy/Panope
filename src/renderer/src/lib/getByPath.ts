/** Read a dot-path (e.g. "status.nodeInfo.kubeletVersion") out of an object. */
export function getByPath(obj: unknown, path: string): unknown {
  if (!path) return undefined
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}
