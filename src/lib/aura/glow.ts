/** Aura glow geometry (CH-2). Spread plus blur never exceeds 10 px. */

export type Glow = { spreadPx: number; blurPx: number; opacity: number }

export const MAX_GLOW_PX = 10
/** The pulse class applies at aura 0.5 and above. */
export const PULSE_THRESHOLD = 0.5

export function auraFraction(auraBps: number): number {
  if (!Number.isFinite(auraBps)) return 0
  return Math.min(1, Math.max(0, auraBps / 10000))
}

export function glowFor(auraBps: number): Glow {
  const a = auraFraction(auraBps)
  if (a <= 0) return { spreadPx: 0, blurPx: 0, opacity: 0 }
  return { spreadPx: Math.round(4 * a), blurPx: Math.round(6 * a), opacity: 0.25 + 0.75 * a }
}

export function shouldPulse(auraBps: number): boolean {
  return auraFraction(auraBps) >= PULSE_THRESHOLD
}
