import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Google is the only sign-in method (FACTS section A). PP-05's acceptance
 * says a case-insensitive grep of src for the other provider the reference
 * repo used returns nothing; this test runs that check. The provider's name is
 * built at run time so this file does not match its own check.
 */
const SRC = path.resolve(__dirname, '../..')
const OTHER_PROVIDER = new RegExp(['git', 'hub'].join(''), 'i')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    return statSync(full).isDirectory() ? files(full) : [full]
  })
}

const SOURCES = files(SRC).filter((file) => /\.(?:[cm]?[jt]sx?|css|json)$/.test(file))

describe('Google-only sign-in', () => {
  it('finds the source files', () => {
    expect(SOURCES.length).toBeGreaterThan(20)
  })

  it('no file under src names the other provider', () => {
    const offenders = SOURCES.filter((file) => OTHER_PROVIDER.test(readFileSync(file, 'utf8')))
    expect(offenders.map((file) => path.relative(SRC, file))).toEqual([])
  })

  it('every signInWithOAuth call uses provider google', () => {
    const callers = SOURCES.filter((file) => !/\.test\.tsx?$/.test(file)).filter((file) =>
      /signInWithOAuth\s*\(/.test(readFileSync(file, 'utf8'))
    )
    expect(callers.map((file) => path.relative(SRC, file))).toEqual(['components/auth/google-sign-in-button.tsx'])
    for (const file of callers) {
      const source = readFileSync(file, 'utf8')
      const providers = [...source.matchAll(/provider:\s*['"]([a-z_-]+)['"]/g)].map((match) => match[1])
      expect(providers).toEqual(['google'])
    }
  })

  it('no other sign-in method is called from app code', () => {
    const methods = /\b(?:signInWithOtp|signInWithIdToken|signInWithSSO|signInAnonymously|signInWithWeb3|signUp)\s*\(/
    const offenders = SOURCES.filter((file) => !/\.test\.tsx?$/.test(file)).filter((file) =>
      methods.test(readFileSync(file, 'utf8'))
    )
    expect(offenders.map((file) => path.relative(SRC, file))).toEqual([])
  })

  it('the only password sign-in is the E2E test login', () => {
    const callers = SOURCES.filter((file) => !/\.test\.tsx?$/.test(file)).filter((file) =>
      /signInWithPassword\s*\(/.test(readFileSync(file, 'utf8'))
    )
    expect(callers.map((file) => path.relative(SRC, file))).toEqual(['app/api/test/login/route.ts'])
  })
})
