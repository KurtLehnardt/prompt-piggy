import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'

/** The app-wide 404 page. */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-4 p-6 text-center">
      <p aria-hidden className="text-5xl">
        🐽
      </p>
      <h1 className="text-2xl font-semibold tracking-tight" data-testid="not-found-title">
        Page not found
      </h1>
      <p className="text-sm text-muted-foreground">The pig sniffed around, but there is nothing here.</p>
      <Link href="/" className={buttonVariants({ variant: 'outline' })}>
        Back to the start page
      </Link>
    </main>
  )
}
