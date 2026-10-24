# Prompt Piggy

Prompt Piggy is a self-hardening prompt-security game. Players sign in with Google and try to talk an AI piggy bank into paying out its treasury. Every successful break hardens the pig for the next player.

> [!WARNING]
> **This repository is public.** Never commit a secret (API keys, the Supabase service-role key, the database password, `CRON_SECRET`) or a real breach prompt. Only `.env.example`, which holds variable names with empty values, may be committed; every other `.env*` file is gitignored. Real breach prompts live only in the database, and committed test fixtures are synthetic. CI runs a gitleaks scan over the full git history on every pull request and fails on any finding.

## Status

- Task PP-01 provides a Vercel-deployable skeleton: Next.js 16, Tailwind CSS v4, shadcn/ui primitives, the Supabase clients and session-refresh proxy, a public `/health` page, and CI. There is no game logic yet.
- The architecture blueprint (`docs/ARCHITECTURE.md` and `docs/orchestrator-tasks.json`) lands through its own pull request.
- All money in v1 is mocked: attempt fees, glass repairs, payouts, and CNCF donations. No real payment, payout, or donation happens anywhere.

## Stack

- Next.js 16 (App Router) on Vercel
- Supabase (Postgres, Auth with Google OAuth, Realtime)
- OpenAI Decisions API and `@openai/agents`
- Tailwind CSS v4 and shadcn/ui (`base-nova`, Base UI)

## Local development

Requirements: Node 22 (see `.nvmrc`) and pnpm 10.

```sh
pnpm install --frozen-lockfile
cp .env.example .env.local   # then fill in values locally; never commit them
pnpm dev                     # http://localhost:3000, deploy check at /health
```

| Command | What it does |
|---|---|
| `pnpm dev` | Start the Next.js dev server. |
| `pnpm test` | Run the Vitest `server` and `ui` projects. |
| `pnpm build` | Production build. It needs no environment variables. |
| `pnpm lint` | ESLint. |
| `pnpm typecheck` | `tsc --noEmit`. |
| `pnpm test:e2e` | Playwright end-to-end tests against `pnpm dev`. |

The `/health` page reports `ok`, the commit, the environment, and whether the public Supabase settings are present (`yes` or `no`, never the value). It makes no database or network call.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): the architecture blueprint (directory tree, data model, API routes, threat model, environment variable names).
- [`docs/BRIEF.md`](docs/BRIEF.md): the original mission brief.
- [`docs/HARDENING_CONSTRAINTS.md`](docs/HARDENING_CONSTRAINTS.md): mandatory design rules for the Attack-to-Rule hardening loop.
- [`docs/SETUP.md`](docs/SETUP.md): Supabase and Vercel setup notes.

## License

Licensed under the GNU General Public License v3.0. See [LICENSE](LICENSE).
