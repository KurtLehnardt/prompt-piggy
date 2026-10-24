import { Eye, Archive } from 'lucide-react'

/**
 * What a player agrees to by signing in (docs/ARCHITECTURE.md section 9.7 and
 * assumption A5; CH-3, CH-7, REVIEW-2 R2-07). It is shown on the login page
 * before the sign-in button. Every signed-in player appears on the presence
 * wall, so v1 has no opt-out; an admin can hide a player from the wall.
 */
export const PROJECTOR_NOTICE =
  'Your Google photo and name are shown to other players and on the event projector.'

export const RETENTION_NOTICE =
  'The prompts you send are kept for 30 days. A prompt that wins a payout is kept indefinitely as security regression data, so the pig keeps blocking it.'

export function SignInNotice() {
  return (
    <section aria-label="Before you sign in" data-testid="sign-in-notice" className="space-y-3 text-left text-sm">
      <p className="flex gap-3 rounded-lg border border-border bg-muted/50 p-3">
        <Eye aria-hidden className="mt-0.5 size-4 shrink-0 text-piggy" />
        <span data-testid="sign-in-notice-projector">{PROJECTOR_NOTICE}</span>
      </p>
      <p className="flex gap-3 rounded-lg border border-border bg-muted/50 p-3">
        <Archive aria-hidden className="mt-0.5 size-4 shrink-0 text-coin" />
        <span data-testid="sign-in-notice-retention">{RETENTION_NOTICE}</span>
      </p>
    </section>
  )
}
