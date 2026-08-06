<p align="center">
  <img src="docs/logo.svg" alt="Panope" width="420">
</p>

<p align="center">
  <strong>A desktop <em>and</em> in-cluster client for Kubernetes.</strong>
</p>

<p align="center">
  <a href="https://github.com/buzzwordy/Panope/actions/workflows/ci.yml"><img src="https://github.com/buzzwordy/Panope/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL_v3-blue.svg" alt="License: AGPL v3"></a>
  <img src="https://img.shields.io/badge/Electron-43-47848F?logo=electron&logoColor=white" alt="Electron 43">
</p>

The desktop app is an Electron shell with a React + TypeScript renderer talking
to your cluster through `@kubernetes/client-node` in the main process. The same
renderer ships as an in-cluster web app behind OIDC login and per-user
impersonation, over an identical RPC + WebSocket transport - so every screen has
exactly one implementation.

![Pods view](docs/pods.png)

| ArgoCD | YAML editor | Logs |
| --- | --- | --- |
| ![ArgoCD](docs/argocd.png) | ![YAML editor](docs/yaml-editor.png) | ![Logs](docs/logs.png) |
| **Terminal** | **Create** | |
| ![Terminal](docs/terminal.png) | ![Create](docs/create.png) | |

CRDs divided by API group, and automatic port-forwarding:

| CRD groups | CRD group expanded | Port forward |
| --- | --- | --- |
| ![CRD groups](docs/crd-groups.png) | ![CRD expanded](docs/crd-expanded.png) | ![Port forward](docs/port-forward.png) |

Drill-down management in the main area:

| Deployment -> its Pods | Pod management |
| --- | --- |
| ![Deployment pods](docs/deployment-pods.png) | ![Pod management](docs/pod-management.png) |

## Features

- **Grouped resource navigation** - Infrastructure, Workloads, Configuration,
  Networking, Storage, Applications, Users - 31 built-in kinds, with live item
  counts in the sidebar.
- **All CRDs, dynamically** - every `CustomResourceDefinition` on the cluster is
  discovered and, under **Custom Resources**, **divided into collapsible sections
  by API group** (e.g. `longhorn.io`, `monitoring.coreos.com`, `traefik.io`),
  each with a kind count - no giant flat list. Browsable/watchable like built-ins.
- **ArgoCD** - `argoproj.io` CRDs get a dedicated **ArgoCD** section, and
  Applications render with **Sync** / **Health** status pills, project, and
  revision columns.
- **Live resource tables** - initial `list` + a self-healing `watch` stream, so
  rows add / update / remove in real time; per-kind columns.
- **Drill-down management (main-area, not a side drawer)** - clicking a row opens
  a full-page, Kubernetic-style management view (breadcrumb `Kind / name`) with
  icon tabs:
  - **Pod** -> Status · Specifications · View · Labels · Logs · Terminal · Ports · Events
  - **Node** -> Status · Specifications · View · Labels · Images · Events
  - **Workload** (Deploy/STS/DS/RS/RC/Job) -> Status · **Pods** (its own pods) · Specifications · View · Labels · Events; click a pod to drill in.
  - **Status** = the object as a single table row; **Specifications** = rich
    key/value (+ node conditions & addresses, pod containers); **View** = editable
    YAML; **Labels** = labels + annotations; **Images** = node image list.
  - header actions per kind: **Restart** (rolling restart for Deploy/STS/DS),
    **Scale**, **Edit**, **Delete**. Back navigates up the drill-down.
- **Metrics** - CPU / memory usage bars for Pods and Nodes via `metrics.k8s.io`.
  Bars are scaled to a real denominator - **% of the pod's limit/request** (or the
  **node's allocatable**) - and show that percentage; sortable; `-` without
  metrics-server. Falls back to a comparative bar (no %) when no limit is set.
- **Pod tooling** in the management view:
  - **Logs** - live streaming (follow, per-line filter, container switch, timestamps).
  - **Terminal** - interactive `exec` via a real xterm.js PTY with live resize.
  - **Port forward (automatic)** - one-click **Forward & open**: the local port
    defaults to the remote port (kubectl-style) and falls back to any free port
    if taken, then the browser opens automatically. **Forward all** does every
    declared port at once; a global manager lists/stops active tunnels.
- **Edit & apply** - every resource opens a CodeMirror YAML editor; **Apply**
  uses server-side apply (field manager `panope`).
- **Create / Delete / Scale** - a Create modal with resource templates
  (Namespace, ConfigMap, Deployment, Service...), row/drawer delete with confirm,
  and Scale for Deployments/StatefulSets/ReplicaSets/RCs.
- **Events** - per-object event timeline in the drawer.
- **Status intelligence** - kubectl-style Pod status (`CrashLoopBackOff`,
  `Init:...`, `Terminating`, `Completed`), node readiness, PV/PVC/Job phases,
  ArgoCD sync/health - all as colored pills.
- **Context & namespace switching**, new-namespace shortcut, label filtering,
  text search, sortable columns, favorites, saved views (named filter + column
  combinations per resource), light / dark theme.
- **Access ("can I?")** - a verb x resource matrix answered by the authorizer
  itself (`SelfSubjectAccessReview`), plus a precise single check with the
  authorizer's reason, and "check as user/group" via `SubjectAccessReview`.
- **Audit** - every mutation performed through Panope (who / what / when /
  outcome). Desktop: persisted locally across restarts. In-cluster: shared
  per-deployment ring plus one greppable `[audit]` line per action on stdout
  for the cluster's log pipeline.
- **Right-sizing** - measured usage vs declared requests per container:
  OOM-killed, near-request, 10x-overprovisioned and no-requests containers,
  with one-click filters.
- **Usage trends** - a rolling in-memory history (~30 min) drawn as sparklines
  on the Overview gauges and each Pod/Node status tab. No Prometheus needed.
- **Describe** - the kubectl-describe essentials as one scannable pane:
  conditions, owner chain, containers with requests/limits/mounts, scheduling
  constraints, volumes.
- **Related** - the object's neighbourhood as a navigable tree: owner chain,
  managed ReplicaSets/Pods, mounted ConfigMaps/Secrets/PVCs, Services routing
  to it and the Ingresses exposing them.
- **Pod file browser** - browse a container's filesystem, download files, and
  upload small ones (base64 over exec; needs a shell in the container).
- **Helm install & upgrade** - install charts with the default values prefilled
  for editing, upgrade releases with a live diff against the running values;
  history rollback as before.
- **Cross-context diff** - the same object in another kubeconfig context,
  server-noise stripped, as a unified diff (drift between staging and prod).

### Writes and read-only mode

Create / Apply / Scale / Delete act on the **live current-context cluster**;
destructive actions are always behind a confirm dialog. Every instance can run
**read-only**, which blocks all mutations, exec and port-forwarding at the main
process (the renderer only mirrors it):

- Desktop: toggle it in Preferences / the top bar (persisted).
- In-cluster: set by the deployment (`PANOPE_READ_ONLY`, or per-role in the
  authz policy) - the UI cannot lift it.

## Architecture

```
src/
  main/                 Electron main process (Node, privileged)
    index.ts            window lifecycle + secure BrowserWindow
    ipc.ts              ipcMain handlers + watch -> renderer streaming
    kube/
      client.ts         KubernetesService: kubeconfig, list/get/watch/metrics
      quantity.ts       CPU (-> millicores) / memory (-> bytes) parsers
  preload/
    index.ts            contextBridge -> window.api (secure, typed)
  renderer/             React + TypeScript UI (sandboxed)
    src/
      App.tsx           app shell + state
      components/       Sidebar, TopBar, ResourceTable, DetailDrawer, cells, Icon
      hooks/            useResourceData (list+watch+metrics), useCounts
      lib/              accessors (computed columns), formatters
      styles/           tokens.css (design system) + global.css
  shared/               types + IPC channel names + resource catalog (used by
                        BOTH main and renderer)
```

Security: `contextIsolation: true`, `nodeIntegration: false`. The renderer never
touches Node or the cluster directly - every privileged call crosses a typed IPC
bridge to the main process.

## Prerequisites

- Node 18+ (Electron 43 bundles Node 22 at runtime)
- A working `~/.kube/config`. Panope uses your current context; switch
  contexts from the top bar.

## Develop

```bash
npm install
npm run dev          # electron-vite dev server + hot reload
```

> If your shell exports `ELECTRON_RUN_AS_NODE=1`, unset it before launching
> (`env -u ELECTRON_RUN_AS_NODE npm run dev`) - otherwise Electron starts as a
> plain Node process and the window never appears.
>
> **Blank / no content?** On some Linux GPUs the window renders white. Launch
> with `env -u ELECTRON_RUN_AS_NODE npx electron . --no-sandbox --disable-gpu`
> (or run `npm run dev`). Note: `--disable-gpu` and the offscreen screenshot
> mode below are unrelated to normal use - the app renders normally in a visible
> window.

## Build

```bash
npm run typecheck    # tsc for main/preload and renderer
npm run build        # bundles to out/
npm run start        # preview the production build
npm run dist         # package installers via electron-builder
```

## Notes / roadmap

- **Helm** goes through the `helm` CLI, which must be on `PATH` (the container
  image bundles it). Charts / Releases degrade gracefully when it is missing.
- Metrics need **metrics-server**; usage columns, the right-sizing view and the
  Overview gauges fall back to `-` without it.
- Possible next steps: more resource kinds (VPA, Gateway API, PriorityClass),
  a cluster-wide image inventory, and desktop notifications for alerts.

## Screenshot helper (verification)

The main process supports a headless **offscreen** capture used during
development (only active when `PANOPE_SHOT` is set - normal runs are visible):

```bash
env -u ELECTRON_RUN_AS_NODE \
  PANOPE_SHOT=/tmp/shot.png PANOPE_SHOT_DELAY=9000 \
  PANOPE_CONTEXT=my-ctx \      # optional: pin a kubeconfig context
  PANOPE_INITIAL=pods \        # resource key, or crd:group/version/plural
  PANOPE_OPEN=1 \              # auto-open the first row's detail view
  PANOPE_TAB=logs \            # status|describe|specifications|view|labels|
                               # related|logs|terminal|files|ports|events
  PANOPE_CREATE=1 \            # open the Create modal
  npx electron . --no-sandbox
```

It loads the given view, waits for data to settle, writes a PNG, and quits.
Run **one capture at a time** - launching several Electron instances at once can
starve the offscreen compositor and yield a blank frame.

## License

[GNU AGPL-3.0](LICENSE) © Panope contributors.

The AGPL's network clause matters here: if you modify Panope and offer it to
others over a network (the in-cluster deployment is exactly that), you must make
your modified source available to those users. Running unmodified Panope, or
using it internally, carries no such obligation.
