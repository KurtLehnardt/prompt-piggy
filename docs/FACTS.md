# Prompt Piggy — Verified Facts and Decisions (2026-10-24)

Where this file conflicts with BRIEF.md, this file wins. HARDENING_CONSTRAINTS.md is mandatory and wins over both.

## A. User decisions

- v1 is a proof of concept for a **live conference demo**.
- **Play money only.** Use a mock payment adapter, and keep the adapter interface ready for future rails. Stripe's Prohibited and Restricted Businesses list prohibits paid-entry cash-prize games under "Gambling" (https://stripe.com/legal/restricted-businesses). No real-money adapter may be built in v1. Lightning/BTC is deferred pending legal review.
- **Sign-in: Google OAuth only**, through Supabase Auth's Google provider.
- **Pattern source: `~/work/skylite`.** PresidentNelsonsScriptureChallenge contributes almost nothing; see section C.
- **Win rule (orchestrator recommendation, accepted by default):** the Core LLM gets exactly one tool, `approveTransfer`. A win means the model emits a call to that tool. The tool is a stub with no side effects except recording a win flag. The server verifies the win and moves the ledger balance. Use the Decisions API for (a) a `predicate` pre-screen tripwire in the Validator and (b) `choice` attack-technique classification for the live display. Neither one decides the payout.
- **Single-turn attempts.** Each attempt runs with fresh context: system prompt + active rule-set version + one attacker message. There is no cross-attempt conversation memory. This satisfies HARDENING_CONSTRAINTS #3, so Agents SDK sessions and compaction are not needed in v1.
- **Crack state is server-authoritative.** It runs from 0 to 3 per game session. The 3rd failure triggers the penalty popup and resets the glass. Only deterministic game logic changes it, never user text.
- **Penalty math is configuration.** Use `PENALTY_BASE_PCT=1` and `LOCK_CAP=100000`. The brief's semantics are ambiguous ("1% baseline penalty on 3 failures, scaling dynamically up to high-value lock amounts"). The architect proposes concrete semantics and marks them as an ASSUMPTION for the user to confirm. Suggested default: play-coin entry fees grow the treasury, the 3rd-failure penalty debits the player's play balance into the treasury, the penalty % scales with treasury size, and the vault "locks" (jackpot cap / max difficulty) at `LOCK_CAP`.
- **Difficulty levels**, so wins happen early on stage. The pig hardens after each win through the gated Hardening Engine.
- **Demo additions (defaults; the user may strike them):**
  - A `/live` projector view showing the attempt feed, treasury, and attack-technique labels. Do NOT show raw attacker prompts on the projector; show labels or moderated excerpts only, because offensive prompts must not reach a conference screen.
  - A per-user rate limit.
  - A global OpenAI spend cap and kill switch.
  - Google OAuth consent screen set to "In production" before the event, because "Testing" mode caps sign-in at 100 manually added test users.

## B. Verified API facts (official docs, checked 2026-10-24)

- **OpenAI Decisions API:** `POST /v1/decisions`, model `gpt-6-luna`, generally available after a public beta that began 2026-10-06. Question types:
  - `predicate` returns P(true) in [0,1]; threshold it yourself.
  - `choice` returns one of a fixed option set, with per-option probabilities.
  - `score` uses 2-10 ordered levels.
  - Inputs: text, images, JSON, or conversation history including tool calls. Prompt caching is supported. OpenAI says it is "10x faster than Responses API". Price is $0.10 per 1M uncached input tokens, with no output-token charge.
  - Docs: https://developers.openai.com/api/docs/guides/decisions
  - Fallback: the Responses API with strict `json_schema` Structured Outputs.
- **`@openai/agents` 0.21.0** (2026-10-20), requires Node 22+.
  - Vercel Edge is NOT supported, so AI routes must use `export const runtime = 'nodejs'`. Vercel Node serverless is not officially stated; it should work, so verify with a deploy.
  - Input guardrails run only on the first agent. `runInParallel` defaults to `true`, so the model runs before the block takes effect. **Set `runInParallel: false`.** A tripwire throws `InputGuardrailTripwireTriggered`.
  - Output guardrails run only on the last agent and throw `OutputGuardrailTripwireTriggered`; define them with `defineOutputGuardrail()`.
  - Tool guardrails: `defineToolInputGuardrail()` / `defineToolOutputGuardrail()`.
  - Sessions: `MemorySession`, `OpenAIConversationsSession`, `OpenAIResponsesCompactionSession`. v1 does not use them.
  - Sandbox: `UnixLocalSandboxClient` (no isolation), `DockerSandboxClient`, and hosted providers. None is needed, because the Core LLM gets only the stub tool and no code execution.
  - MCP: `MCPServerStdio` / `MCPServerSSE` / `MCPServerStreamableHttp`. v1 uses no MCP servers, so "MCP takeover" is handled as attack-text classification only.
  - Docs: https://openai.github.io/openai-agents-js/guides/guardrails/
- **Compaction exists** (`context_management.compact_threshold` on `/responses`, `/responses/compact`) but v1 does not use it.
- **OpenAI injection guidance:**
  - Never put untrusted input in developer/system messages; pass it as user content.
  - Use structured outputs (enums, fixed schemas) between nodes.
  - Keep the evaluator separate from the agent that holds secrets.
  - Docs: https://developers.openai.com/api/docs/guides/agent-builder-safety

## C. Reference repo: PresidentNelsonsScriptureChallenge

- Vanilla JS, with no package.json or build step.
- Firebase 10.7.1 via CDN (index.html:192-194), with Firebase config hardcoded in app.js:1-9.
- Auth is client-side only: Google + GitHub through Firebase (app.js:232-246), `auth.onAuthStateChanged` (app.js:77), and no server-side protection.
- Firestore has one `users` collection `{ email, displayName, readScriptures[], settings, lastUpdated }` (app.js:321-332), no rules file, and a localStorage fallback (app.js:338).
- Notifications use SweetAlert2 via CDN (index.html:11) and Font Awesome 6.5.0. Styling is a hand-written styles.css.
- It has NO Supabase, Next.js, React, Tailwind, Vercel config, CI, or tests.
- **Reusable:** the Google sign-in choice, the modal-popup UX style (now via shadcn Dialog + sonner), and visual tone.

## D. Pattern source: ~/work/skylite (web app at apps/web; read-only)

- **Versions:** Next.js 16.3.5, React 19.2.3, TypeScript 5, `@supabase/ssr` 0.9.0, `@supabase/supabase-js` 2.99.2, Tailwind v4 (`@tailwindcss/postcss`, CSS `@theme inline` in app/globals.css:7-50, no tailwind.config), Node 22 (.nvmrc), pnpm.
- **Monorepo:** skylite is a monorepo (apps/web) because of an Expo companion. Prompt Piggy has no mobile app, so the default is a single-app repo unless justified.
- **Supabase client factories:**
  - `apps/web/src/lib/supabase/client.ts` (createBrowserClient)
  - `server.ts` (createServerClient + next/headers cookies)
  - `middleware.ts` (createServerClient + NextRequest cookies, getAll/setAll)
  - `admin.ts` (service role, server-only, guarded)
- **Auth:**
  - `src/middleware.ts` delegates to `updateSession()`. The matcher excludes assets and public paths (`/login`, `/signup`, `/auth/callback`).
  - The callback route `app/auth/callback/route.ts` runs exchangeCodeForSession and redirects to `/dashboard`.
  - The user is fetched with `supabase.auth.getUser()`.
  - Skylite has NO OAuth sign-in (email/password only), so Google OAuth is designed fresh on the Supabase Google provider.
  - Note: Next.js 16 renamed `middleware.ts` to `proxy.ts`. Skylite still uses `middleware.ts`; choose and state which, and verify against Next 16 docs.
- **DB:**
  - `supabase/` holds migrations, functions, seed.sql, and config.toml. Migrations are named `NNNNN_description.sql` (e.g. `00001_core_schema.sql`).
  - RLS uses SECURITY DEFINER helper functions (`get_user_household_ids()`, `is_household_admin()`; see 00002_rls_policies.sql:29-43).
  - Generated types live in `apps/web/src/types/database.ts` (Supabase CLI).
  - The atomic RPC pattern exists (`deduct_stars`, `claim_stripe_webhook_event` for webhook idempotency); copy it for ledger writes.
  - Realtime: the hook `lib/hooks/use-realtime.ts` subscribes to postgres_changes.
- **API:**
  - Routes are `app/api/**/route.ts` with `export const runtime = 'nodejs'`.
  - Errors use `NextResponse.json({ error: string }, { status })`.
  - Validation is manual typeof checks with no zod (app/api/devices/pair/route.ts:9-14). Prompt Piggy needs schema validation for the rule schema, so decide and justify (zod is recommended).
  - Secrets are compared with `crypto.timingSafeEqual`, and cron routes use a CRON_SECRET bearer check.
  - There is no rate-limit library.
- **UI:**
  - shadcn/ui (components.json: base-nova style, rsc true, aliases @/components, @/lib/utils, @/components/ui).
  - Components live in `components/ui/`.
  - sonner v2.0.7, with `<Toaster>` in app/layout.tsx:72.
  - Context providers live in `components/providers/` (ThemeProvider etc.), with no state library.
- **Tooling:**
  - Vitest 4.1.0 (`src/**/*.test.ts*`), Playwright 1.58.2, ESLint 9 (next/core-web-vitals + next/typescript).
  - CI is `.github/workflows/ci.yml` (lint, tsc, vitest, playwright).
  - Scripts: dev (`next dev --webpack`), build, start, lint, test:e2e.
- **Gotchas:**
  - The env file is at the repo root (monorepo-specific).
  - Use an E2E test mode that mocks Supabase clients and is inert in production.
  - The service-role key is server-only.
  - Middleware skips cron routes, so cron routes enforce CRON_SECRET themselves.

## E. Orchestration rules the task packages must encode

- **Model tiers:**
  - haiku: mechanical work (file ops, renames, scaffolding commands, small single-file edits).
  - sonnet: normal features, bug fixes, tests, 1-3 files.
  - opus: architecture, cross-cutting work, tricky debugging, **security-sensitive code** (Validator, Hardening Engine, RLS, ledger RPCs, auth).
  - Reviewers are always opus at xhigh effort.
- **Parallel work:** independent tasks run in parallel, each in its own git worktree, and each produces its own PR. `files_owned` must not overlap between tasks that can run concurrently.
- **Review loop:** every PR gets a critic review, a fix pass for non-nitpick findings, and a fresh critic re-review. Merge only once CI and review pass. On failure, retry one tier up.
- **Git identity:** set the repo's local identity to the user before the first commit (`git config user.name "Kurt Lehnardt"`, `git config user.email 12109228+KurtLehnardt@users.noreply.github.com`). The global identity is someone else.
