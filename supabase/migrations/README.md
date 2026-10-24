# Prompt Piggy database migrations

Plain `.sql` files with five-digit names (`NNNNN_description.sql`), applied in ascending filename order. The chain is designed to replay from `00001` against an empty Supabase database, and every file is re-runnable: applying a file a second time changes nothing.

The data model, function list, and grant matrix are specified in `docs/ARCHITECTURE.md` section 5. This file records the chain and the rules every migration follows.

## The chain

Each migration task appends its rows. Only one migration task runs in any parallel group, so this table and `src/types/database.ts` never conflict.

| File | Task | What it does |
| --- | --- | --- |
| `00001_foundation.sql` | PP-03 | `pgcrypto` in `extensions`; schema `private` (USAGE for `service_role` only); deny-by-default privileges for `anon`, `authenticated`, and `service_role`, including the global function revoke; `private.handle_updated_at()`; `public.app_config_value_ok(text, jsonb)`; the profile validators `private.profile_display_name_ok(text)` and `private.profile_avatar_url_ok(text)`; `public.app_config` with its nine seed values; `public.profiles` (identity only, owner-readable); a self-check that fails the migration if any revoke did not take effect |
| `00002_rule_sets.sql` | PP-07 | `public.levels` (readable by `anon` and `authenticated`) and its five rows; the enums `rule_set_state`, `review_status`, and `attack_technique` (12 values, including `unknown`); `public.rule_set_payload_ok(jsonb)`, the SQL mirror of the zod `RuleSetSchema` with every cap; `private.rule_set_sha256(jsonb)`, the hash of a rule set's canonical JSON; `public.rule_sets` (one lineage per level, one active row per level, the stored hash checked against the rules); `public.rule_gate_runs`; `public.golden_prompts`; `public.level_secret_payload_ok(jsonb)` and the service-role-only `public.level_secrets` (no rows: see below); the five active version-0 seed rule sets; a privilege self-check |
| `00003_rule_set_rpcs.sql` | PP-07 | `insert_rule_proposal` (a paid win only, CH-6b; refuses the technique `unknown`), `promote_rule_set` (gated and monotonic), `reject_rule_set`, `rollback_rule_set`, `reset_level_rules`, and the helper `private._reactivate_rules`; all SECURITY INVOKER and executable by `service_role` only |
| `00004_game_ledger.sql` | PP-12 | The enums `attempt_outcome` and `crack_event`; `game_state` (the singleton pig and treasury, readable by `anon`), `wallets` (integer cents, generated `aura_bps`, persistent `crack_count` 0 to 3), `attempts` (owner-readable through a column grant), the append-only `ledger_entries`, `donations`, `live_feed` (readable by `anon`), and the service-role-only `blocked_fingerprints`, `ai_spend`, `rate_limits`, `hardening_jobs` (trigger `win` only), and `admin_actions`; the foreign keys from `rule_sets` and `golden_prompts` back to `attempts`; `private._post_ledger` (the only balance mover); the sanitizers and the sign-up trigger `private.handle_new_user` on `auth.users`; the append-only and rule-set activation triggers; `get_level_status` and `get_public_config` (SECURITY DEFINER, `anon` and `authenticated`); the wall functions `get_live_players` and `presence_ping` (`service_role` only); the `game_state` seed; the realtime publication of exactly `game_state` and `live_feed`; a privilege self-check |
| `00005_hardening_rpcs.sql` | PP-18 | `private._config_bool` and `private._config_bigint` (typed `app_config` reads that fail closed); the service-role-only `leases` table and `claim_lease` (true or NULL, the skylite `claim_stripe_webhook_event` contract); the hardening queue `claim_hardening_job` (empty under the kill switch or with hardening disabled, `FOR UPDATE SKIP LOCKED`, one live job per level, re-claims after 10 minutes) and `finish_hardening_job` (processing to a terminal status only); `add_breach_to_golden` (paid wins only, idempotent by sha256); `reserve_ai_spend` and `settle_ai_spend` (micro-dollars on the caller's day); `get_traffic_corpus` (other players' non-win prompts, limit 1..1000); all `service_role` only; a privilege self-check |
| `00006_wallet_admin_rpcs.sql` | PP-18 | `private._take_rate_token` (token buckets); `private._finalize_attempt_error` (the budgeted error path); `reap_stale_attempts`; `repair_glass`; `donate`; `admin_grant_funds`, `admin_set_player_hidden`, and `reset_game`; `remove_keyword`; `purge_raw_prompts` and `prune_live_feed`; all `service_role` only; a privilege self-check |

Reserved numbers (ARCHITECTURE section 5.6): `00007` for PP-22.

## Rules for every migration

### Privileges: deny by default

`00001` removes Supabase's default grants before any table or function exists, so every privilege that `anon`, `authenticated`, or `service_role` holds was granted explicitly by a migration.

> **Hard rule: every migration grants `service_role` explicitly. Never rely on default privileges for any role.** Every table grants `select, insert, update, delete` to `service_role`, and every sequence (including the sequence behind an identity or `serial` column) grants `usage, select` to `service_role`. Every function grants EXECUTE to the role that calls it. Supabase manages default privileges itself and enforces new defaults on all projects on 2026-10-30, so a default grant is not durable. The generic pgTAP check in `supabase/tests/00001_foundation.test.sql` enumerates every table and sequence in `public` and `private`, so a migration that forgets a `service_role` grant fails `pnpm db:test` locally and in CI.

- **Tables and sequences.** Supabase's bootstrap runs `alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role`. On PostgreSQL 17, `ALL` on a table is `arwdDxtm`, which includes TRUNCATE, REFERENCES, TRIGGER, and MAINTAIN, and row-level security filters none of them (the lesson of skylite's `00035_revoke_truncate.sql`). `00001` revokes all default table and sequence privileges in `public` from `anon` and `authenticated`.
- **Functions.** Postgres grants EXECUTE to `PUBLIC` on every new function through a built-in default that is not schema-scoped, so a per-schema revoke cannot undo it (REVIEW-1 R1-19). `00001` runs `alter default privileges for role postgres revoke execute on functions from public` and also removes the bootstrap's per-schema grants to `anon` and `authenticated`.
- **The service role.** Supabase's change "Tables not exposed to Data and GraphQL API automatically" (opt-in 2026-04-28, the default for new projects from 2026-05-30, enforced on all projects on 2026-10-30) revokes the default table and sequence privileges in `public` from `service_role` too, at a time the platform chooses. Whether a table inherited `service_role` DML would therefore depend on when the project was created and when the enforcement ran. `00001` removes that uncertainty: it revokes every default table, sequence, and function privilege in `public` from `service_role` as well, so every database starts the same way, on old and new projects, before and after the enforcement, and locally with either setting of `auto_expose_new_tables`. The service role is still fully trusted (ARCHITECTURE section 5.1); each migration states that trust with explicit grants (the hard rule above).
- **Every table** enables RLS, runs `revoke all on table ... from public, anon, authenticated`, and then grants exactly what section 5.3 lists, plus the explicit `service_role` grant (`grant select, insert, update, delete on table ... to service_role`, and `grant usage, select on sequence ... to service_role` for each of its sequences). No table grants INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, or MAINTAIN to `anon` or `authenticated`.
- **Service-role-only tables** (no row is readable by end users) take one of two forms. `app_config` has RLS plus one restrictive deny-all policy for `anon` and `authenticated`. The tables that ARCHITECTURE section 5.3 lists with no policy (`rule_sets`, `rule_gate_runs`, `golden_prompts`, `level_secrets`, `blocked_fingerprints`, `ai_spend`, `rate_limits`, `hardening_jobs`, `admin_actions`, and `leases`) have RLS enabled, no policy, and no grant to `anon` or `authenticated`. The CI advisor gate allowlists the `rls_enabled_no_policy` finding for exactly those ten tables, with that reason; any other table without a policy fails the job. `level_secrets` must keep no policy at all (REVIEW-2 R2-12, and its pgTAP test).
- **Every function** gets `revoke all on function ... from public, anon, authenticated`, followed by `grant execute` to the role that calls it, which for an RPC is `service_role`. A function that a CHECK constraint uses must be executable by every role that writes the table, because the CHECK runs with the writer's privileges.

These rules apply to objects created by `postgres`, which is the role every migration runs as, locally and on the hosted projects.

### Functions

- Every function sets `search_path = ''` and schema-qualifies every table, type, and function it uses (`public.`, `private.`, `extensions.`, `auth.`). Only `pg_catalog` built-ins are left unqualified, because Postgres always searches `pg_catalog` first (REVIEW-2 R2-17, the Supabase linter's `function_search_path_mutable`).
- Internal helpers live in schema `private`, which PostgREST does not expose (it is not in `[api] schemas` in `supabase/config.toml`). Only `service_role` has USAGE on it.
- SECURITY DEFINER is used only where section 5.4 says so. The advisor allowlist holds exactly `get_level_status()` and `get_public_config()` (PP-12).
- Policies call `auth.uid()` as `(select auth.uid())`, so it is evaluated once per statement rather than once per row.

### Re-runnable statements

Use `create table if not exists`, `create index if not exists`, `create or replace function`, `create or replace trigger`, `drop policy if exists` before `create policy`, `insert ... on conflict do nothing` for seeds, and a `pg_constraint` check before `alter table ... add constraint` (PostgreSQL has no `add constraint if not exists`). REVOKE and GRANT are idempotent by nature.

### Indexes

Every foreign-key column is indexed, except references to the five-row `levels` table (skill reference `schema-foreign-key-indexes`, REVIEW-2 R2-19).

## Rule sets and level secrets (00002, 00003)

- **Typed rules only (HC1, HC-A1).** A rule set is nine boolean detector flags plus `block_keywords`, a capped array of lowercase ASCII phrases that the validator matches as data. The CHECK `rule_set_payload_ok` rejects any other key, type, or size, so no free-text rule can be stored. The zod schema in `src/lib/rules` stays authoritative in TypeScript.
- **Hashes.** `rules_sha256` is the sha256 of the rule set's canonical JSON: keys and keywords in ascending code-point order, no whitespace. That is byte-identical to `JSON.stringify` of the same object with sorted keys and keywords, and a CHECK keeps the stored hash equal to the hash of the stored rules. `level_secrets.payload_sha256` is the sha256 of the payload's canonical JSON (keys sorted recursively), computed by `scripts/ops/seed-level-secrets.mjs`.
- **States and locks.** Only the 00003 functions change which row is active. Each one locks the `levels` row first, then `rule_sets` rows in ascending id order (ARCHITECTURE section 5.1, lock orders 6 and 7). Errors use PTnnn SQLSTATEs whose message starts with the error token, for example `stale_parent` (PT409) or `invalid_rollback_target` (PT422); the header of `00003_rule_set_rpcs.sql` lists them all. Rollback and reset are run by hand from the SQL runbook and skip the gate by design.
- **Paid wins only (CH-6b).** `insert_rule_proposal` refers to `public.attempts` (created by `00004`) inside plpgsql, so the reference is bound when the statement first runs. Until `00004` exists every call fails closed with `not_a_win`.
- **Level secrets (R2-12).** No migration writes `level_secrets`; a pgTAP test and a unit test scan every migration for it. Local databases get the placeholders of `src/lib/config/__fixtures__/level-secrets.placeholder.json` from `supabase/seed.sql`. Hosted projects get the real material only through the operator script:

  ```sh
  # Operator only. LEVEL_SECRETS_FILE defaults to .secrets/level-secrets.json (gitignored).
  NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/ops/seed-level-secrets.mjs --dry-run
  NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/ops/seed-level-secrets.mjs
  ```

  It refuses a file that git tracks (the committed placeholders load only through `--placeholder-fixture`), refuses placeholders for any URL other than localhost or 127.0.0.1, and prints only level ids and hash prefixes.

## Game and ledger (00004)

- **Money (CH-1).** Every amount is mocked US dollars in `bigint` integer cents, taken from `app_config` or a row, never from a request. `private._post_ledger(kind, from, to, amount, user_id, attempt_id, external_ref)` is the only function that changes `wallets.balance_cents` or `game_state.treasury_cents`. Each kind has fixed account types (for example `attempt_fee` is `player:<id>` to `treasury`, `payout` is `treasury` to `player:<id>`), a player side must belong to `user_id`, and the wallet side is applied before the treasury side (lock order 3 before 4). A player overdraft raises `PT402 insufficient_funds` with the hint `{"balanceCents", "priceCents"}`; a treasury overdraft or a mismatched call raises `PT422 invariant_violation`. `external_ref` is unique and must be 8 to 100 characters of `[a-z0-9_:-]`, so short references such as `seed:2` are refused: the game-state seed uses `seed:epoch:<n>`. `ledger_entries` refuses UPDATE, DELETE, and TRUNCATE with `PT403` for every role.
- **Sign-up (R2-06, R2-16).** `private.handle_new_user` (AFTER INSERT on `auth.users`, the only trigger there) skips anonymous users, snapshots the Google name and avatar once through the sanitizers (any other provider gets `Player NNNN` and no avatar), creates the wallet, and mints `starting_balance_cents` once with `external_ref = 'start:<id>'`. The sanitizers end with the same `private` validators that the `profiles` CHECK constraints use, so a bad Google profile falls back instead of aborting sign-up. The trigger's body is `private._provision_user`; `private._backfill_users()`, which 00004 runs once, provisions every non-anonymous account created before 00004 the same way, and a re-run grants nothing twice.
- **Attempts.** `error` needs an `error_code`, `fail` may carry one, and every other outcome has none; `finalized_at` is set exactly when the outcome is not `pending`. The RPCs of PP-18 and PP-22 must set both together.
- **The wall (R3-02).** `get_live_players(window, limit, known_hash)` and `presence_ping(user_id, window, limit, known_hash)` return at most one row, `(list_hash text, players jsonb)`, where `players` holds `LivePlayerDTO` objects (`id`, `name`, `avatarUrl`, `auraBps`, `lastSeenBucket`) and nothing else. A `known_hash` equal to the current hash returns no row, which the route maps to `{ unchanged: true }`; an empty wall is one row with `players = []`. The md5 hash covers id, name, avatar, and aura only, never `lastSeenBucket` or the order, so it stays unchanged between heartbeats. The window is clamped to 30..3600 seconds and the limit to 1..150; the game-page strip passes about 30.

## Hardening, wallet, and admin RPCs (00005, 00006)

- **Lock order (R1-02).** Every function takes row locks in the global order of ARCHITECTURE section 5.1 (profiles, rate_limits, wallets, game_state, attempts, levels, rule_sets, ..., hardening_jobs, leases, ai_spend last), rows of one table in ascending key order, and a `-- Lock order (section 5.1):` comment at the top of each body names the order it uses; the pgTAP suites check that every body carries it. `claim_hardening_job` also takes a transaction-scoped advisory lock before its single row lock, so concurrent claims serialize and one level never has two live processing jobs.
- **Booleans that can be NULL.** `claim_lease` returns `true` to the one caller that gets the lease and NULL (not false) otherwise, the documented contract of skylite's `claim_stripe_webhook_event`. Callers test `data === true`.
- **The error path (R2-01, R2-04).** `private._finalize_attempt_error(attempt, code, actual_micros)` is the only way an attempt ends as `error`: once (`PT409 already_finalized` afterwards), with `finalized_at` and the required `error_code` set together. It refunds `attempts.price_cents` while the player has received fewer than `app_config.refund_budget_per_hour` refunds in the rolling hour (a missing key refunds nothing), from the treasury while the attempt's epoch is current and as `refund_mint` after a payout or reset; otherwise it keeps the fee and sets `refund_withheld`. Cracks never change, the in-flight marker is cleared, and spend is settled once on `attempts.spend_day`. `record_attempt`, `start_attempt` (a stale in-flight row), the same-key re-POST reaper (R3-06), the unstorable-reply path (R3-07), and `reap_stale_attempts` (code `reaped`, actual = reserved, default 45 seconds) all go through it.
- **Wallet RPCs (CH-1, CH-2).** `repair_glass` charges `app_config.repair_price_cents` (never a parameter) into the treasury and sets `crack_count` to 0 in one transaction; at 0 cracks it raises `PT409 nothing_to_repair` and charges nothing. `donate` moves 1 cent up to the stored balance to the `cncf` sink, increments `total_donated_cents`, and writes a `donations` row; `aura_bps` follows from the generated column. Both take one token from the player's `wallet` bucket first (`PT429 rate_limited` with `{"retryAfterSeconds"}`), and both are idempotent by key (`repair:<user>:<key>` in the ledger, `donations (user_id, idempotency_key)`), returning `replay = true` without moving money.
- **Admin RPCs.** `admin_grant_funds` mints 1 to `admin_grant_max_cents` with `external_ref = 'grant:<key>'` (a key reused for another player raises `PT409 idempotency_conflict`); `admin_set_player_hidden` removes a player from the wall; `reset_game` sets the level and increments `pig_epoch` without touching the treasury; `remove_keyword` activates version n+1 without one keyword and supersedes the previous row. Each writes `admin_actions`, and no log row carries free text.
- **Retention (CH-7).** `purge_raw_prompts(days)` nulls `prompt` and `reply` of finalized attempts past retention except paid wins, whose prompts also stay in `golden_prompts`; `prune_live_feed(days)` deletes old feed rows.

## Local workflow

The local stack runs in Docker through the Supabase CLI dev dependency (`pnpm exec supabase`, CLI 2.122). `supabase/config.toml` configures the local stack only.

```sh
pnpm db:start                     # start the local stack
pnpm db:reset                     # replay every migration, then supabase/seed.sql
pnpm db:test                      # pgTAP tests in supabase/tests/ (flat file names)
pnpm db:types && git diff --exit-code src/types/database.ts   # generated types are current
pnpm exec supabase db advisors --local --type all --level info   # no unallowlisted security finding
pnpm db:stop
```

`supabase/seed.sql` holds local-only data and is never applied to a hosted project.

## Hosted projects

Agents never run `supabase link`, `supabase db push`, or any command against a hosted project. The user applies migrations to the hosted projects. Before a migration is committed, `supabase db advisors` runs against the local database, and every security finding is fixed or allowlisted with a written reason (REVIEW-2 R2-18).
