import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CANARY_BODY_LENGTH,
  CANARY_FORMAT,
  CANARY_PATTERN,
  CROCKFORD_ALPHABET,
  canary,
  canaryBody,
  isCanary,
} from '@/lib/security/canary'
import { NONCE_PATTERN, isNonce, nonce } from '@/lib/security/nonce'

/** The pattern from the PP-10 acceptance criteria, written out independently. */
const ACCEPTANCE_CANARY = /^PP-[0-9A-HJKMNP-TV-Z]{20}$/
const ACCEPTANCE_NONCE = /^[0-9a-f]{32}$/

describe('canary()', () => {
  it('matches the acceptance pattern and has no duplicate in 10,000 calls', () => {
    const seen = new Set<string>()
    for (let index = 0; index < 10_000; index += 1) {
      const value = canary()
      expect(value).toMatch(ACCEPTANCE_CANARY)
      seen.add(value)
    }
    expect(seen.size).toBe(10_000)
  })

  it('uses every Crockford character at every body position', () => {
    const perPosition = Array.from({ length: CANARY_BODY_LENGTH }, () => new Set<string>())
    for (let index = 0; index < 10_000; index += 1) {
      const body = canaryBody(canary())
      for (let position = 0; position < body.length; position += 1) {
        perPosition[position].add(body[position])
      }
    }
    for (const seen of perPosition) expect(seen.size).toBe(32)
  })

  it('uses the Crockford alphabet, which has no I, L, O, or U', () => {
    expect(CROCKFORD_ALPHABET).toHaveLength(32)
    expect(new Set(CROCKFORD_ALPHABET).size).toBe(32)
    expect(CROCKFORD_ALPHABET).not.toMatch(/[ILOU]/)
    expect(CANARY_FORMAT.entropyBits).toBe(100)
    expect(CANARY_PATTERN.source).toBe(ACCEPTANCE_CANARY.source)
  })

  it('checks and splits the canary shape', () => {
    expect(isCanary('PP-FAKECANARY0123456789')).toBe(true)
    expect(isCanary('PP-FAKECANARY012345678')).toBe(false)
    expect(isCanary('PP-FAKECANARYO123456789')).toBe(false)
    expect(isCanary('pp-fakecanary0123456789')).toBe(false)
    expect(isCanary(42)).toBe(false)
    expect(canaryBody('PP-FAKECANARY0123456789')).toBe('FAKECANARY0123456789')
    expect(() => canaryBody('PP-short')).toThrow(TypeError)
  })
})

describe('nonce()', () => {
  it('returns 32 lowercase hex characters with no duplicate in 10,000 calls', () => {
    const seen = new Set<string>()
    for (let index = 0; index < 10_000; index += 1) {
      const value = nonce()
      expect(value).toMatch(ACCEPTANCE_NONCE)
      seen.add(value)
    }
    expect(seen.size).toBe(10_000)
    expect(NONCE_PATTERN.source).toBe(ACCEPTANCE_NONCE.source)
    expect(isNonce('0'.repeat(32))).toBe(true)
    expect(isNonce('A'.repeat(32))).toBe(false)
    expect(isNonce('0'.repeat(31))).toBe(false)
  })
})

describe('the random source is crypto.randomBytes', () => {
  afterEach(() => {
    vi.doUnmock('node:crypto')
    vi.resetModules()
  })

  async function withRandomBytes(fill: (size: number) => Buffer) {
    vi.resetModules()
    const randomBytes = vi.fn(fill)
    vi.doMock('node:crypto', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:crypto')>()),
      randomBytes,
    }))
    const canaryModule = await import('@/lib/security/canary')
    const nonceModule = await import('@/lib/security/nonce')
    return { randomBytes, canary: canaryModule.canary, nonce: nonceModule.nonce }
  }

  it('builds the canary body from 13 random bytes, most significant bit first', async () => {
    const zeros = await withRandomBytes((size) => Buffer.alloc(size, 0x00))
    expect(zeros.canary()).toBe('PP-' + '0'.repeat(20))
    expect(zeros.randomBytes).toHaveBeenCalledWith(13)

    const ones = await withRandomBytes((size) => Buffer.alloc(size, 0xff))
    expect(ones.canary()).toBe('PP-' + 'Z'.repeat(20))

    // These bytes hold the 5-bit groups 1, 2, 3, ..., 20 followed by 4 spare
    // zero bits, so the body counts 1 to 20 in Crockford base32.
    const counting = await withRandomBytes(() =>
      Buffer.from([0x08, 0x86, 0x42, 0x98, 0xe8, 0x4a, 0x96, 0xc6, 0xb9, 0xf0, 0x8c, 0xa7, 0x40])
    )
    expect(counting.canary()).toBe('PP-123456789ABCDEFGHJKM')
  })

  it('builds the nonce from 16 random bytes', async () => {
    const mocked = await withRandomBytes((size) => Buffer.alloc(size, 0xab))
    expect(mocked.nonce()).toBe('ab'.repeat(16))
    expect(mocked.randomBytes).toHaveBeenCalledWith(16)
  })
})
