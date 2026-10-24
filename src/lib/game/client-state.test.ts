import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clientStateReducer as r, initialClientState } from './client-state'

describe('clientStateReducer', () => {
  it('starts from the server value', () => {
    expect(initialClientState(2).cracks).toBe(2)
  })
  it('crack, crack, shatter opens the dialog once', () => {
    let s = initialClientState(0)
    s = r(s, { type: 'attempt', seq: 1, cracks: 1, crackEvent: 'crack' })
    s = r(s, { type: 'attempt', seq: 2, cracks: 2, crackEvent: 'crack' })
    expect(s.shatterOpen).toBe(false)
    s = r(s, { type: 'attempt', seq: 3, cracks: 3, crackEvent: 'shatter' })
    expect(s.cracks).toBe(3)
    expect(s.shatterOpen).toBe(true)
    s = r(s, { type: 'dismissShatter' })
    s = r(s, { type: 'attempt', seq: 4, cracks: 3, crackEvent: 'none' })
    expect(s.cracks).toBe(3)
    expect(s.shatterOpen).toBe(false)
    s = r(s, { type: 'attempt', seq: 5, cracks: 3, crackEvent: 'shatter' })
    expect(s.shatterOpen).toBe(false)
  })
  it('repair sets 0 with event repaired', () => {
    let s = initialClientState(3)
    s = r(s, { type: 'repaired', seq: 1 })
    expect(s).toMatchObject({ cracks: 0, lastEvent: 'repaired', shatterOpen: false })
  })
  it('ignores duplicate or older sequences', () => {
    let s = initialClientState(0)
    s = r(s, { type: 'attempt', seq: 5, cracks: 1, crackEvent: 'crack' })
    expect(r(s, { type: 'attempt', seq: 5, cracks: 2, crackEvent: 'crack' })).toBe(s)
    expect(r(s, { type: 'attempt', seq: 4, cracks: 3, crackEvent: 'shatter' })).toBe(s)
    expect(r(s, { type: 'repaired', seq: 2 })).toBe(s)
  })
  it('displayed cracks equal the server value, even when it drops without repair', () => {
    let s = initialClientState(2)
    s = r(s, { type: 'attempt', seq: 1, cracks: 2, crackEvent: 'none' })
    expect(s.cracks).toBe(2)
  })
})

describe('no browser storage for cracks', () => {
  it('no PP-15 file uses localStorage or sessionStorage', () => {
    const files = [
      'src/components/game/piggy-bank.tsx', 'src/components/game/hammer.tsx', 'src/components/game/strike-scene.tsx',
      'src/components/game/crack-overlay.tsx', 'src/components/game/crack-paths.ts', 'src/components/game/shatter-dialog.tsx',
      'src/components/game/repair-button.tsx', 'src/components/player/avatar-glow.tsx', 'src/components/wallet/wallet-panel.tsx',
      'src/components/wallet/coming-soon-menu.tsx', 'src/components/wallet/donate-dialog.tsx', 'src/lib/game/client-state.ts',
    ].map((f) => join(process.cwd(), f))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) expect(readFileSync(f, 'utf8')).not.toMatch(/localStorage|sessionStorage/)
  })
})
