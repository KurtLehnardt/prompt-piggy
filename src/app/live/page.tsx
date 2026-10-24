import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { LiveClosed } from '@/components/live/live-closed'
import { LiveProjector } from '@/components/live/live-projector'
import { hasProjectorAccess, PROJECTOR_COOKIE } from '@/lib/live/projector-cookie'
import { buildLiveSnapshot } from '@/lib/live/snapshot'
import type { LiveSnapshotDTO } from '@/types/api'

/**
 * /live, the projector view (docs/ARCHITECTURE.md section 12.2; threat T32;
 * REVIEW-2 R2-07).
 *
 * Without a valid `pp_live` cookie it renders only "This screen needs the
 * projector link.": static text that fetches nothing and opens no channel.
 * With one, it builds the first snapshot through the anon client and hands
 * it to the client view, which subscribes to game_state and live_feed and
 * polls the gated player list. Never cached, never indexed, and no referrer.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Prompt Piggy Live',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
}

export default async function LivePage() {
  const store = await cookies()
  if (!hasProjectorAccess(store.get(PROJECTOR_COOKIE)?.value)) return <LiveClosed />

  let initial: LiveSnapshotDTO | null = null
  try {
    initial = await buildLiveSnapshot()
  } catch {
    // The client view polls the snapshot until it has data.
    initial = null
  }
  return <LiveProjector initial={initial} />
}
