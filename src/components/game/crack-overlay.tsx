import type { ReactNode } from 'react'
import type { CrackCount } from '@/types/api'
import { crackPathsFor } from './crack-paths'
import styles from './crack-overlay.module.css'

export type CrackOverlayProps = {
  /** Server crack count. */
  cracks: CrackCount
  /** Rendered in the corner (the repair button). */
  children?: ReactNode
}

export function CrackOverlay({ cracks, children }: CrackOverlayProps) {
  return (
    <div className={styles.overlay} data-testid="crack-overlay" data-cracks={cracks}>
      <svg className={styles.svg} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {cracks === 3 && <rect className={styles.shatter} data-testid="shatter" x="0" y="0" width="100" height="100" />}
        {crackPathsFor(cracks).map((d) => (
          <path key={d} className={styles.crack} d={d} />
        ))}
      </svg>
      {children ? <div className={styles.corner}>{children}</div> : null}
    </div>
  )
}
