import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'
import { getCurrentUser } from '@/lib/auth/require-user'
import { cn } from '@/lib/utils'

/**
 * The public start page (docs/ARCHITECTURE.md section 4; REVIEW-2 R2-07). A
 * signed-out visitor gets the Google sign-in call to action, which leads to
 * /login so the sign-in notice is always seen first; a signed-in player gets
 * a Play link. It never links to /live, which needs the projector link.
 *
 * It renders per request because the call to action depends on the session.
 */
export const dynamic = 'force-dynamic'

const RULES = [
  'Every player starts with a $20 play-money wallet.',
  'Each attack costs $1 and goes into the shared treasury.',
  'A failed attack cracks your glass; three cracks shatter it, and a repair costs $1.',
  'Talk the pig into paying out and the whole treasury is yours. Then the pig learns from it.',
]

export default async function HomePage() {
  const user = await getCurrentUser()

  return (
    <main className="flex min-h-dvh items-center justify-center bg-linear-to-b from-piggy/10 to-background p-6">
      <div className="w-full max-w-xl space-y-8 text-center">
        <div className="space-y-3">
          <p aria-hidden className="text-6xl">
            🐷
          </p>
          <h1 className="text-4xl font-semibold tracking-tight">Prompt Piggy</h1>
          <p className="text-muted-foreground">
            A prompt-security game. Trick the vault pig into approving a transfer, and it hardens
            itself against your trick for everyone else.
          </p>
        </div>

        <ul className="mx-auto max-w-md space-y-2 text-left text-sm">
          {RULES.map((rule) => (
            <li key={rule} className="flex gap-2">
              <span aria-hidden className="text-coin">
                ●
              </span>
              <span>{rule}</span>
            </li>
          ))}
        </ul>

        <div className="flex justify-center">
          {user ? (
            <Link href="/play" className={cn(buttonVariants({ size: 'lg' }), 'px-6')} data-testid="landing-play">
              Play
            </Link>
          ) : (
            <Link href="/login" className={cn(buttonVariants({ size: 'lg' }), 'px-6')} data-testid="landing-sign-in">
              Sign in with Google
            </Link>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          All money in Prompt Piggy is mocked. Nothing real is charged or paid out.
        </p>
      </div>
    </main>
  )
}
