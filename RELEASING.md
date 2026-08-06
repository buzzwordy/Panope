# Releasing

## Automated (GitHub Actions)

Pushing a `v*` tag builds and publishes everything:

```sh
npm version 2.7.0 --no-git-tag-version   # then bump chart/Chart.yaml to match
git commit -am "v2.7.0" && git tag v2.7.0 && git push --follow-tags
```

[`.github/workflows/release.yml`](.github/workflows/release.yml) then:

1. packages **natively on each OS** - Linux (`deb`/`rpm`/`AppImage`) on
   `ubuntu-latest` and Windows (NSIS + zip) on `windows-latest`, so no wine or
   cross-toolchain is involved. macOS packaging is **TBD**;
2. builds and pushes the image to `ghcr.io/<owner>/panope`;
3. opens a **draft** GitHub release with every artifact attached - review the
   generated notes and publish it by hand.

Run the workflow manually (`workflow_dispatch`) to build the packages without
publishing anything; `dry_run` defaults to true.

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and
PR: typecheck (all three targets), unit tests, both bundles, `helm lint` plus
chart rendering, and an image build that asserts the server still refuses to
start without auth.

Packages are **unsigned**. Add `CSC_LINK`/`CSC_KEY_PASSWORD` (Windows) and the
Apple signing secrets to the repository if you later want signed builds;
electron-builder picks them up from the environment with no config change.

## Manual builds

## Cutting a version

Bump the version in **both** places, or the About dialog and the chart will
disagree with the artifacts:

| File | Field |
| --- | --- |
| `package.json` | `version` - drives the desktop packages and the About dialog |
| `chart/Chart.yaml` | `appVersion` (the image tag) and `version` (the chart's own) |

Then:

```sh
npm run typecheck && npm test && npm run build
```

## Building packages

Linux `rpm` needs a working `fpm`, and Windows targets need `wine`. If either is
missing (or broken) on the host, build everything in the official builder image
instead - it has both:

```sh
docker run --rm -v "$PWD":/project \
  -v ~/.cache/electron:/root/.cache/electron \
  -v ~/.cache/electron-builder:/root/.cache/electron-builder \
  electronuserland/builder:wine \
  bash -lc "cd /project && npx electron-vite build && npx electron-builder --linux --win"
```

Artifacts land in `dist/` (`deb`, `rpm`, `AppImage`, Windows `zip` + NSIS
installer). The container writes them as root - fix ownership afterwards:

```sh
docker run --rm -v "$PWD/dist":/d -v "$PWD/out":/o alpine sh -c 'chown -R 1000:1000 /d /o'
```

Do **not** pass `--linux --win` in a single local (non-container) run: the two
packagers share temp directories and corrupt each other's `after-install`
scripts.

## Container image

```sh
docker build -t panope:$(node -p "require('./package.json').version") -t panope:latest .
```

Smoke-test it against a cluster before publishing - the server refuses to start
without auth configured, which is the intended behaviour:

```sh
docker run --rm --network host \
  -v ~/.kube/config:/kubeconfig:ro -e KUBECONFIG=/kubeconfig \
  -e PANOPE_INSECURE_NO_AUTH=true -e PORT=8899 panope:latest
```

`PANOPE_INSECURE_NO_AUTH` must be the literal string `true`; anything else
(including `1`) is rejected on purpose.

## In-cluster deployment

See [`docs/in-cluster.md`](docs/in-cluster.md) for the Helm chart, OIDC setup and
the authz policy. Two things that reliably catch people out:

- **`OIDC_SCOPES`** defaults to `openid profile email`. `groups` is *not* a
  standard scope - most IdPs reject it and the login fails before Panope sees
  anything. Groups normally arrive through a client/protocol mapper instead.
- **authz bindings match the *mapped* identity** - groups after any
  `strip`/`prefix`, username after `usernamePrefix`. With `usernamePrefix:
  "oidc:"` you bind `oidc:platform-admins`, matching what cluster RBAC binds.

## License note

Panope is AGPL-3.0. Distributing modified builds - including offering a modified
in-cluster deployment to other users over a network - requires publishing the
corresponding source.
