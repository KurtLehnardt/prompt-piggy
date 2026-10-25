import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * assertSameOrigin (docs/ARCHITECTURE.md section 7, R1-04, R2-10). Each test
 * re-imports the modules so the cached server settings start empty.
 */
const APP = 'https://prompt-piggy.example'
const OTHER_HOST = 'prompt-piggy-elsewhere.example'
const DEPLOYMENT_HOST = 'prompt-piggy-abc123-kurt.vercel.app'
const BRANCH_HOST = 'prompt-piggy-git-feature-kurt.vercel.app'
const NAMES = ['NEXT_PUBLIC_APP_URL', 'VERCEL_ENV', 'VERCEL_URL', 'VERCEL_BRANCH_URL'] as const

beforeEach(() => {
  vi.resetModules()
  for (const name of NAMES) vi.stubEnv(name, undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

type Target = {
  /** The request URL; defaults to the app origin. */
  url?: string
  /** Extra request headers, such as host or x-forwarded-host. */
  headers?: Record<string, string>
}

function post(origin: string | null, target: Target = {}): Request {
  const headers = new Headers({ 'content-type': 'application/json', ...target.headers })
  if (origin !== null) headers.set('origin', origin)
  return new Request(`${target.url ?? APP}/api/attempts`, { method: 'POST', headers, body: '{}' })
}

async function check(origin: string | null, target?: Target): Promise<boolean> {
  const { assertSameOrigin } = await import('./origin')
  return assertSameOrigin(post(origin, target))
}

/** A request sent to another host, so only the configured origins can accept APP. */
const ELSEWHERE: Target = { url: `https://${OTHER_HOST}` }

function vercel(env: 'production' | 'preview' | 'development') {
  vi.stubEnv('VERCEL_ENV', env)
  vi.stubEnv('VERCEL_URL', DEPLOYMENT_HOST)
  vi.stubEnv('VERCEL_BRANCH_URL', BRANCH_HOST)
}

describe('the request origin, without NEXT_PUBLIC_APP_URL', () => {
  it('accepts an Origin equal to the request URL origin', async () => {
    expect(await check(APP)).toBe(true)
  })

  it('accepts an Origin equal to the Host header origin', async () => {
    expect(await check(`https://${OTHER_HOST}`, { headers: { host: OTHER_HOST } })).toBe(true)
  })

  it('prefers x-forwarded-host and x-forwarded-proto (the Vercel edge)', async () => {
    const forwarded = { host: 'internal.local:8080', 'x-forwarded-host': OTHER_HOST, 'x-forwarded-proto': 'https' }
    expect(await check(`https://${OTHER_HOST}`, { url: 'http://internal.local:8080', headers: forwarded })).toBe(true)
    expect(await check('http://internal.local:8080', { url: 'http://internal.local:8080', headers: forwarded })).toBe(false)
  })

  it('uses the first value of a comma-separated forwarding header', async () => {
    const headers = { 'x-forwarded-host': ` ${OTHER_HOST} , proxy.internal`, 'x-forwarded-proto': 'https, http' }
    expect(await check(`https://${OTHER_HOST}`, { headers })).toBe(true)
    expect(await check('https://proxy.internal', { headers })).toBe(false)
  })

  it('accepts a local http origin with a port', async () => {
    expect(await check('http://localhost:3000', { url: 'http://localhost:3000' })).toBe(true)
    expect(await check('http://localhost:3001', { url: 'http://localhost:3000' })).toBe(false)
  })

  it('treats the default port as no port', async () => {
    expect(await check(APP, { headers: { host: 'prompt-piggy.example:443' } })).toBe(true)
  })

  it.each([
    ['a missing Origin', null],
    ['Origin: null', 'null'],
    ['an empty Origin', ''],
    ['an Origin of a different host', 'https://evil.example'],
    ['a look-alike subdomain', 'https://prompt-piggy.example.evil.example'],
    ['another scheme', 'http://prompt-piggy.example'],
    ['another port', 'https://prompt-piggy.example:8443'],
    ['an origin with a path', `${APP}/play`],
    ['an origin with a trailing slash', `${APP}/`],
    ['an origin with credentials', 'https://user@prompt-piggy.example'],
    ['garbage', 'not a url'],
  ])('refuses %s', async (_label, origin) => {
    expect(await check(origin)).toBe(false)
  })

  it('refuses http when the forwarded scheme is https', async () => {
    expect(await check('http://prompt-piggy.example', { headers: { 'x-forwarded-proto': 'https' } })).toBe(false)
  })

  it('refuses https when the forwarded scheme is http', async () => {
    expect(await check(APP, { headers: { 'x-forwarded-proto': 'http' } })).toBe(false)
  })

  it.each([
    ['a host with credentials', { host: 'user@evil.example' }, 'https://evil.example'],
    ['a host with a path', { host: 'evil.example/x' }, 'https://evil.example'],
    ['a forwarded host with credentials', { 'x-forwarded-host': 'prompt-piggy.example@evil.example' }, 'https://evil.example'],
    ['a host with a bad port', { host: 'prompt-piggy.example:99999' }, APP],
    ['a forwarded scheme that is not http(s)', { 'x-forwarded-proto': 'ftp' }, 'ftp://prompt-piggy.example'],
  ])('refuses an unparseable request origin: %s', async (_label, headers, origin) => {
    expect(await check(origin, { headers })).toBe(false)
  })

  it('never accepts because of the Referer header', async () => {
    expect(await check(null, { headers: { referer: `${APP}/play` } })).toBe(false)
    expect(await check('https://evil.example', { headers: { referer: `${APP}/play` } })).toBe(false)
  })
})

describe('the app origin', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP)
  })

  it('accepts the NEXT_PUBLIC_APP_URL origin on a request to another host', async () => {
    expect(await check(APP, ELSEWHERE)).toBe(true)
  })

  it('accepts it when NEXT_PUBLIC_APP_URL has a trailing slash', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', `${APP}/`)
    expect(await check(APP, ELSEWHERE)).toBe(true)
  })

  it('accepts a local http origin', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
    expect(await check('http://localhost:3000', ELSEWHERE)).toBe(true)
    expect(await check('http://localhost:3001', ELSEWHERE)).toBe(false)
  })

  it.each([
    ['a missing Origin', null],
    ['Origin: null', 'null'],
    ['an empty Origin', ''],
    ['a foreign origin', 'https://evil.example'],
    ['a look-alike subdomain', 'https://prompt-piggy.example.evil.example'],
    ['a parent-domain suffix', 'https://evil-prompt-piggy.example'],
    ['another scheme', 'http://prompt-piggy.example'],
    ['another port', 'https://prompt-piggy.example:8443'],
    ['an origin with a path', `${APP}/play`],
    ['an origin with a trailing slash', `${APP}/`],
    ['an origin with credentials', 'https://user@prompt-piggy.example'],
    ['garbage', 'not a url'],
  ])('refuses %s', async (_label, origin) => {
    expect(await check(origin, ELSEWHERE)).toBe(false)
  })
})

describe('Vercel previews (R2-10)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP)
  })

  it('accepts the deployment URL and the branch alias on a preview', async () => {
    vercel('preview')
    expect(await check(`https://${DEPLOYMENT_HOST}`, ELSEWHERE)).toBe(true)
    expect(await check(`https://${BRANCH_HOST}`, ELSEWHERE)).toBe(true)
    expect(await check(APP, ELSEWHERE)).toBe(true)
  })

  it('accepts a preview origin even without NEXT_PUBLIC_APP_URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined)
    vercel('preview')
    expect(await check(`https://${BRANCH_HOST}`, ELSEWHERE)).toBe(true)
  })

  it('refuses http for the preview hosts', async () => {
    vercel('preview')
    expect(await check(`http://${DEPLOYMENT_HOST}`, ELSEWHERE)).toBe(false)
    expect(await check(`http://${BRANCH_HOST}`, ELSEWHERE)).toBe(false)
  })

  it.each(['production', 'development'] as const)(
    'refuses both preview origins on a request to another host when VERCEL_ENV is %s',
    async (env) => {
      vercel(env)
      expect(await check(`https://${DEPLOYMENT_HOST}`, ELSEWHERE)).toBe(false)
      expect(await check(`https://${BRANCH_HOST}`, ELSEWHERE)).toBe(false)
      expect(await check(APP, ELSEWHERE)).toBe(true)
    }
  )

  it('refuses both preview origins on a request to another host when VERCEL_ENV is unset', async () => {
    vi.stubEnv('VERCEL_URL', DEPLOYMENT_HOST)
    vi.stubEnv('VERCEL_BRANCH_URL', BRANCH_HOST)
    expect(await check(`https://${DEPLOYMENT_HOST}`, ELSEWHERE)).toBe(false)
    expect(await check(`https://${BRANCH_HOST}`, ELSEWHERE)).toBe(false)
  })

  it('accepts a production deployment URL when the request was sent to it', async () => {
    vercel('production')
    expect(await check(`https://${DEPLOYMENT_HOST}`, { url: `https://${DEPLOYMENT_HOST}` })).toBe(true)
  })

  it('refuses another vercel.app deployment on a preview', async () => {
    vercel('preview')
    expect(await check('https://someone-else-git-main.vercel.app', ELSEWHERE)).toBe(false)
  })
})

describe('fail closed without configuration', () => {
  it('refuses an origin other than the request origin when NEXT_PUBLIC_APP_URL is unset outside previews', async () => {
    expect(await check(APP, ELSEWHERE)).toBe(false)
  })

  it.each(['ftp://prompt-piggy.example', `${APP}/app`, `${APP}?x=1`, 'not a url'])(
    'adds no app origin when NEXT_PUBLIC_APP_URL is %s',
    async (value) => {
      vi.stubEnv('NEXT_PUBLIC_APP_URL', value)
      expect(await check(APP, ELSEWHERE)).toBe(false)
    }
  )

  it('lists the allowed origins', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP)
    vercel('preview')
    const { allowedOrigins } = await import('./origin')
    expect([...allowedOrigins()].sort()).toEqual(
      [APP, `https://${BRANCH_HOST}`, `https://${DEPLOYMENT_HOST}`].sort()
    )
  })
})
