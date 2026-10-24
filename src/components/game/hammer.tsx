/** Hammer drawn in SVG; rotates around its handle end via the angle prop (degrees). */
export function Hammer({ angleDeg }: { angleDeg: number }) {
  return (
    <svg viewBox="0 0 100 100" width="96" height="96" aria-hidden="true" data-testid="hammer" style={{ transform: `rotate(${angleDeg}deg)`, transformOrigin: '85% 90%' }}>
      <rect x="78" y="40" width="8" height="55" rx="3" fill="#92400e" />
      <rect x="55" y="22" width="48" height="24" rx="4" fill="#64748b" stroke="#334155" strokeWidth="2" />
    </svg>
  )
}
