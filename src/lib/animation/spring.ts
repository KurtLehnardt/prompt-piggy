/** Pure semi-implicit Euler spring integrator. No animation library (CH-7). */

export type SpringState = { x: number; v: number }
export type SpringConfig = { stiffness: number; damping: number }

/** dt is clamped to this many seconds so a stalled frame cannot blow up the integration. */
export const MAX_DT = 1 / 30

/** Damping coefficient for a given stiffness and damping ratio. */
export function dampingForRatio(stiffness: number, ratio: number): number {
  return 2 * ratio * Math.sqrt(stiffness)
}

export function stepSpring(state: SpringState, target: number, config: SpringConfig, dtSeconds: number): SpringState {
  const dt = Number.isFinite(dtSeconds) ? Math.min(Math.max(dtSeconds, 0), MAX_DT) : 0
  const accel = -config.stiffness * (state.x - target) - config.damping * state.v
  const v = state.v + accel * dt
  const x = state.x + v * dt
  return { x, v }
}

export function isSettled(state: SpringState, target: number, tolerance = 0.001): boolean {
  return Math.abs(state.x - target) <= tolerance && Math.abs(state.v) <= tolerance
}
