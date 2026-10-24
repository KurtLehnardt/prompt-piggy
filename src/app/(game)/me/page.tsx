import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { outcomeLabel, techniqueLabel } from '@/components/live/labels'
import { requireUserPage } from '@/lib/auth/require-user'
import { formatCents } from '@/lib/money/format'
import { loadHistory, type HistoryRow } from './load-history'

/**
 * /me: the player's own history (docs/ARCHITECTURE.md sections 5.3 and 9).
 * Attempts and the donation total are read through the RLS-bound server
 * client, so a player only ever sees their own rows, and the attempts query
 * selects only the columns granted to `authenticated`. The player's own
 * prompts and the pig's replies are rendered as plain text.
 */
export const dynamic = 'force-dynamic'

function centsOrDash(cents: number): string {
  return cents > 0 ? formatCents(cents) : '—'
}

function when(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

function moneyNote(row: HistoryRow): string {
  if (row.payoutCents > 0) return `Won ${formatCents(row.payoutCents)}`
  if (row.refundWithheld) return 'Refund limit reached'
  if (row.refundCents > 0) return `Refunded ${formatCents(row.refundCents)}`
  return ''
}

export default async function MePage() {
  const { user, supabase } = await requireUserPage()
  const history = await loadHistory(supabase, user.id)

  return (
    <div className="flex flex-col gap-6" data-testid="me-page">
      <h1 className="text-2xl font-bold tracking-tight">Your history</h1>

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border bg-card p-4">
          <dt className="text-xs text-muted-foreground">Wallet</dt>
          <dd className="text-lg font-semibold" data-testid="me-balance">
            {history.wallet ? formatCents(history.wallet.balanceCents) : '—'}
          </dd>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <dt className="text-xs text-muted-foreground">Donated to CNCF (mock)</dt>
          <dd className="text-lg font-semibold" data-testid="me-donated">
            {history.wallet ? formatCents(history.wallet.totalDonatedCents) : '—'}
          </dd>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <dt className="text-xs text-muted-foreground">Attacks shown</dt>
          <dd className="text-lg font-semibold">{history.attempts.length}</dd>
        </div>
      </dl>

      {history.error ? (
        <p role="status" className="text-sm text-muted-foreground">
          Your history could not be loaded right now. Reload to try again.
        </p>
      ) : history.attempts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No attacks yet. Head to Play and take a swing.</p>
      ) : (
        <Table data-testid="me-attempts">
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Level</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead>Technique</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>Money</TableHead>
              <TableHead className="min-w-64">Your attack and the reply</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.attempts.map((row) => (
              <TableRow key={row.id} data-outcome={row.outcome}>
                <TableCell className="whitespace-nowrap text-xs">{when(row.createdAt)}</TableCell>
                <TableCell>{row.level}</TableCell>
                <TableCell>{row.outcome === 'pending' ? 'Running' : outcomeLabel(row.outcome)}</TableCell>
                <TableCell>{row.technique ? techniqueLabel(row.technique) : '—'}</TableCell>
                <TableCell>{centsOrDash(row.priceCents)}</TableCell>
                <TableCell>{moneyNote(row)}</TableCell>
                <TableCell className="max-w-md whitespace-pre-wrap break-words align-top text-xs">
                  {row.prompt !== null ? <p>{row.prompt}</p> : <p className="italic text-muted-foreground">Prompt deleted after 30 days</p>}
                  {row.reply ? <p className="mt-1 text-muted-foreground">🐷 {row.reply}</p> : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
