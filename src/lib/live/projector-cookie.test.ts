import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The projector cookie (ARCHITECTURE sections 7 and 12.2; T32; R2-07,
 * R3-10; PR #6 review, M1). Each test re-imports the module so the cached
 * server settings start empty.
 */
const TOKEN = 'fake-projector-token-0123456789abcdef'
const OTHER = 'fake-projector-token-rotated-0123456789'
const NOW = Date.UTC(2026, 9, 24, 12, 0, 0)

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('LIVE_VIEW_TOKEN', TOKEN)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function load() {
  return import('./projector-cookie')
}

describe('signProjectorCookie and verifyProjectorCookie', () => {
  it('signs v1.<expiry>.<base64url HMAC-SHA256 of v1.<expiry> keyed by the token>, 12 hours ahead', async () => {
    const { signProjectorCookie, PROJECTOR_COOKIE_MAX_AGE } = await load()
    const value = signProjectorCookie(TOKEN, NOW)
    const expiry = Math.floor(NOW / 1000) + PROJECTOR_COOKIE_MAX_AGE
    const mac = createHmac('sha256', TOKEN).update(`v1.${expiry}`).digest('base64url')
    expect(PROJECTOR_COOKIE_MAX_AGE).toBe(43_200)
    expect(value).toBe(`v1.${expiry}.${mac}`)
  })

  it('never holds the token itself', async () => {
    const { signProjectorCookie } = await load()
    const value = signProjectorCookie(TOKEN, NOW)
    expect(value).not.toContain(TOKEN)
    expect(value).not.toContain(Buffer.from(TOKEN).toString('base64url'))
  })

  it('verifies a fresh cookie until it expires', async () => {
    const { signProjectorCookie, verifyProjectorCookie } = await load()
    const value = signProjectorCookie(TOKEN, NOW)
    expect(verifyProjectorCookie(value, TOKEN, NOW)).toBe(true)
    expect(verifyProjectorCookie(value, TOKEN, NOW + 43_199_000)).toBe(true)
    expect(verifyProjectorCookie(value, TOKEN, NOW + 43_200_000)).toBe(false)
    expect(verifyProjectorCookie(value, TOKEN, NOW + 86_400_000)).toBe(false)
  })

  it('rejects a cookie signed with a wrong key', async () => {
    const { signProjectorCookie, verifyProjectorCookie } = await load()
    expect(verifyProjectorCookie(signProjectorCookie(OTHER, NOW), TOKEN, NOW)).toBe(false)
  })

  it('rejects a cookie after the token is rotated', async () => {
    const { signProjectorCookie, verifyProjectorCookie } = await load()
    const issued = signProjectorCookie(TOKEN, NOW)
    expect(verifyProjectorCookie(issued, OTHER, NOW + 1000)).toBe(false)
  })

  it('rejects a tampered expiry and a tampered MAC', async () => {
    const { signProjectorCookie, verifyProjectorCookie } = await load()
    const [version, expiry, mac] = signProjectorCookie(TOKEN, NOW).split('.')
    const later = String(Number(expiry) + 3600)
    expect(verifyProjectorCookie(`${version}.${later}.${mac}`, TOKEN, NOW)).toBe(false)
    const flipped = (mac[0] === 'A' ? 'B' : 'A') + mac.slice(1)
    expect(verifyProjectorCookie(`${version}.${expiry}.${flipped}`, TOKEN, NOW)).toBe(false)
  })

  it('rejects a far-future expiry even with a valid MAC', async () => {
    const { verifyProjectorCookie } = await load()
    const expiry = Math.floor(NOW / 1000) + 10 * 43_200
    const mac = createHmac('sha256', TOKEN).update(`v1.${expiry}`).digest('base64url')
    expect(verifyProjectorCookie(`v1.${expiry}.${mac}`, TOKEN, NOW)).toBe(false)
  })

  it.each([
    ['undefined', undefined],
    ['an empty string', ''],
    ['the token itself', TOKEN],
    ['a wrong version', 'v2.1792843200.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['a short MAC', 'v1.1792843200.AAAA'],
    ['padding', 'v1.1792843200.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='],
    ['a number', 1792843200],
    ['a very long value', `v1.1792843200.${'A'.repeat(500)}`],
  ])('rejects %s', async (_label, value) => {
    const { verifyProjectorCookie } = await load()
    expect(verifyProjectorCookie(value, TOKEN, NOW)).toBe(false)
  })

  it('verifies nothing without a key, even an empty key against an empty-key cookie', async () => {
    const { signProjectorCookie, verifyProjectorCookie } = await load()
    const value = signProjectorCookie(TOKEN, NOW)
    expect(verifyProjectorCookie(value, '', NOW)).toBe(false)
    expect(verifyProjectorCookie(value, undefined, NOW)).toBe(false)
    expect(() => signProjectorCookie('', NOW)).toThrow()
  })
})

describe('hasProjectorAccess and readProjectorToken (fail closed, M1)', () => {
  it('accepts a cookie signed with the configured token', async () => {
    const { hasProjectorAccess, signProjectorCookie } = await load()
    expect(hasProjectorAccess(signProjectorCookie(TOKEN, NOW), NOW)).toBe(true)
  })

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['too short (invalid)', 'fake-short'],
  ])('denies everything when LIVE_VIEW_TOKEN is %s', async (_label, value) => {
    vi.stubEnv('LIVE_VIEW_TOKEN', value)
    const { hasProjectorAccess, readProjectorToken, signProjectorCookie } = await load()
    expect(readProjectorToken()).toBeNull()
    expect(hasProjectorAccess(signProjectorCookie(TOKEN, NOW), NOW)).toBe(false)
    expect(hasProjectorAccess(undefined, NOW)).toBe(false)
  })

  it('reads the token only through requireEnv and never stringifies getEnv()', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('./projector-cookie.ts', import.meta.url), 'utf8')
    expect(source).toContain("requireEnv('LIVE_VIEW_TOKEN')")
    expect(source).not.toMatch(/getEnv\(/)
    expect(source).not.toMatch(/JSON\.stringify|console\./)
    expect(source).toContain('timingSafeEqual(presented, expected)')
  })
})
