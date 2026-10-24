import type { Metadata } from 'next'
import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'

/**
 * Where /auth/callback sends a sign-in that did not finish. It is public (the
 * visitor has no session) and shows fixed copy only: no Supabase or Google
 * error text from the URL is ever rendered.
 */
export const metadata: Metadata = {
  title: 'Sign-in failed | Prompt Piggy',
  robots: { index: false, follow: false },
}

export default function AuthErrorPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-4 p-6 text-center">
      <p aria-hidden className="text-5xl">
        🔒
      </p>
      <h1 className="text-2xl font-semibold tracking-tight" data-testid="auth-error-title">
        Sign-in did not finish
      </h1>
      <p className="text-sm text-muted-foreground">
        The sign-in link expired or was already used, or Google sign-in was cancelled. Please try
        again.
      </p>
      <Link href="/login" className={buttonVariants()}>
        Try again
      </Link>
    </main>
  )
}
