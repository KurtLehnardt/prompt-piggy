import { requireUserPage } from '@/lib/auth/require-user'
import { loadSnapshot, loadWallet, readMaxPromptChars } from './load-play'
import { PlayScreen } from './play-screen'

/**
 * /play: the shared-pig game screen (docs/ARCHITECTURE.md sections 7, 9, and
 * 10). The (game) layout already checked the user; this page asks again for
 * the RLS-bound client and the user id it reads the wallet row with.
 */
export const dynamic = 'force-dynamic'

export default async function PlayPage() {
  const { user, supabase } = await requireUserPage()
  const [wallet, snapshot] = await Promise.all([loadWallet(supabase, user.id), loadSnapshot()])
  return <PlayScreen initialWallet={wallet} initialSnapshot={snapshot} maxPromptChars={readMaxPromptChars()} />
}
