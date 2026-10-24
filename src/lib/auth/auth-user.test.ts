import { describe, expect, it, vi } from 'vitest'
import type { ServerSupabaseClient } from './require-user'
import { FALLBACK_DISPLAY_NAME, loadAuthUser, safeAvatarUrl, toAuthUser } from './auth-user'

/**
 * The client-safe user the (game) layout hands to AuthProvider (REVIEW-1
 * R1-13; R2-06): `{ userId, displayName, avatarUrl }` and nothing else.
 */
const ID = '00000000-0000-4000-8000-000000000003'
const AVATAR = 'https://lh3.googleusercontent.com/a/ACg8ocK-example=s96-c'

function profileClient(result: { data: unknown; error: unknown } | Error) {
  const maybeSingle = vi.fn(async () => {
    if (result instanceof Error) throw result
    return result
  })
  const eq = vi.fn(() => ({ maybeSingle }))
  const select = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ select }))
  return { client: { from } as unknown as ServerSupabaseClient, from, select, eq }
}

describe('toAuthUser', () => {
  it('keeps exactly userId, displayName, and avatarUrl', () => {
    const user = {
      id: ID,
      email: 'player@example.com',
      user_metadata: { full_name: 'Edited Name' },
      access_token: 'x'.repeat(8),
    }
    const result = toAuthUser(user, { display_name: 'Pat Player', avatar_url: AVATAR, live_hidden: true } as never)
    expect(result).toEqual({ userId: ID, displayName: 'Pat Player', avatarUrl: AVATAR })
    expect(Object.keys(result).sort()).toEqual(['avatarUrl', 'displayName', 'userId'])
  })

  it('falls back to a generic name and no avatar without a profile', () => {
    expect(toAuthUser({ id: ID }, null)).toEqual({ userId: ID, displayName: FALLBACK_DISPLAY_NAME, avatarUrl: null })
  })

  it('never takes the name from user_metadata', () => {
    const user = { id: ID, user_metadata: { full_name: 'Mallory', name: 'Mallory' } }
    expect(toAuthUser(user, null).displayName).toBe(FALLBACK_DISPLAY_NAME)
  })

  it('trims the name and falls back on a blank one', () => {
    expect(toAuthUser({ id: ID }, { display_name: '  Pat  ' }).displayName).toBe('Pat')
    expect(toAuthUser({ id: ID }, { display_name: '   ' }).displayName).toBe(FALLBACK_DISPLAY_NAME)
    expect(toAuthUser({ id: ID }, { display_name: 42 }).displayName).toBe(FALLBACK_DISPLAY_NAME)
  })
})

describe('safeAvatarUrl', () => {
  it('accepts a Google account photo over https', () => {
    expect(safeAvatarUrl(AVATAR)).toBe(AVATAR)
  })

  it.each([
    ['http', AVATAR.replace('https:', 'http:')],
    ['another host', 'https://evil.example/a.png'],
    ['a look-alike host', 'https://lh3.googleusercontent.com.evil.example/a.png'],
    ['a wildcard sibling host', 'https://lh4.googleusercontent.com/a/x'],
    ['credentials', 'https://user:pass@lh3.googleusercontent.com/a/x'],
    ['a port', 'https://lh3.googleusercontent.com:8443/a/x'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['an empty string', ''],
    ['not a string', 7],
    ['not a URL', 'lh3.googleusercontent.com/a/x'],
  ])('rejects %s', (_label, value) => {
    expect(safeAvatarUrl(value)).toBeNull()
  })
})

describe('loadAuthUser', () => {
  it("reads only the caller's own profile row", async () => {
    const fake = profileClient({ data: { display_name: 'Pat', avatar_url: AVATAR }, error: null })
    expect(await loadAuthUser(fake.client, { id: ID })).toEqual({ userId: ID, displayName: 'Pat', avatarUrl: AVATAR })
    expect(fake.from).toHaveBeenCalledWith('profiles')
    expect(fake.select).toHaveBeenCalledWith('display_name, avatar_url')
    expect(fake.eq).toHaveBeenCalledWith('id', ID)
  })

  it('falls back when the row is missing, unreadable, or the query throws', async () => {
    const fallback = { userId: ID, displayName: FALLBACK_DISPLAY_NAME, avatarUrl: null }
    expect(await loadAuthUser(profileClient({ data: null, error: null }).client, { id: ID })).toEqual(fallback)
    expect(await loadAuthUser(profileClient({ data: null, error: { code: '42501' } }).client, { id: ID })).toEqual(
      fallback
    )
    expect(await loadAuthUser(profileClient(new Error('offline')).client, { id: ID })).toEqual(fallback)
  })
})
