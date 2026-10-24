'use client'

import { useEffect, useRef, useState } from 'react'
import type { AttemptOutcome } from '@/types/api'
import { dampingForRatio, isSettled, stepSpring, type SpringState } from '@/lib/animation/spring'
import { Hammer } from './hammer'
import { PiggyBank, type PigReaction } from './piggy-bank'
import styles from './strike-scene.module.css'

export type StrikeSceneProps = {
  /** A new value triggers exactly one swing. */
  strikeKey: string | number | null
  /** Server outcome of the latest attempt; null before any. */
  outcome: AttemptOutcome | null
}

const REST = -40
const HIT = 25
const CONFIG = { stiffness: 220, damping: dampingForRatio(220, 0.6) }

export function reactionFor(outcome: AttemptOutcome | null): PigReaction {
  return outcome ?? 'idle'
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function StrikeScene({ strikeKey, outcome }: StrikeSceneProps) {
  const [angle, setAngle] = useState(REST)
  const [swings, setSwings] = useState(0)
  const first = useRef(true)

  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    setSwings((n) => n + 1)
    if (prefersReducedMotion()) return
    let raf = 0
    let last: number | null = null
    let phase: 'down' | 'back' = 'down'
    let s: SpringState = { x: REST, v: 0 }
    const tick = (now: number) => {
      const dt = last === null ? 1 / 60 : (now - last) / 1000
      last = now
      const target = phase === 'down' ? HIT : REST
      s = stepSpring(s, target, CONFIG, dt)
      setAngle(s.x)
      if (phase === 'down' && s.x >= HIT - 2) phase = 'back'
      if (phase === 'back' && isSettled(s, REST, 0.5)) {
        setAngle(REST)
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [strikeKey])

  const reaction = reactionFor(outcome)
  const shake = swings > 0 && outcome !== null
  return (
    <div className={styles.scene} data-testid="strike-scene" data-swings={swings} data-reaction={reaction}>
      <div className={styles.hammer}>
        <Hammer angleDeg={angle} />
      </div>
      <div key={swings} className={`${styles.pig} ${shake ? styles.shake : ''}`}>
        <PiggyBank reaction={reaction} />
      </div>
    </div>
  )
}
