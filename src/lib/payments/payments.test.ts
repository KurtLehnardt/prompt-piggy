import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The coming-soon rails (docs/ARCHITECTURE.md section 10; CH-4). Each test
 * re-imports the factory so the cached server settings start empty.
 */
beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('PAYMENTS_MODE', undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function load() {
  return import('./index')
}

const REQUEST = { userId: '00000000-0000-4000-8000-000000000001', amountCents: 500, idempotencyKey: '00000000-0000-4000-8000-000000000002' }

describe('getPaymentRail', () => {
  it.each(['stripe', 'lightning'] as const)('returns a %s rail whose deposit and withdraw are coming soon with zero I/O', async (id) => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { getPaymentRail } = await load()
    const rail = getPaymentRail(id)
    expect(rail.id).toBe(id)
    await expect(rail.deposit(REQUEST)).resolves.toEqual({ status: 'coming_soon', rail: id })
    await expect(rail.withdraw(REQUEST)).resolves.toEqual({ status: 'coming_soon', rail: id })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('accepts an explicit PAYMENTS_MODE=mock', async () => {
    vi.stubEnv('PAYMENTS_MODE', 'mock')
    const { getPaymentRail } = await load()
    await expect(getPaymentRail('stripe').deposit(REQUEST)).resolves.toMatchObject({ status: 'coming_soon' })
  })

  it.each(['live', 'stripe', 'lightning', 'production', 'MOCK'])('throws a message citing legal review for PAYMENTS_MODE=%s', async (mode) => {
    vi.stubEnv('PAYMENTS_MODE', mode)
    const { getPaymentRail } = await load()
    expect(() => getPaymentRail('stripe')).toThrow(/legal review/)
    expect(() => getPaymentRail('lightning')).toThrow(/legal review/)
  })
})

describe('dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>
  const names = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]

  it('has no Stripe SDK', () => {
    expect(names.filter((name) => name === 'stripe' || name.startsWith('@stripe/'))).toEqual([])
  })

  it('has no Lightning or BTC SDK', () => {
    const banned = (name: string) =>
      ['lightning', 'ln-service', 'bitcoinjs-lib'].includes(name) || name.startsWith('@getalby/')
    expect(names.filter(banned)).toEqual([])
  })
})

describe('payment module sources', () => {
  it('contain no network call or payment host', () => {
    for (const file of ['types.ts', 'mock.ts', 'index.ts']) {
      const source = readFileSync(join(process.cwd(), 'src/lib/payments', file), 'utf8')
      expect(source).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|https?:\/\//)
    }
  })
})
