'use client'

import { useEffect, useRef } from 'react'

/** True when there is no document (server rendering) or the tab is visible. */
export function isDocumentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

/**
 * Calls `tick` at once and then every `intervalMs` while the tab is visible
 * (CH-5, R2-S1). It stops while the tab is hidden and ticks at once when the
 * tab becomes visible again. The latest `tick` is kept in a ref, skylite's
 * callback-ref pattern, so a new callback never restarts the timer.
 */
export function useVisibleInterval(tick: () => void, intervalMs: number, enabled: boolean = true): void {
  const tickRef = useRef(tick)
  useEffect(() => {
    tickRef.current = tick
  }, [tick])

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return
    let timer: ReturnType<typeof setInterval> | null = null

    const start = () => {
      if (timer !== null) return
      tickRef.current()
      timer = setInterval(() => tickRef.current(), intervalMs)
    }
    const stop = () => {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    }
    const onVisibilityChange = () => (isDocumentVisible() ? start() : stop())

    onVisibilityChange()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [intervalMs, enabled])
}
