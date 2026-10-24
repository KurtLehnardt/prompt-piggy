import type { Metadata } from 'next'
import Link from 'next/link'
import { GoogleSignInButton } from '@/components/auth/google-sign-in-button'
import { SignInNotice } from '@/components/auth/sign-in-notice'
import { safeRedirectPath } from '@/lib/auth/safe-redirect'

/**
 * The sign-in page (docs/ARCHITECTURE.md sections 4 and 9.7). Google is the
 * only sign-in method. The notice comes before the button, so every player
 * sees it before they agree to anything (R2-07).
 *
 * The proxy sends a signed-in visitor on to /play (or `next`), and a
 * signed-out visitor to a protected page here with `?next=<that page>`. That
 * value is validated again before it goes into the OAuth callback URL, and
 * the callback validates it a third time.
 */
export const metadata: Metadata = {
  title: 'Sign in | Prompt Piggy',
}

type LoginPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { next } = await searchParams
  const nextPath = safeRedirectPath(typeof next === 'string' ? next : undefined)

  return (
    <main className="flex min-h-dvh items-center justify-center bg-linear-to-b from-piggy/10 to-background p-6">
      <div className="w-full max-w-sm space-y-6 rounded-2xl border border-border bg-card p-6 text-center shadow-sm">
        <div className="space-y-2">
          <p aria-hidden className="text-5xl">
            🐷
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Sign in to Prompt Piggy</h1>
          <p className="text-sm text-muted-foreground">
            Talk the vault pig into paying out. All money in this game is play money.
          </p>
        </div>
        <SignInNotice />
        <GoogleSignInButton next={nextPath} />
        <p className="text-xs text-muted-foreground">
          <Link href="/" className="underline underline-offset-4">
            Back to the start page
          </Link>
        </p>
      </div>
    </main>
  )
}
