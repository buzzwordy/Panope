import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { KubernetesService } from '../main/kube/client'
import { Session } from './session'
import { callRpc, type RpcPolicy } from './rpc'
import {
  authConfigFromEnv,
  authorizeUrl,
  clearCookie,
  clearLoginCookie,
  endSessionUrl,
  exchangeCode,
  issueCookie,
  issueLoginCookie,
  newStatePair,
  readIdentity,
  unauthorized,
  verifyState
} from './auth'
import { authzFromEnv, resolvePolicy, namespaceAllowed, type Policy } from './authz'
import { startAlerting } from './alerts'
import type { LogQuery } from '../shared/types'

const PORT = Number(process.env.PORT || 8080)
const STATIC_DIR = process.env.PANOPE_STATIC || join(__dirname, '../renderer')
const POLICY: RpcPolicy = {
  readOnly: process.env.PANOPE_READ_ONLY !== 'false',
  allowPrivileged: process.env.PANOPE_ALLOW_PRIVILEGED === 'true'
}

const authz = authzFromEnv(POLICY)
const auth = authConfigFromEnv(authz.identity)
const svc = new KubernetesService()

// Fail closed. With auth disabled there is NO authentication at all, so the
// operator must say out loud that this is a trusted network.
const INSECURE_OK = process.env.PANOPE_INSECURE_NO_AUTH === 'true'
if (!auth.enabled && !INSECURE_OK) {
  console.error(
    '[panope] REFUSING TO START: PANOPE_AUTH is not "oidc" and PANOPE_INSECURE_NO_AUTH is not "true".\n' +
      '         Running with no authentication exposes cluster data to anyone who can reach this port.\n' +
      '         Set PANOPE_AUTH=oidc (recommended), or PANOPE_INSECURE_NO_AUTH=true to accept the risk.'
  )
  process.exit(1)
}

/** Hosts/origins permitted to call us (CSWSH + DNS-rebinding defence). */
const ALLOWED_ORIGINS = (process.env.PANOPE_ALLOWED_ORIGINS || '')
  .split(/[\s,]+/)
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean)

function originOk(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin
  // Same-origin browser requests to /rpc send no Origin only for GETs; a
  // cross-site POST or WS upgrade always does. Absent Origin => same-origin.
  if (!origin) return true
  const normalised = origin.replace(/\/$/, '')
  if (ALLOWED_ORIGINS.length) return ALLOWED_ORIGINS.includes(normalised)
  // Default: only accept an Origin matching the Host we were reached on.
  try {
    return new URL(normalised).host === req.headers.host
  } catch {
    return false
  }
}

function policyFor(identity: { user: string; groups: string[] }): Policy {
  return resolvePolicy(identity.user, identity.groups, authz)
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains'
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json'
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(code, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

async function readBody(req: http.IncomingMessage, limit = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function serveStatic(res: http.ServerResponse, urlPath: string): Promise<void> {
  // Resolve inside STATIC_DIR only - never let ../ escape the asset root.
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '')
  let file = join(STATIC_DIR, rel)
  if (rel === '/' || rel === '' || rel === '.') file = join(STATIC_DIR, 'index.html')
  if (!file.startsWith(normalize(STATIC_DIR))) {
    res.writeHead(403).end('forbidden')
    return
  }
  try {
    const buf = await readFile(file)
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(buf)
  } catch {
    // SPA fallback: unknown paths render the app shell
    try {
      const buf = await readFile(join(STATIC_DIR, 'index.html'))
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': MIME['.html'] })
      res.end(buf)
    } catch {
      res.writeHead(404).end('not found')
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  // ---- auth endpoints ----
  if (url.pathname === '/auth/login') {
    if (!auth.enabled) {
      res.writeHead(302, { location: '/' }).end()
      return
    }
    const { state, nonce } = newStatePair()
    res
      .writeHead(302, { location: await authorizeUrl(auth, state, nonce), 'set-cookie': issueLoginCookie(state, nonce, auth) })
      .end()
    return
  }
  if (url.pathname === '/auth/callback') {
    const code = url.searchParams.get('code')
    if (!code) return json(res, 400, { error: 'missing code' })
    try {
      // Validating `state` against the signed login cookie is what stops
      // login-CSRF / session fixation: without it an attacker could complete
      // the flow in the victim's browser using their own authorization code.
      const { nonce } = verifyState(req, url.searchParams.get('state'), auth)
      const identity = await exchangeCode(code, nonce, auth)
      res
        .writeHead(302, {
          location: '/',
          'set-cookie': [issueCookie(identity, auth), clearLoginCookie(auth)]
        })
        .end()
    } catch (e) {
      console.warn('[auth] login failed:', e instanceof Error ? e.message : e)
      json(res, 401, { error: 'login failed' })
    }
    return
  }
  if (url.pathname === '/auth/logout') {
    const target = auth.enabled ? ((await endSessionUrl(auth)) ?? '/') : '/'
    res.writeHead(302, { location: target, 'set-cookie': clearCookie(auth) }).end()
    return
  }
  if (url.pathname === '/auth/me') {
    const identity = readIdentity(req, auth)
    if (!identity) return json(res, 200, { authenticated: false, authEnabled: auth.enabled })
    const p = policyFor(identity)
    return json(res, 200, {
      authenticated: true,
      user: identity.user || undefined,
      groups: identity.groups,
      email: identity.email,
      authEnabled: auth.enabled,
      role: p.role,
      readOnly: POLICY.readOnly || p.readOnly,
      allowPrivileged: POLICY.allowPrivileged && p.privileged,
      features: [...p.features],
      namespaces: p.namespaces
    })
  }

  // ---- health (no auth: used by kubelet probes) ----
  if (url.pathname === '/healthz') return json(res, 200, { ok: true })

  // ---- rpc ----
  if (url.pathname === '/rpc' && req.method === 'POST') {
    if (!originOk(req)) return json(res, 403, { error: 'origin not allowed' })
    const identity = readIdentity(req, auth)
    if (!identity) return unauthorized(res)
    try {
      const { method, args } = JSON.parse(await readBody(req)) as { method: string; args?: unknown[] }
      if (typeof method !== 'string' || (args !== undefined && !Array.isArray(args))) {
        return json(res, 400, { error: 'malformed rpc envelope' })
      }
      const session = new Session(svc, identity, 'rpc', policyFor(identity))
      const out = await callRpc(session, method, args ?? [], POLICY)
      return json(res, out.error ? 400 : 200, out)
    } catch (e) {
      console.error('[rpc] envelope error:', e instanceof Error ? e.message : e)
      return json(res, 400, { error: 'malformed request' })
    }
  }

  await serveStatic(res, url.pathname)
})

// ---- streaming over WebSocket ----
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  // Cookie auth alone would allow cross-site WebSocket hijacking: any page could
  // open ws:// to us and inherit the victim's session.
  if (!originOk(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }
  const identity = readIdentity(req, auth)
  if (!identity) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, identity))
})

function attach(ws: WebSocket, identity: { user: string; groups: string[] }): void {
  const session = new Session(svc, identity, randomBytes(6).toString('hex'), policyFor(identity))
  const send = (msg: unknown): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }

  ws.on('message', async (raw) => {
    let msg: { t: string; id?: string; [k: string]: unknown }
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    try {
      switch (msg.t) {
        case 'watch.start': {
          session.assertCapacity('watch')
          const id = session.nextId('w')
          // A namespace-scoped role watches cluster-wide, so drop events for
          // namespaces outside its scope. Cluster-scoped objects (no namespace)
          // are governed by RBAC, matching the HTTP list path.
          const handle = await session.svc.createWatch(msg.key as string, (type, object) => {
            const ns = (object as { metadata?: { namespace?: string } }).metadata?.namespace
            if (!namespaceAllowed(ns, session.policy)) return
            send({ t: 'watch.event', id, type, object })
          })
          if (handle) session.watches.set(id, handle)
          send({ t: 'watch.started', ref: msg.ref, id })
          break
        }
        case 'watch.startCustom': {
          session.assertCapacity('watch')
          const id = session.nextId('wc')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const handle = await session.svc.createWatchCustom(msg.ref2 as any, (type, object) =>
            send({ t: 'watch.event', id, type, object })
          )
          if (handle) session.watches.set(id, handle)
          send({ t: 'watch.started', ref: msg.ref, id })
          break
        }
        case 'watch.stop': {
          session.watches.get(msg.id as string)?.stop()
          session.watches.delete(msg.id as string)
          break
        }
        case 'logs.start': {
          // Pod logs routinely contain secrets, so they are feature-gated even
          // though reading them is not a mutation.
          if (!session.policy.features.has('logs')) {
            send({ t: 'logs.data', id: '', closed: true, error: 'Your role does not include log access.' })
            break
          }
          if (!namespaceAllowed(msg.namespace as string, session.policy)) {
            send({ t: 'logs.data', id: '', closed: true, error: `Your role is scoped to: ${session.policy.namespaces.join(', ')}` })
            break
          }
          session.assertCapacity('log')
          const id = session.nextId('log')
          const handle = await session.svc.startLogs(
            msg.namespace as string,
            msg.pod as string,
            msg.query as LogQuery,
            (data) => send({ t: 'logs.data', id, data }),
            (error) => send({ t: 'logs.data', id, closed: true, error })
          )
          session.logs.set(id, handle)
          send({ t: 'logs.started', ref: msg.ref, id })
          break
        }
        case 'logs.stop': {
          session.logs.get(msg.id as string)?.stop()
          session.logs.delete(msg.id as string)
          break
        }
        case 'exec.start': {
          if (POLICY.readOnly || session.policy.readOnly) {
            send({ t: 'exec.data', id: '', closed: true, error: 'This deployment is read-only for your role.' })
            break
          }
          if (!session.policy.features.has('exec')) {
            send({ t: 'exec.data', id: '', closed: true, error: 'Your role does not include terminal access.' })
            break
          }
          if (!namespaceAllowed(msg.namespace as string, session.policy)) {
            send({ t: 'exec.data', id: '', closed: true, error: `Your role is scoped to: ${session.policy.namespaces.join(', ')}` })
            break
          }
          session.assertCapacity('exec')
          const id = session.nextId('ex')
          const handle = await session.svc.startExec(
            msg.namespace as string,
            msg.pod as string,
            msg.container as string,
            msg.command as string[],
            (data) => send({ t: 'exec.data', id, data }),
            (error) => send({ t: 'exec.data', id, closed: true, error })
          )
          session.execs.set(id, handle)
          send({ t: 'exec.started', ref: msg.ref, id })
          break
        }
        case 'exec.input':
          // Guarded as well as exec.start: a session created before a policy
          // change must not keep accepting keystrokes.
          if (POLICY.readOnly || session.policy.readOnly || !session.policy.features.has('exec')) break
          session.execs.get(msg.id as string)?.input(msg.data as string)
          break
        case 'exec.resize':
          if (POLICY.readOnly || session.policy.readOnly || !session.policy.features.has('exec')) break
          session.execs.get(msg.id as string)?.resize(msg.cols as number, msg.rows as number)
          break
        case 'exec.stop':
          session.execs.get(msg.id as string)?.stop()
          session.execs.delete(msg.id as string)
          break
        default:
          break
      }
    } catch (e) {
      send({ t: 'error', ref: msg.ref, error: e instanceof Error ? e.message : String(e) })
    }
  })

  ws.on('close', () => session.dispose())
  ws.on('error', () => session.dispose())
}

server.listen(PORT, () => {
  console.log(`[panope] listening on :${PORT}`)
  console.log(`[panope] auth=${auth.enabled ? 'oidc' : 'disabled'} readOnly=${POLICY.readOnly} privileged=${POLICY.allowPrivileged} identity=${auth.enabled ? 'per-user (impersonated)' : auth.anonymousUser ? `impersonating ${auth.anonymousUser}` : 'service account / kubeconfig'}`)
  if (!auth.enabled) {
    console.warn('[panope] WARNING: auth is disabled - do not expose this deployment on an Ingress.')
  }
  startAlerting(svc)
})
