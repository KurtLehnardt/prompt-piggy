import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Cron bearer check (docs/ARCHITECTURE.md section 1.2 row 14 and section 11
 * T22; PR #6 review, M1). Each test re-imports the module so the cached server
 * settings start empty.
 */
// Low-entropy test values only: the repository is public and gitleaks scans every file.
const SECRET = 'c'.repeat(32)

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('CRON_SECRET', undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function request(authorization?: string): Request {
  const headers = new Headers()
  if (authorization !== undefined) headers.set('authorization', authorization)
  return new Request('https://prompt-piggy.example/api/cron/daily', { headers })
}

async function verify(authorization?: string) {
  const { verifyCronRequest } = await import('./cron-auth')
  return verifyCronRequest(request(authorization))
}

describe('verifyCronRequest', () => {
  it('accepts the exact bearer token', async () => {
    vi.stubEnv('CRON_SECRET', SECRET)
    expect(await verify(`Bearer ${SECRET}`)).toBeNull()
  })

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['the secret without the Bearer prefix', SECRET],
    ['a wrong secret of the same length', `Bearer ${'d'.repeat(32)}`],
    ['a lowercase scheme', `bearer ${SECRET}`],
    ['two spaces after Bearer', `Bearer  ${SECRET}`],
    ['a different length', `Bearer ${SECRET}0`],
  ])('answers 401 for %s', async (_label, header) => {
    vi.stubEnv('CRON_SECRET', SECRET)
    const response = await verify(header)
    expect(response?.status).toBe(401)
    expect(await response?.json()).toEqual({ error: 'Unauthorized.', code: 'unauthorized' })
  })

  it('answers 401, without throwing, for a multibyte header of the same string length', async () => {
    vi.stubEnv('CRON_SECRET', SECRET)
    const expected = `Bearer ${SECRET}`
    const multibyte = `${expected.slice(0, -1)}é`
    expect(multibyte.length).toBe(expected.length)
    const response = await verify(multibyte)
    expect(response?.status).toBe(401)
  })

  it('answers 500 when CRON_SECRET is unset, whatever the header says', async () => {
    for (const header of [undefined, '', 'Bearer ', 'Bearer undefined', `Bearer ${SECRET}`]) {
      vi.resetModules()
      const response = await verify(header)
      expect(response?.status).toBe(500)
      expect(await response?.json()).toEqual({ error: 'The cron secret is not configured.', code: 'internal' })
    }
  })

  it('answers 500 when CRON_SECRET is empty, so an empty bearer never matches', async () => {
    vi.stubEnv('CRON_SECRET', '')
    expect((await verify('Bearer '))?.status).toBe(500)
  })

  it('answers 500 when CRON_SECRET is too short to be valid', async () => {
    vi.stubEnv('CRON_SECRET', 'short')
    expect((await verify('Bearer short'))?.status).toBe(500)
  })

  it('never echoes or logs the secret', async () => {
    vi.stubEnv('CRON_SECRET', SECRET)
    const response = await verify('Bearer wrong')
    expect(JSON.stringify(await response?.json())).not.toContain(SECRET)
    const logged = vi.mocked(console.error).mock.calls.flat().join(' ')
    expect(logged).not.toContain(SECRET)
  })
})
