# Changelog

Notable changes per release. Versions follow [semver](https://semver.org/).
Each release also publishes a container image at the same version and a Helm
chart whose version is listed next to it.

The repository keeps a single commit, so this file is the history.

## [3.3.0] - 2026-09-17

Chart 0.11.0.

### Added

- API removal scan. Opening a Helm release compares every rendered `apiVersion`
  against what the cluster's discovery serves and lists the ones that are gone,
  with the newest served replacement. It asks the live cluster instead of
  carrying a deprecation table, so CRD versions dropped by an operator upgrade
  are caught too.
- Support window badge on the Kubernetes version in the footer and in About.
  It shows once the minor has stopped getting patches, or will within 90 days.
  Minors newer than the built-in table report nothing rather than a guess.
- Patch currency. The badge also says how many patch releases the cluster is
  behind the newest one for its minor.

### Changed

- The startup check now makes a second request, to `dl.k8s.io`, for the newest
  patch of the cluster's minor. It uses the same "Check on startup" switch in
  Preferences, which now names both hosts. Nothing is sent from the in-cluster
  build.

## [3.2.2] - 2026-09-15

Chart 0.10.0.

### Added

- Auto-refresh for the open list, set in Preferences (off, 5s, 10s, 30s, 60s;
  default 10s). Lists still update from a watch; the interval re-fetches as well
  so a watch that dies quietly cannot leave stale rows on screen. It re-lists in
  place, without a loading state and without restarting the watch.

## [3.2.1] - 2026-09-10

Chart 0.9.0.

### Changed

- The READY column is colour-coded: green when every replica is ready, amber
  when any are not, muted for 0/0.

## [3.2.0] - 2026-09-01

Chart 0.8.0.

### Added

- Related tab draws the object's neighbourhood as a topology graph. The tree
  view is still there as an option. Click a node to open it.
- Split view: pin the current object beside the list and keep browsing.
- YAML editor field completion driven by the cluster's own OpenAPI v3 schema,
  CRDs included.
- Notification bell in the top bar. Toasts fade after a few seconds; the bell
  keeps them, so a missed error or mutation result can still be read.
- Status filter chips on resource tables.
- Resizable sidebar; the width is remembered.
- System theme that follows the OS light/dark setting live.
- Command palette lists commands and switches, not only kinds and objects, and
  ranks label matches first.
- Loading skeletons in place of a blank table.

### Changed

- Right-sizing rows open the pod; OOM-killed rows go straight to the evidence.

### Fixed

- Cards, hovers and a few panels rendered transparent in every theme because
  three colour tokens were referenced but never defined.
- The assistant kept reopening its settings when the Claude Code provider was
  configured with all fields left empty, which is a valid setup.

## [3.1.0] - 2026-08-08

Chart 0.7.0.

### Added

- MCP servers for the assistant, over stdio or HTTP. Their tools are namespaced
  `ext_<server>_<tool>` so they cannot shadow a built-in one, and every external
  call stops at a confirmation card. "Always allow" can be set per tool and
  revoked from the same panel.
- Unrestricted mode for the Claude Code provider, off by default. It lets the
  CLI use its own shell, file and web tools. Those calls do not pass Panope's
  confirmation card and are not in the audit log, and the panel says so.

## [3.0.0] - 2026-08-07

Chart 0.6.0.

### Added

- AI assistant panel (desktop only). Three ways to connect: the installed
  Claude Code CLI, which bills to your plan with no API key; the Anthropic API;
  or any OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, OpenRouter,
  OpenAI).
- 11 read tools and 10 write tools. Every call runs as your impersonated
  identity. Writes stop at a confirmation card, honour read-only mode and are
  audited as `ai:*`.
- Secret values and credential-like Helm values are redacted before anything
  leaves the machine.
- GitHub Dark and GitHub Light themes.

### Changed

- README rewritten around install and features.

## [2.8.0] - 2026-08-07

Chart 0.5.0.

### Added

- Update notification. On startup Panope asks GitHub for the newest release and
  links to it. It does not download or install anything, and it can be turned
  off in Preferences.
- Release pipeline gate: the tag, `package.json` and the chart's `appVersion`
  must agree, and the chart version must not already be published, before any
  packaging starts.

### Changed

- Sidebar counts request metadata only and page with a budget. On one test
  cluster that took the count traffic from 20.5 MB to 2.0 MB. When a list is
  truncated the total stays exact and the per-namespace badge is hidden rather
  than wrong.

## [2.7.0] - 2026-08-07

Chart 0.4.0.

### Added

- Extra kubeconfig files, merged on top of `$KUBECONFIG` or `~/.kube/config`.
  A file is parsed when you add it, so a bad path is rejected there instead of
  breaking later startups. The Kubeconfigs dialog shows per-file diagnostics
  and the context picker shows which file each context came from.

## [2.6.0] - 2026-08-06

Chart 0.3.0. First tagged release.

- Desktop app and in-cluster web build from one codebase. In-cluster mode uses
  OIDC login and per-user impersonation.
- 31 built-in kinds with live counts, every CRD grouped by API group, and an
  ArgoCD section.
- Full-page object view with logs, terminal, port-forwarding, files, YAML
  editing with server-side apply, describe and related objects.
- Access matrix, audit log, right-sizing, fleet summary, cross-context diff,
  Helm install/upgrade/rollback and usage sparklines.
- Read-only mode enforced in the main process.

[3.3.0]: https://github.com/buzzwordy/Panope/releases/tag/v3.3.0
[3.2.2]: https://github.com/buzzwordy/Panope/releases/tag/v3.2.2
[3.2.1]: https://github.com/buzzwordy/Panope/releases/tag/v3.2.1
[3.2.0]: https://github.com/buzzwordy/Panope/releases/tag/v3.2.0
[3.1.0]: https://github.com/buzzwordy/Panope/releases/tag/v3.1.0
[3.0.0]: https://github.com/buzzwordy/Panope/releases/tag/v3.0.0
[2.8.0]: https://github.com/buzzwordy/Panope/releases/tag/v2.8.0
[2.7.0]: https://github.com/buzzwordy/Panope/releases/tag/v2.7.0
[2.6.0]: https://github.com/buzzwordy/Panope/releases/tag/v2.6.0
