import { describe, expect, it } from 'vitest'
import { DEFAULT_REDIRECT_PATH, safeRedirect, safeRedirectPath } from './safe-redirect'

/**
 * Open-redirect defense for /auth/callback?next= (docs/ARCHITECTURE.md
 * section 11, T17; REVIEW-1 R1-10; REVIEW-3 and PR #6 amendments: mirror
 * PP-01's safeNextPath, including the dot-segment and encoded-slash cases).
 */
const APP = 'https://prompt-piggy.vercel.app'

describe('accepted paths', () => {
  it.each([
    ['/play', '/play'],
    ['/me?x=1', '/me?x=1'],
    ['/me', '/me'],
    ['/play?level=2&tab=feed', '/play?level=2&tab=feed'],
    ['/play/', '/play/'],
    ['/a-b_c.d', '/a-b_c.d'],
    ['/play?q=%41', '/play?q=%41'],
  ])('%j is kept as %j', (input, expected) => {
    expect(safeRedirectPath(input)).toBe(expected)
    expect(safeRedirect(input, APP).href).toBe(`${APP}${expected}`)
  })
})

const REJECTED: [label: string, input: unknown][] = [
  // Missing and empty values.
  ['null', null],
  ['undefined', undefined],
  ['a number', 42],
  ['an object', { next: '/play' }],
  ['the empty string', ''],
  // Not a single leading slash.
  ['a relative path', 'play'],
  ['two slashes', '//evil.com'],
  ['three slashes', '///evil.com'],
  ['just two slashes', '//'],
  ['slash backslash', '/\\evil.com'],
  ['slash and two backslashes (/\\\\evil.com)', '/\\\\evil.com'],
  ['a leading backslash', '\\evil.com'],
  ['backslash slash', '\\/evil.com'],
  // Encoded slashes and backslashes.
  ['an encoded slash', '/%2F/evil.com'],
  ['a lowercase encoded slash', '/%2fevil.com'],
  ['an encoded slash in the query', '/play?next=%2Fevil'],
  ['an encoded backslash', '/%5Cevil.com'],
  ['a lowercase encoded backslash', '/%5cevil.com'],
  ['a double-encoded slash', '/%252F/evil.com'],
  ['a double-encoded backslash', '/%255C/evil.com'],
  // Schemes.
  ['https', 'https://evil.com'],
  ['http with one slash', 'http:/evil.com'],
  ['a scheme-relative host with credentials', '//user:pass@evil.com'],
  ['javascript', 'javascript:alert(1)'],
  ['data', 'data:text/html,hi'],
  ['mailto', 'mailto:someone@example.com'],
  ['a colon in the path', '/play:evil'],
  // Control characters, raw and encoded, before and after one decode.
  ['%09 then a host (/%09/evil.com)', '/%09/evil.com'],
  ['a raw tab then a host', '/\t/evil.com'],
  ['%0d%0a then a host (/%0d%0a//evil.com)', '/%0d%0a//evil.com'],
  ['a raw CR LF', '/\r\n//evil.com'],
  ['a raw NUL', '/play\u0000'],
  ['an encoded NUL', '/play%00'],
  ['a raw DEL', '/play\u007f'],
  ['an encoded DEL', '/play%7f'],
  ['an encoded unit separator', '/play%1F'],
  ['a trailing newline', '/play\n'],
  ['a raw C1 control', '/play\u0085'],
  // Characters outside the allow-list.
  ['a leading space', ' /play'],
  ['an inner space', '/pl ay'],
  ['an encoded space', '/pl%20ay'],
  ['a fragment', '/play#top'],
  ['an at sign', '/play@evil.com'],
  ['a fullwidth letter', '/ｐlay'],
  ['a line separator', '/play '],
  ['a plus sign', '/play+x'],
  ['a tilde', '/~play'],
  // Dot segments, raw and encoded (the PP-01 safeNextPath cases).
  ['/.//evil.com', '/.//evil.com'],
  ['/%2e//evil.com', '/%2e//evil.com'],
  ['/a/..//evil.com', '/a/..//evil.com'],
  ['/%2e%2e//evil.com', '/%2e%2e//evil.com'],
  ['/%2E%2E/evil', '/%2E%2E/evil'],
  ['/../play', '/../play'],
  ['/play/.', '/play/.'],
  ['/play/..', '/play/..'],
  ['/play/./me', '/play/./me'],
  // Malformed percent-encoding.
  ['a lone percent sign', '/50%'],
  ['a truncated escape', '/play%E0%A4%A'],
  // Paths the proxy also refuses as a return target.
  ['/login', '/login'],
  ['/login?next=/play', '/login?next=/play'],
  ['/api/health', '/api/health'],
  ['/api', '/api'],
  // Too long.
  ['a path over 2048 characters', `/${'a'.repeat(2048)}`],
]

describe('rejected values fall back to /play', () => {
  it.each(REJECTED)('%s', (_label, input) => {
    expect(safeRedirectPath(input)).toBe(DEFAULT_REDIRECT_PATH)
    expect(safeRedirect(input, APP).href).toBe(`${APP}/play`)
  })

  it('the default is /play', () => {
    expect(DEFAULT_REDIRECT_PATH).toBe('/play')
  })
})

describe('the result is always the app origin plus a pathname and search', () => {
  const inputs: unknown[] = [...REJECTED.map(([, input]) => input), '/play', '/me?x=1', '/play?a=1&b=2']

  it.each(inputs.map((input) => [JSON.stringify(input) ?? String(input), input]))('%s', (_label, input) => {
    const url = safeRedirect(input, APP)
    expect(url.origin).toBe(APP)
    expect(url.username).toBe('')
    expect(url.password).toBe('')
    expect(url.hash).toBe('')
    expect(url.href).toBe(`${APP}${url.pathname}${url.search}`)
    expect(url.pathname.startsWith('//')).toBe(false)
  })

  it('uses the origin it is given, so a preview keeps its own host', () => {
    const preview = 'https://prompt-piggy-git-feature-kurt.vercel.app'
    expect(safeRedirect('/me?x=1', preview).href).toBe(`${preview}/me?x=1`)
  })

  it('works on a local http origin', () => {
    expect(safeRedirect('/play', 'http://localhost:3000').href).toBe('http://localhost:3000/play')
  })

  it('ignores a path or query on the app origin it is given', () => {
    expect(safeRedirect('/me', `${APP}/somewhere?x=1`).href).toBe(`${APP}/me`)
  })

  it('throws on an app origin that is not http or https', () => {
    expect(() => safeRedirect('/play', 'javascript:alert(1)')).toThrow(TypeError)
    expect(() => safeRedirect('/play', 'not a url')).toThrow(TypeError)
  })
})
