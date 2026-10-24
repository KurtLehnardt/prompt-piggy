# Prompt Piggy database migrations

Plain `.sql` files with five-digit names (`NNNNN_description.sql`), applied in ascending filename order. The chain is designed to replay from `00001` against an empty Supabase database, and every file is re-runnable: applying a file a second time changes nothing.

The data model, function list, and grant matrix are specified in `docs/ARCHITECTURE.md` section 5. This file records the chain and the rules every migration follows.

## The chain

Each migration task appends its rows. Only one migration task runs in any parallel group, so this table and `src/types/database.ts` never conflict.

| File | Task | What it does |
| --- | --- | --- |
| `00001_foundation.sql` | PP-03 | `pgcrypto` in `extensions`; schema `private` (USAGE for `service_role` only); deny-by-default privileges, including the global function revoke; explicit default DML grants to `service_role`; `private.handle_updated_at()`; `public.app_config_value_ok(text, jsonb)`; the profile validators `private.profile_display_name_ok(text)` and `private.profile_avatar_url_ok(text)`; `public.app_config` with its nine seed values; `public.profiles` (identity only, owner-readable); a self-check that fails the migration if any revoke did not take effect |

Reserved numbers (ARCHITECTURE section 5.6): `00002` and `00003` for PP-07, `00004` for PP-12, `00005` and `00006` for PP-18, and `00007` for PP-22.

## Rules for every migration

### Privileges: deny by default

`00001` removes Supabase's default grants before any table or function exists, so every privilege that `anon` or `authenticated` holds was granted explicitly by a migration.

- **Tables and sequences.** Supabase's bootstrap runs `alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role`. On PostgreSQL 17, `ALL` on a table is `arwdDxtm`, which includes TRUNCATE, REFERENCES, TRIGGER, and MAINTAIN, and row-level security filters none of them (the lesson of skylite's `00035_revoke_truncate.sql`). `00001` revokes all default table and sequence privileges in `public` from `anon` and `authenticated`.
- **Functions.** Postgres grants EXECUTE to `PUBLIC` on every new function through a built-in default that is not schema-scoped, so a per-schema revoke cannot undo it (REVIEW-1 R1-19). `00001` runs `alter default privileges for role postgres revoke execute on functions from public` and also removes the bootstrap's per-schema grants to `anon` and `authenticated`.
- **The service role.** Since Supabase's change of 2026-04-28 ("Tables not exposed to Data and GraphQL API automatically"), new projects no longer grant table and sequence privileges in `public` to `service_role` either. `00001` grants `select, insert, update, delete` on future tables and `usage, select` on future sequences in `public` to `service_role` through default privileges, so the blueprint's rule that the service role keeps full DML holds on old and new projects alike. Each table also grants `service_role` explicitly. Functions get no default grant at all: with the new behaviour (`auto_expose_new_tables = false` in the local CLI), a new function in `public` is executable by its owner only, so every function must grant EXECUTE explicitly, as the rules below require. The pgTAP suite passes in both modes.
- **Every table** enables RLS, runs `revoke all on table ... from public, anon, authenticated`, and then grants exactly what section 5.3 lists. No table grants INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, or MAINTAIN to `anon` or `authenticated`.
- **Service-role-only tables** (no row is readable by end users) get RLS plus one restrictive deny-all policy for `anon` and `authenticated`, as `app_config` does. That states the intent in the schema, and it keeps `supabase db advisors` free of the "RLS enabled, no policy" finding.
- **Every function** gets `revoke all on function ... from public, anon, authenticated`, followed by `grant execute` to the role that calls it. A function that a CHECK constraint uses must be executable by every role that writes the table, because the CHECK runs with the writer's privileges.

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
