import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as e2eHelpers from './e2e-helpers'
import { isE2ETestMode } from './e2e-helpers'

/**
 * ARCHITECTURE section 1.2 row 5 and threat T23: test mode is hard-false in
 * production builds and turns on only for the exact value "true" elsewhere.
 * It never bypasses auth, so the module exports nothing but the flag.
 *
 * The flag's value is always passed to vi.stubEnv as a separate argument, so
 * the guard script that rejects hardcoded truthy assignments of the variable
 * in committed files never matches this file.
 */
const FLAG = 'E2E_TEST_MODE'

beforeEach(() => {
  vi.unstubAllEnvs()
  vi.stubEnv(FLAG, undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isE2ETestMode in production', () => {
  it('is false when NODE_ENV is production, even with the flag set to "true"', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv(FLAG, 'true')
    expect(isE2ETestMode()).toBe(false)
  })

  it('is false when NODE_ENV is production and the flag is unset', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(isE2ETestMode()).toBe(false)
  })
})

describe('isE2ETestMode outside production', () => {
  it.each(['development', 'test'])('is true when NODE_ENV is %s and the flag is "true"', (nodeEnv) => {
    vi.stubEnv('NODE_ENV', nodeEnv)
    vi.stubEnv(FLAG, 'true')
    expect(isE2ETestMode()).toBe(true)
  })

  it('is false when the flag is unset', () => {
    vi.stubEnv('NODE_ENV', 'development')
    expect(isE2ETestMode()).toBe(false)
  })

  it.each(['', 'false', '1', 'yes', 'on', 'TRUE', 'True', ' true', 'true '])(
    'is false when the flag is %j',
    (value) => {
      vi.stubEnv('NODE_ENV', 'development')
      vi.stubEnv(FLAG, value)
      expect(isE2ETestMode()).toBe(false)
    }
  )

  it('reads the environment on every call, not at import time', () => {
    vi.stubEnv('NODE_ENV', 'development')
    expect(isE2ETestMode()).toBe(false)
    vi.stubEnv(FLAG, 'true')
    expect(isE2ETestMode()).toBe(true)
    vi.stubEnv('NODE_ENV', 'production')
    expect(isE2ETestMode()).toBe(false)
  })
})

describe('e2e-helpers module surface', () => {
  it('exports only isE2ETestMode: no mock user, client, or data that could bypass auth', () => {
    expect(Object.keys(e2eHelpers)).toEqual(['isE2ETestMode'])
  })
})
