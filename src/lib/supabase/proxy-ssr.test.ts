import { webcrypto } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, type NextResponse } from 'next/server'
import { LOGIN_PATH, HOME_PATH, NEXT_PARAM, updateSession } from './proxy'

/**
 * These tests run the proxy against the real @supabase/ssr cookie adapter and
 * the real auth-js getClaims() and getUser(). Only `fetch` is stubbed, so an
 * @supabase/ssr or auth-js upgrade that changes cookie parsing, the setAll
 * contract, or token verification fails here. No request leaves the process.
 */

const ORIGIN = 'https://piggy.test'
const SUPABASE_URL = 'https://fakeproj.supabase.test'
const COOKIE_NAME = 'sb-fakeproj-auth-token'
// auth-js caches the JWKS per project for 10 minutes, so the JWKS outage test
// uses a project whose keys no other test has fetched.
const OUTAGE_URL = 'https://fakeoutage.supabase.test'
const OUTAGE_COOKIE_NAME = 'sb-fakeoutage-auth-token'
const KID = 'fake-kid-1'
const USER_ID = '00000000-0000-4000-8000-000000000001'
const SESSION_ID = '00000000-0000-4000-8000-0000000000aa'

const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const
const HS256 = { name: 'HMAC', hash: 'SHA-256' } as const

type KeyPair = { publicKey: webcrypto.CryptoKey; privateKey: webcrypto.CryptoKey }
let projectKey: KeyPair
let attackerKey: KeyPair
let projectJwk: webcrypto.JsonWebKey & { kid: string; alg: string; use: string }
// Stands in for a project's legacy JWT secret. auth-js never sees it: it cannot
// check an HS256 token itself and asks the Auth server instead.
let legacySecret: webcrypto.CryptoKey

async function generateKey(): Promise<KeyPair> {
  return (await webcrypto.subtle.generateKey(
    { ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['sign', 'verify']
  )) as KeyPair
}

beforeAll(async () => {
  projectKey = await generateKey()
  attackerKey = await generateKey()
  legacySecret = (await webcrypto.subtle.generateKey(HS256, false, ['sign'])) as webcrypto.CryptoKey
  projectJwk = {
    ...(await webcrypto.subtle.exportKey('jwk', projectKey.publicKey)),
    kid: KID,
    alg: 'RS256',
    use: 'sig',
  }
})

function base64url(input: string | Uint8Array): string {
  return Buffer.from(input).toString('base64url')
}

async function signJwt(key: webcrypto.CryptoKey, kid: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }))
  const payload = base64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      session_id: SESSION_ID,
      iat: now,
      exp: now + 3600,
    })
  )
  const signature = await webcrypto.subtle.sign(RS256, key, new TextEncoder().encode(`${header}.${payload}`))
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`
}

/** A token like the ones a project on the legacy JWT secret issues: HS256 and no key id. */
async function signHs256Jwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      session_id: SESSION_ID,
      iat: now,
      exp: now + 3600,
    })
  )
  const signature = await webcrypto.subtle.sign(HS256, legacySecret, new TextEncoder().encode(`${header}.${payload}`))
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`
}

const fakeUser = {
  id: USER_ID,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'player@fake.invalid',
  app_metadata: {},
  user_metadata: {},
  created_at: '2026-01-01T00:00:00Z',
}

/** The session cookie exactly as @supabase/ssr writes it: "base64-" plus base64url JSON. */
function sessionCookie(accessToken: string, cookieName = COOKIE_NAME): string {
  const now = Math.floor(Date.now() / 1000)
  const session = {
    access_token: accessToken,
    refresh_token: 'fake-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: now + 3600,
    user: fakeUser,
  }
  return `${cookieName}=base64-${base64url(JSON.stringify(session))}`
}

type AuthServer = {
  jwks: 'ok' | 'error'
  user: 'ok' | 'session_not_found' | 'bad_jwt'
}

let server: AuthServer
let requestedUrls: string[]

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  requestedUrls.push(url.origin + url.pathname)
  if (url.origin !== SUPABASE_URL && url.origin !== OUTAGE_URL) {
    throw new Error(`Unexpected request to ${url.origin}`)
  }

  if (url.pathname === '/auth/v1/.well-known/jwks.json') {
    return server.jwks === 'ok' ? json({ keys: [projectJwk] }) : json({ message: 'down' }, 500)
  }
  if (url.pathname === '/auth/v1/user') {
    if (server.user === 'ok') return json(fakeUser)
    if (server.user === 'session_not_found') {
      return json(
        {
          code: 403,
          error_code: 'session_not_found',
          msg: 'Session from session_id claim in JWT does not exist',
        },
        403
      )
    }
    return json({ code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' }, 401)
  }
  throw new Error(`Unexpected request to ${url.pathname}`)
})

beforeEach(() => {
  server = { jwks: 'ok', user: 'ok' }
  requestedUrls = []
  fakeFetch.mockClear()
  vi.stubGlobal('fetch', fakeFetch)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'fake-publishable-key')
  // auth-js warns when server code reads the user out of getSession().
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function request(path: string, cookie?: string): NextRequest {
  return new NextRequest(new URL(path, ORIGIN), cookie ? { headers: { cookie } } : undefined)
}

function isPassThrough(response: NextResponse): boolean {
  return response.headers.get('x-middleware-next') === '1'
}

function location(response: NextResponse): URL | null {
  const value = response.headers.get('location')
  return value ? new URL(value) : null
}

function sessionCleared(response: NextResponse): boolean {
  const cookie = response.cookies.get(COOKIE_NAME)
  return cookie !== undefined && cookie.value === ''
}

describe('real @supabase/ssr: forged or unverifiable session cookies', () => {
  it('treats a token signed with an unknown key id as signed out', async () => {
    // auth-js finds no such key in the JWKS and asks the Auth server, which rejects it.
    server.user = 'bad_jwt'
    const cookie = sessionCookie(await signJwt(attackerKey.privateKey, 'fake-unknown-kid'))

    const page = await updateSession(request('/play', cookie))
    expect(location(page)?.pathname).toBe(LOGIN_PATH)

    const publicPage = await updateSession(request('/live', cookie))
    expect(isPassThrough(publicPage)).toBe(true)

    expect(requestedUrls.every((url) => url.startsWith(SUPABASE_URL))).toBe(true)
  })

  it('treats a token with a known key id and a forged signature as signed out', async () => {
    const cookie = sessionCookie(await signJwt(attackerKey.privateKey, KID))
    const page = await updateSession(request('/play', cookie))
    expect(location(page)?.pathname).toBe(LOGIN_PATH)
    expect(requestedUrls).not.toContain(`${SUPABASE_URL}/auth/v1/user`)
  })

  it('treats a JWKS outage as signed out', async () => {
    server.jwks = 'error'
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', OUTAGE_URL)
    const cookie = sessionCookie(await signJwt(projectKey.privateKey, KID), OUTAGE_COOKIE_NAME)
    const page = await updateSession(request('/play', cookie))
    expect(location(page)?.pathname).toBe(LOGIN_PATH)
    expect(requestedUrls).toContain(`${OUTAGE_URL}/auth/v1/.well-known/jwks.json`)
    expect(requestedUrls).not.toContain(`${OUTAGE_URL}/auth/v1/user`)
  })

  it('treats a request without a session cookie as signed out without any request', async () => {
    const page = await updateSession(request('/play'))
    expect(location(page)?.pathname).toBe(LOGIN_PATH)
    expect(fakeFetch).not.toHaveBeenCalled()
  })
})

describe('real @supabase/ssr: a valid session', () => {
  it('lets the user onto /play after confirming with the Auth server', async () => {
    const cookie = sessionCookie(await signJwt(projectKey.privateKey, KID))
    const page = await updateSession(request('/play', cookie))
    expect(isPassThrough(page)).toBe(true)
    expect(requestedUrls).toContain(`${SUPABASE_URL}/auth/v1/user`)
  })

  it('sends the user from /login to /play', async () => {
    const cookie = sessionCookie(await signJwt(projectKey.privateKey, KID))
    const login = await updateSession(request('/login', cookie))
    expect(location(login)?.pathname).toBe(HOME_PATH)
  })

  it('reaches an API route on the local signature check alone', async () => {
    const cookie = sessionCookie(await signJwt(projectKey.privateKey, KID))
    const api = await updateSession(request('/api/attempts', cookie))
    expect(isPassThrough(api)).toBe(true)
    expect(requestedUrls).not.toContain(`${SUPABASE_URL}/auth/v1/user`)
  })
})

describe('real @supabase/ssr: a revoked session (valid signature, no session on the server)', () => {
  beforeEach(() => {
    server.user = 'session_not_found'
  })

  it('redirects /play to /login and clears the session cookie', async () => {
    const cookie = sessionCookie(await signJwt(projectKey.privateKey, KID))
    const page = await updateSession(request('/play', cookie))
    const target = location(page)
    expect(target?.pathname).toBe(LOGIN_PATH)
    expect(target?.searchParams.get(NEXT_PARAM)).toBe('/play')
    expect(sessionCleared(page)).toBe(true)
  })

  it('renders /login instead of redirecting back to /play, even with the stale cookie', async () => {
    const cookie = sessionCookie(await signJwt(projectKey.privateKey, KID))
    const login = await updateSession(request('/login?next=%2Fplay', cookie))
    expect(isPassThrough(login)).toBe(true)
    expect(sessionCleared(login)).toBe(true)
  })

  it('settles on /login with no redirect loop', async () => {
    const cookie = sessionCookie(await signJwt(projectKey.privateKey, KID))
    const visited: string[] = []
    let url = new URL('/play', ORIGIN)
    for (let hop = 0; hop < 5; hop++) {
      const key = url.pathname + url.search
      expect(visited).not.toContain(key)
      visited.push(key)
      // Keep sending the stale cookie, as a browser would if it ignored the clear.
      const response = await updateSession(request(key, cookie))
      const next = location(response)
      if (!next) break
      url = next
    }
    expect(visited).toEqual(['/play', '/login?next=%2Fplay'])
  })
})

/**
 * P2R-03: for an HS256 token, getClaims() itself asks the Auth server
 * (getUser(token)), so the proxy does not ask a second time. The revoked-session
 * test pins that auth-js behaviour: if getClaims() ever stopped asking, the
 * proxy would let the revoked session onto /play and that test would fail.
 */
describe('real @supabase/ssr: a legacy HS256 session', () => {
  const userRequests = () => requestedUrls.filter((url) => url === `${SUPABASE_URL}/auth/v1/user`)

  it('lets the user onto /play with exactly one Auth server request', async () => {
    const cookie = sessionCookie(await signHs256Jwt())
    const page = await updateSession(request('/play', cookie))
    expect(isPassThrough(page)).toBe(true)
    expect(userRequests()).toHaveLength(1)
    expect(requestedUrls).not.toContain(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`)
  })

  it('sends the user from /login to /play with exactly one Auth server request', async () => {
    const cookie = sessionCookie(await signHs256Jwt())
    const login = await updateSession(request('/login', cookie))
    expect(location(login)?.pathname).toBe(HOME_PATH)
    expect(userRequests()).toHaveLength(1)
  })

  it('redirects a revoked session from /play to /login and then renders /login', async () => {
    server.user = 'session_not_found'
    const cookie = sessionCookie(await signHs256Jwt())
    const page = await updateSession(request('/play', cookie))
    expect(location(page)?.pathname).toBe(LOGIN_PATH)
    const login = await updateSession(request('/login?next=%2Fplay', cookie))
    expect(isPassThrough(login)).toBe(true)
  })
})
