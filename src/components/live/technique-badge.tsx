import { techniqueLabel } from '@/components/live/labels'
import { cn } from '@/lib/utils'
import type { AttackTechnique } from '@/types/api'

/** The attack-technique label as a badge (display only, CH-6b). */
export function TechniqueBadge({ technique, className }: { technique: AttackTechnique | null; className?: string }) {
  return (
    <span
      className={cn('inline-flex items-center rounded-full border border-white/25 px-4 py-1 whitespace-nowrap', className)}
      data-technique={technique ?? 'unknown'}
    >
      {techniqueLabel(technique)}
    </span>
  )
}
