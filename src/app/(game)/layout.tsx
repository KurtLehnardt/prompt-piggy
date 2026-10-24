import { TopBar } from '@/components/nav/top-bar'
import { AuthProvider } from '@/components/providers/auth-provider'
import { loadAuthUser } from '@/lib/auth/auth-user'
import { requireUserPage } from '@/lib/auth/require-user'

/**
 * The signed-in game shell (docs/ARCHITECTURE.md section 4; REVIEW-1 R1-13;
 * REVIEW-2 R2-16). It checks the user on the server with requireUserPage(),
 * which asks the Auth server and redirects a signed-out or anonymous visitor
 * to /login. The proxy's redirect is only a convenience; this is the check.
 *
 * Only `{ userId, displayName, avatarUrl }` crosses into client components.
 * No token, email, or metadata is passed as a prop.
 */
export const dynamic = 'force-dynamic'

export default async function GameLayout({ children }: { children: React.ReactNode }) {
  const { user, supabase } = await requireUserPage()
  const authUser = await loadAuthUser(supabase, user)

  return (
    <AuthProvider user={authUser}>
      <TopBar />
      <div className="mx-auto w-full max-w-5xl px-4 py-6">{children}</div>
    </AuthProvider>
  )
}
