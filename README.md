# Prompt Piggy

Prompt Piggy is a self-hardening prompt-security game. Players sign in with Google and try to talk an AI piggy bank into paying out its treasury. Every successful break hardens the pig for the next player.

## Status

- The architecture blueprint is under review. `docs/ARCHITECTURE.md` and `docs/orchestrator-tasks.json` will land through a pull request once the revision is finished.
- The Next.js app skeleton (task PP-01) is next. Vercel deployments will fail until PP-01 is merged.
- All money in v1 is mocked: attempt fees, glass repairs, payouts, and CNCF donations. No real payment, payout, or donation happens anywhere.

## Stack

- Next.js 16 (App Router) on Vercel
- Supabase (Postgres, Auth with Google OAuth, Realtime)
- OpenAI Decisions API and `@openai/agents`

## Docs

- [`docs/BRIEF.md`](docs/BRIEF.md): the original mission brief.
- [`docs/HARDENING_CONSTRAINTS.md`](docs/HARDENING_CONSTRAINTS.md): mandatory design rules for the Attack-to-Rule hardening loop.
- [`docs/SETUP.md`](docs/SETUP.md): Supabase and Vercel setup notes.

## License

Licensed under the GNU General Public License v3.0. See [LICENSE](LICENSE).
