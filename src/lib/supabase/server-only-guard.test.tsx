import { describe, expect, it } from 'vitest'

/**
 * REVIEW-PR2-r2 P2R-02. This file runs in the `ui` Vitest project, which
 * resolves packages with the default (browser) export conditions, the way a
 * Client Component bundle does. Under those conditions `server-only` resolves
 * to a module that throws, which is what turns an import from a Client
 * Component into a build error. The server project resolves it to a no-op.
 */
const CLIENT_IMPORT_ERROR = /cannot be imported from a Client Component module/

describe('server-only guard under the browser export conditions', () => {
  it('env.server.ts, the secret-key reader, cannot be imported', async () => {
    await expect(import('./env.server')).rejects.toThrow(CLIENT_IMPORT_ERROR)
  })

  it('admin.ts, the secret-key client, cannot be imported', async () => {
    await expect(import('./admin')).rejects.toThrow(CLIENT_IMPORT_ERROR)
  })

  it('env.ts, the public settings that the browser client needs, can be imported', async () => {
    const env = await import('./env')
    expect(typeof env.readPublicSupabaseEnv).toBe('function')
    expect(env).not.toHaveProperty('resolveSupabaseSecretKey')
  })
})
