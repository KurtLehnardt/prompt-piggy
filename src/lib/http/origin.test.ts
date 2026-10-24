import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * assertSameOrigin (docs/ARCHITECTURE.md section 7, R1-04, R2-10). Each test
 * re-imports the modules so the cached server settings start empty.
 */
const APP = 'https://prompt-piggy.example'
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

function post(origin: string | null): Request {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (origin !== null) headers.set('origin', origin)
  return new Request(`${APP}/api/attempts`, { method: 'POST', headers, body: '{}' })
}

async function check(origin: string | null): Promise<boolean> {
  const { assertSameOrigin } = await import('./origin')
  return assertSameOrigin(post(origin))
}

function vercel(env: 'production' | 'preview' | 'development') {
  vi.stubEnv('VERCEL_ENV', env)
  vi.stubEnv('VERCEL_URL', DEPLOYMENT_HOST)
  vi.stubEnv('VERCEL_BRANCH_URL', BRANCH_HOST)
}

describe('the app origin', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP)
  })

  it('accepts the NEXT_PUBLIC_APP_URL origin', async () => {
    expect(await check(APP)).toBe(true)
  })

  it('accepts it when NEXT_PUBLIC_APP_URL has a trailing slash', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', `${APP}/`)
    expect(await check(APP)).toBe(true)
  })

  it('accepts a local http origin', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
    expect(await check('http://localhost:3000')).toBe(true)
    expect(await check('http://localhost:3001')).toBe(false)
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
    expect(await check(origin)).toBe(false)
  })
})

describe('Vercel previews (R2-10)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP)
  })

  it('accepts the deployment URL and the branch alias on a preview', async () => {
    vercel('preview')
    expect(await check(`https://${DEPLOYMENT_HOST}`)).toBe(true)
    expect(await check(`https://${BRANCH_HOST}`)).toBe(true)
    expect(await check(APP)).toBe(true)
  })

  it('accepts a preview origin even without NEXT_PUBLIC_APP_URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined)
    vercel('preview')
    expect(await check(`https://${BRANCH_HOST}`)).toBe(true)
  })

  it('refuses http for the preview hosts', async () => {
    vercel('preview')
    expect(await check(`http://${DEPLOYMENT_HOST}`)).toBe(false)
    expect(await check(`http://${BRANCH_HOST}`)).toBe(false)
  })

  it.each(['production', 'development'] as const)(
    'refuses both preview origins when VERCEL_ENV is %s',
    async (env) => {
      vercel(env)
      expect(await check(`https://${DEPLOYMENT_HOST}`)).toBe(false)
      expect(await check(`https://${BRANCH_HOST}`)).toBe(false)
      expect(await check(APP)).toBe(true)
    }
  )

  it('refuses both preview origins when VERCEL_ENV is unset', async () => {
    vi.stubEnv('VERCEL_URL', DEPLOYMENT_HOST)
    vi.stubEnv('VERCEL_BRANCH_URL', BRANCH_HOST)
    expect(await check(`https://${DEPLOYMENT_HOST}`)).toBe(false)
    expect(await check(`https://${BRANCH_HOST}`)).toBe(false)
  })

  it('refuses another vercel.app deployment on a preview', async () => {
    vercel('preview')
    expect(await check('https://someone-else-git-main.vercel.app')).toBe(false)
  })
})

describe('fail closed without configuration', () => {
  it('refuses every origin when NEXT_PUBLIC_APP_URL is unset outside previews', async () => {
    expect(await check(APP)).toBe(false)
  })

  it.each(['ftp://prompt-piggy.example', `${APP}/app`, `${APP}?x=1`, 'not a url'])(
    'refuses every origin when NEXT_PUBLIC_APP_URL is %s',
    async (value) => {
      vi.stubEnv('NEXT_PUBLIC_APP_URL', value)
      expect(await check(APP)).toBe(false)
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
