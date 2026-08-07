# Running Panope in the cluster

The same app, served from a pod instead of your desktop. The React UI is
identical - only the transport differs: Electron IPC becomes HTTP `/rpc` plus a
WebSocket for the streaming calls (watch, logs, exec).

```
browser ──HTTP /rpc──►  server  ──impersonated──►  Kubernetes API
        ──WebSocket──►  (pod)       as YOU
```

## The security model, in one paragraph

Your desktop app uses *your* kubeconfig, so the cluster already knows who you
are. A pod does not: it has a ServiceAccount. If you give that SA broad rights
and put it behind an Ingress, anyone who reaches the URL has your cluster with
no password. So the recommended mode is **OIDC + impersonation**: users log in
against your IdP, and the server forwards their identity to the API server
(`Impersonate-User`). Kubernetes then authorises every call against *that
person's* RBAC. The ServiceAccount itself gets only the `impersonate` verb and
cannot read a single pod on its own.

The chart refuses to render an Ingress whenever `auth.mode` is not `oidc` -
even read-only, because that still publishes every non-secret resource and pod
logs to anyone who reaches the URL. Set `ingress.allowAnonymous=true` to accept
that risk deliberately. A second guard refuses unauthenticated **and**
read-write outright, which is an anonymous cluster-admin console.

## Quick start (private, read-only)

```sh
# published to GHCR as an OCI chart by the release workflow
helm install panope oci://ghcr.io/buzzwordy/charts/panope \
  --namespace panope --create-namespace
kubectl -n panope port-forward svc/panope-panope 8080:80
# http://localhost:8080
```

Or from a checkout of this repository, with `./chart` in place of the `oci://`
reference.

That pulls `ghcr.io/buzzwordy/panope:<appVersion>`, published by the release
workflow. **The GHCR package's visibility is independent of the repository's**
- it inherits it at first push and does not follow later changes. If pulls fail
with `denied`, either make the package public in its GitHub settings or give
the namespace an imagePullSecret:

```sh
kubectl -n panope create secret docker-registry ghcr \
  --docker-server=ghcr.io --docker-username=<user> --docker-password=<PAT>
helm install panope ./chart -n panope --set 'imagePullSecrets[0].name=ghcr'
```

To run a locally built image instead, build the tag the chart expects and point
the repository at it:

```sh
docker build -t "panope:$(node -p "require('./package.json').version")" .
helm install panope ./chart -n panope --create-namespace \
  --set image.repository=panope
```

The Service is `<release>-<chart>`, hence `panope-panope`. Add
`--set fullnameOverride=panope` if you would rather it were just `panope`.

Defaults: read-only, no Ingress, no privileged actions, SA bound to the
built-in `view` ClusterRole.

## Production (OIDC + impersonation)

Your API server must already trust the same IdP, and `usernameClaim` must match
its `--oidc-username-claim`, or impersonated names won't line up with your
RoleBindings.

```sh
helm install panope ./chart -n panope --create-namespace \
  --set auth.mode=oidc \
  --set auth.oidc.issuer=https://keycloak.example.com/realms/platform \
  --set auth.oidc.clientId=panope \
  --set auth.oidc.clientSecret=... \
  --set auth.oidc.redirectUri=https://panope.example.com/auth/callback \
  --set auth.sessionSecret="$(openssl rand -hex 32)" \
  --set rbac.impersonate.enabled=true \
  --set 'rbac.impersonate.groups={platform-admins,developers}' \
  --set panope.readOnly=false \
  --set ingress.enabled=true --set ingress.host=panope.example.com \
  --set ingress.tls.enabled=true --set ingress.tls.secretName=panope-tls
```

The `rbac.impersonate.groups` allowlist is required: the chart refuses to render
rather than grant blanket impersonation. List the groups (and/or `users`) your
IdP actually issues - these are the names the ClusterRole pins via
`resourceNames`. `rbac.impersonate.allowAnyUser=true` lifts the restriction and
should be a deliberate choice, not a default.

With `readOnly=false` users can still only do what their own RBAC allows -
a viewer stays a viewer. RBAC denials surface verbatim in the UI.

## Granular authorization

Two layers, because they answer different questions.

**Layer 1 - identity -> Kubernetes RBAC (the hard boundary).** Panope maps your
OIDC claims onto a Kubernetes user *and their full group set*, then impersonates
them. Per-namespace / per-resource / per-verb access is therefore decided by the
API server, not by Panope - a bug here cannot grant access the cluster refuses.
Granular access needs no app config at all, just RBAC:

```yaml
kind: RoleBinding                 # team-payments: read-only, one namespace
metadata: { name: panope-payments, namespace: payments }
roleRef:  { kind: ClusterRole, name: view }
subjects: [{ kind: Group, name: team-payments }]
```

Claim mapping is fully configurable, so any IdP shape works:

```yaml
authz:
  enabled: true
  identity:
    usernameClaim: preferred_username     # must match --oidc-username-claim
    groups:
      - claim: groups                     # plain list
      - { claim: realm_access.roles, prefix: "role:" }        # Keycloak realm roles
      - { claim: resource_access.panope.roles, strip: "panope-" }
    forbidden: [cluster-admin]            # extra denylist; system:* always denied
```

**Layer 2 - capabilities (guardrails).** RBAC cannot say "this team may not use
the *web terminal* even though they can `kubectl exec`". That's what roles are
for. This layer only ever **subtracts**:

```yaml
authz:
  roles:
    viewer:    { readOnly: true,  features: [logs, events] }
    developer: { readOnly: false, features: [logs, exec, portForward, apply, scale] }
    admin:     { readOnly: false, features: ["*"], privileged: true }
  bindings:                               # first match wins
    - { groups: [platform-admins], role: admin }
    - { groups: [team-payments], role: developer, namespaces: [payments, "payments-*"] }
    - { always: true, role: viewer }       # unmatched users get read-only, no features
```

Features: `logs, events, exec, portForward, apply, delete, scale, nodeShell,
debugContainer, helm, argo`. An unmatched user fails **closed**.

### Impersonation must be pinned

`rbac.impersonate` requires an allowlist of exactly who may be impersonated:

```yaml
rbac:
  impersonate:
    enabled: true
    groups: [team-payments, platform-admins]
    users: []
```

The chart refuses to render without one, and refuses any `system:*` entry -
impersonating `system:masters` bypasses RBAC entirely and would turn any login
into cluster-admin. The server rejects `system:*` independently, so both layers
have to fail before that is reachable.

## Alerts

Two sources, both optional:

* **Built-in rules** over the conditions the dashboard already computes -
  NotReady nodes, node pressure, CrashLoop/ImagePull pods, restart storms,
  cluster CPU/memory/pod-slot pressure, ArgoCD sync failures and degraded apps.
  These cover the gaps Prometheus usually leaves.
* **Alertmanager** - set `alertmanagerUrls` (one or many) and whatever your
  existing rules are already firing is surfaced alongside, rather than
  duplicated. Each alert is tagged with its source Alertmanager, and one
  unreachable endpoint never blanks the others.

Alerts deduplicate by a stable key and re-send only after `cooldownMinutes`, so
a persistent problem does not spam the channel; a key that stops firing is
forgotten so a recurrence alerts again.

```sh
--set panope.alerts.enabled=true \
--set panope.alerts.slackWebhookUrl=https://hooks.slack.com/... \
--set 'panope.alerts.alertmanagerUrls={http://am-a.monitoring.svc:9093,http://am-b.monitoring.svc:9093}'
```

With no sink configured, alerts are written to the pod log.

## What differs from the desktop app

| Feature | In-cluster |
| --- | --- |
| Port forwarding | Disabled - it would forward to the *pod's* localhost, which the browser cannot reach. |
| Fleet / context switching | Disabled - a pod has one cluster, not a kubeconfig full of them. |
| Node shell, debug containers | Off unless `allowPrivileged=true`; creating privileged pods from a shared web app is a wide blast radius. |
| Read-only toggle | Set by the deployment, not the UI. |
| Preferences, layout, favourites | Per-browser (localStorage), as on the desktop. |

## Environment reference

| Variable | Meaning |
| --- | --- |
| `PORT` | listen port (default 8080) |
| `PANOPE_READ_ONLY` | `false` to permit mutations (default `true`) |
| `PANOPE_ALLOW_PRIVILEGED` | `true` to permit node shell / debug containers |
| `PANOPE_AUTH` | `oidc` to require login |
| `PANOPE_SESSION_SECRET` | required with OIDC; signs session cookies |
| `OIDC_*` | issuer, client id/secret, redirect URI, username/groups claims |
| `PANOPE_AUTHZ` | JSON claim-mapping + role policy (rendered by the chart) |
| `PANOPE_INSECURE_NO_AUTH` | required to boot with auth disabled - the server fails closed otherwise |
| `PANOPE_ALLOWED_ORIGINS` | origins allowed to call `/rpc` and open the WebSocket |
| `PANOPE_MAX_WATCHES` / `_LOG_STREAMS` / `_EXEC_SESSIONS` | per-connection stream caps |
| `PANOPE_SESSION_TTL_SECONDS` | session cookie lifetime (default 8h) |
| `PANOPE_ALERTS` | `true` to enable the evaluator |
| `PANOPE_ALERT_*` | interval, cooldown, thresholds, webhook/Slack/Alertmanager |
