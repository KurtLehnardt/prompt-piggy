import type { CrackCount, CrackEvent } from '@/types/api'

/**
 * Client crack state (HC-A5, CH-1). Cracks come only from server fields; the
 * reducer never computes a transition and never resets cracks on its own.
 */
export type ClientGameState = {
  cracks: CrackCount
  lastEvent: CrackEvent
  shatterOpen: boolean
  /** Highest sequence applied; duplicates and older updates are ignored. */
  lastSeq: number
}

export type ClientGameAction =
  | { type: 'attempt'; seq: number; cracks: CrackCount; crackEvent: CrackEvent }
  | { type: 'repaired'; seq: number }
  | { type: 'dismissShatter' }

export function initialClientState(serverCracks: CrackCount): ClientGameState {
  return { cracks: serverCracks, lastEvent: 'none', shatterOpen: false, lastSeq: 0 }
}

export function clientStateReducer(state: ClientGameState, action: ClientGameAction): ClientGameState {
  switch (action.type) {
    case 'attempt': {
      if (action.seq <= state.lastSeq) return state
      const opens = action.crackEvent === 'shatter' && state.cracks !== 3
      return {
        cracks: action.cracks,
        lastEvent: action.crackEvent,
        shatterOpen: opens ? true : state.shatterOpen,
        lastSeq: action.seq,
      }
    }
    case 'repaired': {
      if (action.seq <= state.lastSeq) return state
      return { cracks: 0, lastEvent: 'repaired', shatterOpen: false, lastSeq: action.seq }
    }
    case 'dismissShatter':
      return state.shatterOpen ? { ...state, shatterOpen: false } : state
  }
}
