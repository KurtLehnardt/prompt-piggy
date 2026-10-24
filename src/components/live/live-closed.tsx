/**
 * What /live shows without a valid projector cookie (docs/ARCHITECTURE.md
 * section 12.2; threat T32). Static text only: no client code, no fetch, no
 * channel, no player data.
 */
export const LIVE_CLOSED_TEXT = 'This screen needs the projector link.'

export function LiveClosed() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8 text-center">
      <p className="text-[28px]">{LIVE_CLOSED_TEXT}</p>
    </main>
  )
}
