# Notice

Prompt Piggy is licensed under the GNU General Public License, version 3 only
(`GPL-3.0-only`; see `LICENSE`). This file records every file, pattern, and
word list in this repository that was copied or adapted from somewhere else,
with its source and license.

## 1. Code and patterns from skylite

skylite is the repository owner's own Next.js and Supabase project
(`KurtLehnardt/skylite`, a private repository). Its author and copyright
holder approved relicensing the copied and adapted skylite code under
`GPL-3.0-only` for Prompt Piggy on 2026-10-24. skylite itself has no license
file and is not changed by this project.

The rows below are rows 1 to 23 of `docs/ARCHITECTURE.md` section 1.2. Source
paths are relative to the skylite repository root, and target paths are
relative to this repository's root. "Adapted file" means the target file
started from the source file and was then changed as section 1.2 describes.
"Pattern" means only a convention or structure was reused, and the target was
written fresh. Some targets are created by later tasks; they are listed now so
that this notice is complete when they land.

| # | Concern | skylite source | Prompt Piggy target | Kind |
|---|---|---|---|---|
| 1 | Browser client | `apps/web/src/lib/supabase/client.ts` | `src/lib/supabase/client.ts` | Adapted file |
| 2 | Server client | `apps/web/src/lib/supabase/server.ts` | `src/lib/supabase/server.ts` | Adapted file |
| 3 | Session refresh | `apps/web/src/lib/supabase/middleware.ts`, `apps/web/src/middleware.ts` | `src/lib/supabase/proxy.ts`, `src/proxy.ts` | Adapted files |
| 4 | Service-role client | `apps/web/src/lib/supabase/admin.ts` | `src/lib/supabase/admin.ts` | Adapted file |
| 5 | E2E flag | `apps/web/src/lib/e2e-helpers.ts` | `src/lib/e2e-helpers.ts` | Adapted file |
| 6 | OAuth callback | `apps/web/src/app/auth/callback/route.ts` | `src/app/auth/callback/route.ts` | Adapted file |
| 7 | Migrations | `supabase/migrations/NNNNN_description.sql`, `supabase/migrations/README.md` | `supabase/migrations/` | Pattern (naming, README chain table, re-runnable statements) |
| 8 | RLS helper style | `supabase/migrations/00002_rls_policies.sql` (lines 12 to 27) | `get_level_status()`, `get_public_config()`, and the policies in `supabase/migrations/` | Pattern |
| 9 | Atomic RPC | `supabase/migrations/00036_policy_role_scoping.sql` (lines 302 to 428, `deduct_stars`), header of `supabase/migrations/00038_star_economy_integrity.sql` | `start_attempt`, `record_attempt`, `repair_glass`, `donate`, `admin_grant_funds` in `supabase/migrations/` | Pattern |
| 10 | Claim and idempotency | `supabase/migrations/00033_monetization.sql` (lines 332 to 426, `claim_stripe_webhook_event`) | `claim_hardening_job` and `attempts.idempotency_key` in `supabase/migrations/` | Pattern |
| 11 | Privilege baseline | `supabase/migrations/00035_revoke_truncate.sql` | `supabase/migrations/00001_foundation.sql` | Pattern |
| 12 | Realtime hook | `apps/web/src/lib/hooks/use-realtime.ts` | `src/lib/hooks/use-realtime.ts` | Adapted file |
| 13 | API route style | `apps/web/src/app/api/devices/pair/route.ts`, `apps/web/src/app/api/cron/calendar-sync/route.ts` | `src/app/api/**/route.ts` | Pattern |
| 14 | Cron auth | `apps/web/src/app/api/cron/calendar-sync/route.ts` (lines 12 to 29) | `src/lib/auth/cron-auth.ts` | Adapted code |
| 15 | Layout and toasts | `apps/web/src/app/layout.tsx`, `apps/web/src/components/ui/sonner.tsx` | `src/app/layout.tsx`, `src/components/ui/sonner.tsx` | Adapted files |
| 16 | Providers | `apps/web/src/components/providers/*.tsx` | `src/components/providers/` | Pattern |
| 17 | shadcn/ui configuration | `apps/web/components.json` | `components.json` | Adapted file |
| 18 | Tailwind v4 | `apps/web/src/app/globals.css` (lines 1 to 50), `apps/web/postcss.config.mjs` | `src/app/globals.css`, `postcss.config.mjs` | Adapted files |
| 19 | Tooling | `apps/web/vitest.config.ts`, `apps/web/playwright.config.ts`, `apps/web/eslint.config.mjs`, `.nvmrc`, `.github/actions/setup/action.yml`, `.github/workflows/ci.yml` | `vitest.config.ts`, `playwright.config.ts`, `eslint.config.mjs`, `.nvmrc`, `.github/actions/setup/action.yml`, `.github/workflows/ci.yml` | Adapted files |
| 20 | Guard scripts | `.github/scripts/check-e2e-test-mode.mjs`, `.github/scripts/check-admin-client-guards.mjs` | `scripts/check-e2e-test-mode.mjs` (copied and adapted to this layout), `scripts/check-admin-client-imports.mjs` (rewritten as a strict allowlist) | Adapted file, pattern |
| 21 | Env naming | `.env.example` | `.env.example` | Pattern (variable names only, no values) |
| 22 | Remote avatars | `apps/web/next.config.ts` (lines 34 to 39, `images.remotePatterns`) | `next.config.ts` | Adapted configuration entry |
| 23 | Heartbeat hook | `apps/web/src/lib/hooks/use-device-heartbeat.ts` | `src/lib/presence/use-presence-ping.ts` | Pattern |

## 2. Word and phrase lists

### 2.1 `src/lib/rules/stoplist.words.json`

The stop-word list behind the keyword content-token rule (`docs/ARCHITECTURE.md`
section 6.3). It has 5,253 entries from two sources.

1. **12dicts `2of5core` (4,658 entries).**
   - Work: 12dicts, release 6.0.2 (June 2016), compiled by Alan Beale. File
     `Special/2of5core.txt`, a core English vocabulary of about 4,700 words.
   - Source: <http://wordlist.aspell.net/12dicts/> (readme:
     <http://wordlist.aspell.net/12dicts-readme/>). Download used:
     <https://downloads.sourceforge.net/project/wordlist/12Dicts/6.0/12dicts-6.0.2.zip>,
     SHA-256 `64ac1d35acb66b550c7ebc56e080b62e0bad8f5984d72059dc2e05ac48780e52`.
   - License: public domain. The 12dicts readme states: "The 12dicts lists
     were compiled by Alan Beale. I explicitly release them to the public
     domain, but request acknowledgment of their use." The readme names one
     exception, the `2of12inf` and `2+2+3` lists, which depend on AGID. Those
     lists are not used here. This section is the requested acknowledgment.
   - Changes: every entry was lowercased; variant spellings were split at `/`
     (`center/centre`); multi-word, hyphenated, and abbreviated entries were
     split into tokens at spaces, hyphens, apostrophes, periods, and colons;
     only tokens that match `^[a-z0-9]+$` were kept; and the result was
     deduplicated and sorted.
2. **Hand-curated additions (595 entries not already in `2of5core`), written
   for this repository** and licensed under `GPL-3.0-only` with the rest of it. They are game and
   banking vocabulary (for example penny, piggy, vault, teller, approve,
   transfer, nana, truffle, approvetransfer), common chat words (okay, thx,
   gonna), modern everyday words (app, chatbot, smartphone), irregular verb
   forms, and common inflected forms that `2of5core` leaves out.

### 2.2 `src/lib/rules/stoplist.phrases.json`

The stop-phrase list (`docs/ARCHITECTURE.md` section 6.3): 413 common
conversational, banking, and game phrases such as "thank you so much", "can
you please", "the vault", "help me out", and "my bank account". It was written
for this repository, has no third-party source, and is licensed under
`GPL-3.0-only`.

## 3. Other copied files

The components in `src/components/ui/` were generated with the shadcn CLI
from the shadcn/ui registry (`base-nova` style, see `components.json`). The
shadcn/ui code is licensed under the MIT License, Copyright (c) 2023 shadcn
(<https://github.com/shadcn-ui/ui/blob/main/LICENSE.md>), which permits
redistribution under `GPL-3.0-only`.

Dependencies installed through pnpm are not copied into this repository; each
package carries its own license in `node_modules`.
