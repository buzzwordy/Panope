import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { Identity } from './session'
import { mapIdentity, type IdentityMapping } from './authz'

/**
 * OIDC authorization-code login.
 *
 * The point is impersonation: whoever logs in has their identity forwarded to
 * the Kubernetes API, so the cluster applies THEIR RBAC. The ServiceAccount
 * only ever needs permission to impersonate.
 */

export interface AuthConfig {
  enabled: boolean
  issuer?: string
  clientId?: string
  clientSecret?: string
  redirectUri?: string
  /** signs session and login-state cookies */
  sessionSecret: string
  sessionTtlSeconds: number
  /**
   * Only set when auth is disabled AND the deployment wants every visitor
   * impersonated as one fixed user. Empty means "don't impersonate" - use the
   * ServiceAccount / kubeconfig identity directly.
   */
  anonymousUser?: string
  /** claim -> identity mapping (shared with the authz engine) */
  identity: IdentityMapping
}

export function authConfigFromEnv(identity: IdentityMapping): AuthConfig {
  const enabled = process.env.PANOPE_AUTH === 'oidc'
  const secret = process.env.PANOPE_SESSION_SECRET
  if (enabled && !secret) {
    throw new Error('PANOPE_SESSION_SECRET is required when PANOPE_AUTH=oidc')
  }
  if (enabled && !process.env.OIDC_ISSUER) {
    throw new Error('OIDC_ISSUER is required when PANOPE_AUTH=oidc')
  }
  return {
    enabled,
    issuer: process.env.OIDC_ISSUER,
    clientId: process.env.OIDC_CLIENT_ID,
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    redirectUri: process.env.OIDC_REDIRECT_URI,
    sessionSecret: secret || randomBytes(32).toString('hex'),
    sessionTtlSeconds: Number(process.env.PANOPE_SESSION_TTL_SECONDS || 8 * 3600),
    anonymousUser: process.env.PANOPE_ANONYMOUS_USER || undefined,
    identity
  }
}

interface Discovery {
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  issuer: string
  end_session_endpoint?: string
}

let discovery: Discovery | null = null
export async function discover(cfg: AuthConfig): Promise<Discovery> {
  if (discovery) return discovery
  const res = await fetch(`${String(cfg.issuer).replace(/\/$/, '')}/.well-known/openid-configuration`)
  if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`)
  discovery = (await res.json()) as Discovery
  return discovery
}

// JWKS is cached and rotated by jose itself.
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null
async function keyStore(cfg: AuthConfig): Promise<ReturnType<typeof createRemoteJWKSet>> {
  if (!jwks) {
    const d = await discover(cfg)
    jwks = createRemoteJWKSet(new URL(d.jwks_uri))
  }
  return jwks
}

// ---- signed cookies (stateless, so replicas need no shared store) ----

const SESSION_COOKIE = 'panope_session'
const STATE_COOKIE = 'panope_login'

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

function seal(value: object, secret: string, ttlSeconds: number): string {
  const body = Buffer.from(JSON.stringify({ ...value, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString(
    'base64url'
  )
  return `${body}.${sign(body, secret)}`
}

function unseal<T>(raw: string | undefined, secret: string): T | null {
  if (!raw) return null
  const dot = raw.lastIndexOf('.')
  if (dot < 0) return null
  const body = raw.slice(0, dot)
  const mac = raw.slice(dot + 1)
  const expected = sign(body, secret)
  // constant-time compare so the signature can't be discovered by timing
  if (mac.length !== expected.length) return null
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString()) as T & { exp: number }
    if (parsed.exp * 1000 < Date.now()) return null
    return parsed
  } catch {
    return null
  }
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const hit = (req.headers.cookie ?? '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : undefined
}

/** `Secure` whenever auth is on: OIDC always runs behind TLS, and a
 *  TLS-terminating proxy does NOT add the flag to upstream Set-Cookie. */
function cookieFlags(cfg: AuthConfig, maxAge: number): string {
  const secure = cfg.enabled && process.env.PANOPE_COOKIE_INSECURE !== 'true' ? '; Secure' : ''
  return `; HttpOnly; SameSite=Lax; Path=/${secure}; Max-Age=${maxAge}`
}

export function issueCookie(identity: Identity, cfg: AuthConfig): string {
  const ttl = cfg.sessionTtlSeconds
  return `${SESSION_COOKIE}=${seal(identity, cfg.sessionSecret, ttl)}${cookieFlags(cfg, ttl)}`
}

export function clearCookie(cfg: AuthConfig): string {
  return `${SESSION_COOKIE}=${cookieFlags(cfg, 0)}`
}

/** Remember `state` + `nonce` across the redirect so the callback can verify them. */
export function issueLoginCookie(state: string, nonce: string, cfg: AuthConfig): string {
  return `${STATE_COOKIE}=${seal({ state, nonce }, cfg.sessionSecret, 600)}${cookieFlags(cfg, 600)}`
}
export function clearLoginCookie(cfg: AuthConfig): string {
  return `${STATE_COOKIE}=${cookieFlags(cfg, 0)}`
}

export function readIdentity(req: IncomingMessage, cfg: AuthConfig): Identity | null {
  if (!cfg.enabled) return { user: cfg.anonymousUser ?? '', groups: [] }
  const parsed = unseal<Identity>(readCookie(req, SESSION_COOKIE), cfg.sessionSecret)
  if (!parsed) return null
  return { user: parsed.user, groups: parsed.groups ?? [], email: parsed.email }
}

export async function authorizeUrl(cfg: AuthConfig, state: string, nonce: string): Promise<string> {
  const d = await discover(cfg)
  const q = new URLSearchParams({
    response_type: 'code',
    // Only the standard OIDC scopes by default. `groups` is NOT a standard
    // scope - Keycloak (and others) reject an unknown scope with
    // invalid_scope, which breaks login entirely. Groups normally arrive via a
    // client/protocol mapper regardless of scope; set OIDC_SCOPES explicitly
    // only if your IdP exposes groups through a dedicated scope.
    scope: process.env.OIDC_SCOPES || 'openid profile email',
    client_id: cfg.clientId ?? '',
    redirect_uri: cfg.redirectUri ?? '',
    state,
    nonce
  })
  return `${d.authorization_endpoint}?${q}`
}

export async function endSessionUrl(cfg: AuthConfig): Promise<string | undefined> {
  try {
    return (await discover(cfg)).end_session_endpoint
  } catch {
    return undefined
  }
}

/**
 * Exchange the code and FULLY verify the resulting id_token: signature against
 * the issuer's JWKS, plus `iss`, `aud` and `exp`. Previously the payload was
 * merely base64-decoded, so a token minted for a different client (or an
 * expired one) was accepted and its claims became a Kubernetes identity.
 */
export async function exchangeCode(
  code: string,
  expectedNonce: string,
  cfg: AuthConfig
): Promise<Identity> {
  const d = await discover(cfg)
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri ?? '',
    client_id: cfg.clientId ?? '',
    client_secret: cfg.clientSecret ?? ''
  })
  const res = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`)
  const tok = (await res.json()) as { id_token?: string }
  if (!tok.id_token) throw new Error('no id_token in token response')

  const { payload } = await jwtVerify(tok.id_token, await keyStore(cfg), {
    issuer: d.issuer || cfg.issuer,
    audience: cfg.clientId
  })
  if (payload.nonce && payload.nonce !== expectedNonce) {
    throw new Error('id_token nonce mismatch')
  }
  if (typeof payload.azp === 'string' && cfg.clientId && payload.azp !== cfg.clientId) {
    throw new Error('id_token azp does not match this client')
  }

  const claims = payload as unknown as Record<string, unknown>
  const mapped = mapIdentity(claims, cfg.identity)
  if (mapped.dropped.length) {
    console.warn(`[auth] dropped disallowed groups for ${mapped.user}: ${mapped.dropped.join(', ')}`)
  }
  return {
    user: mapped.user,
    groups: mapped.groups,
    email: typeof claims.email === 'string' ? claims.email : undefined
  }
}

/** Verify the callback's state against the signed login cookie. */
export function verifyState(req: IncomingMessage, state: string | null, cfg: AuthConfig): { nonce: string } {
  const stored = unseal<{ state: string; nonce: string }>(readCookie(req, STATE_COOKIE), cfg.sessionSecret)
  if (!stored || !state) throw new Error('missing login state - start again at /auth/login')
  const a = Buffer.from(stored.state)
  const b = Buffer.from(state)
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('login state mismatch')
  return { nonce: stored.nonce }
}

export function newStatePair(): { state: string; nonce: string } {
  return { state: randomBytes(16).toString('hex'), nonce: randomBytes(16).toString('hex') }
}

export function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not authenticated' }))
}
