/** SVG path data for crack stages 1..3 in a 100x100 viewBox. Stage n draws paths 0..n-1. */
export const CRACK_STAGE_PATHS: readonly string[] = Object.freeze([
  'M62 0 L55 18 L63 30 L52 46',
  'M20 0 L28 22 L18 38 L30 55 M52 46 L40 62 L48 78',
  'M100 35 L80 44 L86 60 L68 70 M30 55 L10 70 L22 90 M48 78 L60 100',
])

export function crackPathsFor(stage: 0 | 1 | 2 | 3): readonly string[] {
  return CRACK_STAGE_PATHS.slice(0, Math.min(3, stage))
}
