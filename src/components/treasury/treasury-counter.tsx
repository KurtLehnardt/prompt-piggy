'use client'

import { useEffect, useRef, useState } from 'react'
import { dampingForRatio, isSettled, stepSpring, type SpringState } from '@/lib/animation/spring'
import { formatCents } from '@/lib/money/format'
import { cn } from '@/lib/utils'

/**
 * The animated treasury counter (docs/ARCHITECTURE.md section 12.2; CH-1).
 * It takes integer cents and always shows a whole number of cents formatted
 * by money/format.ts: the spring moves a number, and each frame rounds it to
 * cents before formatting. Screen readers get the target amount at once.
 * With reduced motion, or without requestAnimationFrame, it jumps.
 */
export type TreasuryCounterProps = {
  /** Integer cents. */
  cents: number
  label?: string
  className?: string
  amountClassName?: string
}

const STIFFNESS = 90
const SPRING = { stiffness: STIFFNESS, damping: dampingForRatio(STIFFNESS, 1) }

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

function safeCents(value: number): number {
  return Number.isSafeInteger(value) ? value : 0
}

export function TreasuryCounter({ cents, label = 'Treasury', className, amountClassName }: TreasuryCounterProps) {
  const target = safeCents(cents)
  const [shown, setShown] = useState(target)
  const springRef = useRef<SpringState>({ x: target, v: 0 })

  useEffect(() => {
    const canAnimate = typeof requestAnimationFrame === 'function' && !prefersReducedMotion()
    if (!canAnimate) {
      const timer = setTimeout(() => {
        springRef.current = { x: target, v: 0 }
        setShown(target)
      }, 0)
      return () => clearTimeout(timer)
    }

    let frame = 0
    let last: number | null = null
    const step = (time: number) => {
      const dt = last === null ? 0 : (time - last) / 1000
      last = time
      const next = stepSpring(springRef.current, target, SPRING, dt)
      if (isSettled(next, target, 0.5)) {
        springRef.current = { x: target, v: 0 }
        setShown(target)
        return
      }
      springRef.current = next
      setShown(Math.round(next.x))
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [target])

  return (
    <div className={cn('flex flex-col', className)} data-testid="treasury-counter" data-cents={target}>
      <span className="text-[0.6em] font-medium uppercase tracking-wide opacity-80">{label}</span>
      <span aria-hidden="true" className={cn('font-mono font-bold tabular-nums', amountClassName)}>
        {formatCents(safeCents(shown))}
      </span>
      <span className="sr-only" aria-live="polite">
        {formatCents(target)}
      </span>
    </div>
  )
}
