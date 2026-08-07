import type { KubeconfigFile } from '../../shared/types'

/**
 * Merging several kubeconfig files into one view.
 *
 * Kept free of any I/O and of @kubernetes/client-node so the rule itself can be
 * tested directly. The library's own KubeConfig.mergeConfig is deliberately not
 * used: its addCluster/addUser/addContext THROW on a duplicate name, and two
 * unrelated kubeconfigs sharing a cluster called "kubernetes" or a context
 * called "default" is entirely routine - one collision would discard every file
 * after it.
 */

export interface NamedEntry {
  name: string
  [key: string]: unknown
}

export interface RawContext extends NamedEntry {
  cluster?: string
  user?: string
  namespace?: string
}

export interface RawKubeconfig {
  clusters?: NamedEntry[]
  users?: NamedEntry[]
  contexts?: RawContext[]
  currentContext?: string
}

/** One file's parse outcome. `config` absent means it failed; `error` says why. */
export interface MergeInput {
  path: string
  isDefault: boolean
  config?: RawKubeconfig
  error?: string
}

export interface MergeResult {
  clusters: NamedEntry[]
  users: NamedEntry[]
  contexts: RawContext[]
  currentContext: string
  /** per-file diagnostics, in input order */
  report: KubeconfigFile[]
  /** context name -> the file that supplied it */
  source: Map<string, string>
}

/**
 * Union the files, resolving name collisions in favour of the EARLIER file -
 * the rule kubectl applies to a multi-path $KUBECONFIG.
 *
 * A later file's shadowed context names are recorded rather than dropped
 * silently: "my context is missing" is otherwise unexplainable from the UI.
 */
export function mergeKubeconfigs(inputs: MergeInput[]): MergeResult {
  const clusters: NamedEntry[] = []
  const users: NamedEntry[] = []
  const contexts: RawContext[] = []
  const haveCluster = new Set<string>()
  const haveUser = new Set<string>()
  const haveContext = new Set<string>()
  const report: KubeconfigFile[] = []
  const source = new Map<string, string>()
  let currentContext = ''

  for (const input of inputs) {
    const entry: KubeconfigFile = {
      path: input.path,
      ok: !!input.config,
      isDefault: input.isDefault,
      contexts: [],
      shadowed: []
    }
    if (!input.config) {
      entry.error = input.error ?? 'Could not read this file.'
      report.push(entry)
      continue
    }

    for (const c of input.config.clusters ?? []) {
      if (haveCluster.has(c.name)) continue
      haveCluster.add(c.name)
      clusters.push(c)
    }
    for (const u of input.config.users ?? []) {
      if (haveUser.has(u.name)) continue
      haveUser.add(u.name)
      users.push(u)
    }
    for (const ctx of input.config.contexts ?? []) {
      if (haveContext.has(ctx.name)) {
        entry.shadowed.push(ctx.name)
        continue
      }
      haveContext.add(ctx.name)
      contexts.push(ctx)
      entry.contexts.push(ctx.name)
      source.set(ctx.name, input.path)
    }
    if (!currentContext && input.config.currentContext) currentContext = input.config.currentContext

    report.push(entry)
  }

  return { clusters, users, contexts, currentContext, report, source }
}
