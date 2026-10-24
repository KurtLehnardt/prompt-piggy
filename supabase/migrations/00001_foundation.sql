-- Migration 00001: foundation (task PP-03)
--
-- Contents (docs/ARCHITECTURE.md sections 5.1, 5.2, 5.3, 5.6):
--   1. pgcrypto in schema extensions.
--   2. Schema private for internal helpers. PostgREST does not expose it (R2-17).
--   3. Deny-by-default privileges, before any table or function exists. This is
--      the lesson of skylite 00035, plus the global function revoke (R1-19).
--      The default privileges of service_role are revoked too, so no object
--      depends on a platform-managed default ACL: every table, sequence, and
--      function grants service_role explicitly (PR #3 review, H1).
--   4. private.handle_updated_at(), public.app_config_value_ok(), and the
--      profile validators private.profile_display_name_ok() and
--      private.profile_avatar_url_ok().
--   5. public.app_config (service role only) and its seed.
--   6. public.profiles (identity only, owner-readable).
--   7. A self-check that fails the migration if any revoke silently did nothing.
--
-- Conventions that every later migration follows:
--   - Every function sets search_path = '' and schema-qualifies every table,
--     type, and function it uses (public., private., extensions., auth.). Only
--     pg_catalog built-ins are left unqualified; Postgres always searches
--     pg_catalog first, even with an empty search_path.
--   - Every function gets an explicit REVOKE ALL ... FROM public, anon,
--     authenticated, followed by a GRANT EXECUTE to the role that needs it.
--   - Every table has RLS enabled, and every grant to anon or authenticated is
--     explicit. No table grants INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES,
--     TRIGGER, or MAINTAIN to anon or authenticated.
--   - Every table grants select, insert, update, delete to service_role
--     explicitly, and every sequence grants usage, select to service_role.
--     Never rely on default privileges for any role. The pgTAP suite checks
--     every table and sequence in public and private for these grants.
--
-- Re-runnable: every statement is idempotent (if not exists, create or replace,
-- drop policy if exists, on conflict do nothing, and REVOKE and GRANT, which are
-- idempotent by nature), so applying this file twice changes nothing.

-- ===========================================================================
-- 1. Extensions
-- ===========================================================================
create extension if not exists pgcrypto with schema extensions;

-- ===========================================================================
-- 2. Schema private
-- ===========================================================================
-- Internal helpers live here: the validators below, and later _post_ledger,
-- _finalize_attempt_error, the sanitizers, and handle_new_user. The schema is
-- not in [api] schemas in supabase/config.toml, so PostgREST never exposes it.
-- Only service_role may resolve names in it, because the SECURITY INVOKER
-- functions that call these helpers run as service_role.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

comment on schema private is
  'Internal helpers for Prompt Piggy. Not exposed by PostgREST. USAGE is granted '
  'to service_role only; anon and authenticated cannot resolve names here.';

-- ===========================================================================
-- 3. Deny by default (skylite 00035, REVIEW-1 R1-19)
-- ===========================================================================
-- On older projects, Supabase's bootstrap runs, as postgres:
--   alter default privileges in schema public grant all on tables
--     to postgres, anon, authenticated, service_role;
-- and the same for sequences and functions. On PostgreSQL 17, ALL on a table
-- is arwdDxtm: TRUNCATE (D), REFERENCES (x), TRIGGER (t), and MAINTAIN (m) are
-- included, and row-level security filters none of them. Every migration in
-- this repository runs as postgres, so the postgres-owned default ACL entry is
-- the one that applies to every object created here. These statements run
-- before any table or function exists, so nothing is created with those
-- grants. They are written without "for role", which means the current role,
-- postgres.
--
-- service_role is revoked here too. Supabase's change "Tables not exposed to
-- Data and GraphQL API automatically" (opt-in 2026-04-28, the default for new
-- projects from 2026-05-30, enforced on all projects on 2026-10-30) revokes
-- these defaults from service_role as well, at a time the platform chooses. A
-- default grant to service_role is therefore not durable: whether a later
-- table inherited it would depend on when the project was created and when
-- the enforcement ran. Revoking it here gives every database the same
-- starting point (no default privilege for any Data API role) on old and new
-- projects, before and after the enforcement, and locally with either setting
-- of auto_expose_new_tables. The service role is still fully trusted
-- (ARCHITECTURE section 5.1); each migration states that trust with explicit
-- grants, as the tables below do, and the pgTAP suite fails on any table or
-- sequence that lacks them.
alter default privileges in schema public revoke all on tables    from anon, authenticated, service_role;
alter default privileges in schema public revoke all on sequences from anon, authenticated, service_role;

-- Functions: Postgres grants EXECUTE to PUBLIC on every new function through a
-- built-in default that is not schema-scoped. A per-schema revoke cannot undo
-- it (R1-19), so the revoke is global. The second statement removes the
-- bootstrap's explicit per-schema grants, so a function is executable only by
-- the roles its migration grants.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated, service_role;

-- ===========================================================================
-- 4. Shared helper functions
-- ===========================================================================

-- Trigger function: stamps updated_at on every UPDATE. A trigger function
-- cannot be called directly, and firing a trigger needs no EXECUTE privilege,
-- so no role is granted EXECUTE.
create or replace function private.handle_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

revoke all on function private.handle_updated_at() from public, anon, authenticated;

-- Validates one app_config value for its key. Money values are integer cents
-- (CH-1). It returns true or false and never raises: the checks run in order
-- inside plpgsql, so a value is cast to bigint only after its JSON text is
-- known to be a plain integer of at most 18 digits. That also rejects
-- fractional values such as 100.0, so every reader can cast a stored value
-- with value::text::bigint. An unknown key, including the removed presence_mode
-- (R2-S1), is rejected outright.
create or replace function public.app_config_value_ok(p_key text, p_value jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_number bigint;
begin
  if p_key is null or p_value is null then
    return false;
  end if;

  if p_key in ('kill_switch', 'attempts_enabled', 'hardening_enabled') then
    return jsonb_typeof(p_value) = 'boolean';
  end if;

  if p_key not in (
    'starting_balance_cents',
    'attempt_price_cents',
    'repair_price_cents',
    'treasury_seed_cents',
    'admin_grant_max_cents',
    'refund_budget_per_hour'
  ) then
    return false;
  end if;

  if jsonb_typeof(p_value) <> 'number' or p_value::text !~ '^-?[0-9]{1,18}$' then
    return false;
  end if;
  v_number := p_value::text::bigint;

  return case p_key
    when 'starting_balance_cents' then v_number between 0 and 100000
    when 'attempt_price_cents'    then v_number between 1 and 10000
    when 'repair_price_cents'     then v_number between 1 and 10000
    when 'treasury_seed_cents'    then v_number between 0 and 1000000
    when 'admin_grant_max_cents'  then v_number between 1 and 100000
    when 'refund_budget_per_hour' then v_number between 0 and 20   -- R2-01
    else false
  end;
end
$$;

-- service_role writes app_config from the admin routes, and a CHECK constraint
-- runs its function with the privileges of the role doing the write.
revoke all on function public.app_config_value_ok(text, jsonb) from public, anon, authenticated;
grant execute on function public.app_config_value_ok(text, jsonb) to service_role;

-- Display-name rule for public.profiles (CH-3, R2-06): 1 to 32 characters and
-- none of these characters:
--   [[:cntrl:]]       C0 controls and DEL
--   U+0080..U+009F    C1 controls, listed explicitly because [[:cntrl:]]
--                     depends on the database's character classification
--   U+200B..U+200F    zero-width space, ZWNJ, ZWJ, LRM, RLM
--   U+202A..U+202E    bidirectional embeddings and overrides, including RLO
--   U+2066..U+2069    bidirectional isolates
--   U+FEFF            zero-width no-break space (BOM)
-- PP-12's private._sanitize_display_name must strip exactly this set, and its
-- result must satisfy this function, or sign-up would fail on the CHECK.
create or replace function private.profile_display_name_ok(p_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_name is not null
     and char_length(p_name) between 1 and 32
     and p_name !~ '[[:cntrl:]\u0080-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]';
$$;

-- Avatar rule for public.profiles (R2-06): null, or a Google account photo of
-- at most 512 characters, served from lh3.googleusercontent.com under /a/ or
-- /a-/. The path allows letters, digits, and _ = . ~ / -. There is no percent
-- sign, query, fragment, or backslash, and no path segment may be . or ..,
-- because a browser resolves those and would leave the account-photo paths.
-- Any other URL is rejected, and the UI shows initials instead.
create or replace function private.profile_avatar_url_ok(p_url text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_url is null
      or (    char_length(p_url) <= 512
          and p_url ~ '^https://lh3\.googleusercontent\.com/a-?/[A-Za-z0-9_=.~/-]+$'
          and p_url !~ '/\.\.?(/|$)');
$$;

-- service_role updates profiles (admin_set_player_hidden), and every UPDATE
-- re-checks the CHECK constraints as the updating role.
revoke all on function private.profile_display_name_ok(text) from public, anon, authenticated;
revoke all on function private.profile_avatar_url_ok(text) from public, anon, authenticated;
grant execute on function private.profile_display_name_ok(text) to service_role;
grant execute on function private.profile_avatar_url_ok(text) to service_role;

-- ===========================================================================
-- 5. app_config: service role only
-- ===========================================================================
-- Money amounts and switches live here, never in a request or an environment
-- variable (ARCHITECTURE section 5.1). Admin routes write it with the service
-- role. PP-12's get_public_config() exposes the public subset.
create table if not exists public.app_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  constraint app_config_key_format check (key ~ '^[a-z][a-z0-9_]{1,63}$'),
  constraint app_config_value_valid check (public.app_config_value_ok(key, value))
);

comment on table public.app_config is
  'Game configuration (integer cents and switches). RLS is enabled, and a '
  'restrictive policy denies anon and authenticated. Neither role holds any '
  'privilege. Only the service role reads or writes it; get_public_config() '
  'exposes the public subset.';

-- Every foreign-key column is indexed (skill reference schema-foreign-key-indexes, R2-19).
create index if not exists app_config_updated_by_idx on public.app_config (updated_by);

create or replace trigger app_config_updated_at
  before update on public.app_config
  for each row execute function private.handle_updated_at();

alter table public.app_config enable row level security;

-- RLS without a policy already denies every row. This restrictive policy
-- states the intent explicitly, so a future permissive policy or grant still
-- cannot open the table to end users, and the advisor has no
-- "RLS enabled, no policy" finding to report.
drop policy if exists "app_config: no end-user access" on public.app_config;
create policy "app_config: no end-user access" on public.app_config
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

revoke all on table public.app_config from public, anon, authenticated;
grant select, insert, update, delete on table public.app_config to service_role;

-- Seed values (CH-1, R2-01, R2-S1). on conflict do nothing keeps any value an
-- admin has changed when the migration is re-run.
insert into public.app_config (key, value) values
  ('kill_switch',            'false'),
  ('attempts_enabled',       'true'),
  ('hardening_enabled',      'true'),
  ('starting_balance_cents', '2000'),
  ('attempt_price_cents',    '100'),
  ('repair_price_cents',     '100'),
  ('treasury_seed_cents',    '0'),
  ('admin_grant_max_cents',  '10000'),
  ('refund_budget_per_hour', '3')
on conflict (key) do nothing;

-- ===========================================================================
-- 6. profiles: identity only, shown on the presence wall
-- ===========================================================================
-- A one-time snapshot of the Google display name and avatar, taken at sign-up
-- by PP-12's private.handle_new_user and never refreshed from user-editable
-- metadata (R2-06). The email address is never stored here.
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  avatar_url   text,
  live_hidden  boolean not null default false,   -- admin "hide from wall" (section 9.7)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint profiles_display_name_valid check (private.profile_display_name_ok(display_name)),
  constraint profiles_avatar_url_valid   check (private.profile_avatar_url_ok(avatar_url))
);

comment on table public.profiles is
  'Identity snapshot (display name and Google account-photo URL) taken once at '
  'sign-up. No email. Owners read their own row; writes go through '
  'private.handle_new_user and service-role RPCs only.';

create or replace trigger profiles_updated_at
  before update on public.profiles
  for each row execute function private.handle_updated_at();

alter table public.profiles enable row level security;

-- (select auth.uid()) is evaluated once per statement, not once per row
-- (skill reference security-rls-performance). The primary key indexes id.
drop policy if exists "profiles: owner reads own row" on public.profiles;
create policy "profiles: owner reads own row" on public.profiles
  for select
  to authenticated
  using (id = (select auth.uid()));

revoke all on table public.profiles from public, anon, authenticated;
grant select on table public.profiles to authenticated;
grant select, insert, update, delete on table public.profiles to service_role;

-- ===========================================================================
-- 7. Self-check: fail loudly if a revoke silently did nothing
-- ===========================================================================
-- REVOKE only warns, and changes nothing, when the current role is not the
-- grantor of a privilege. A security migration that silently no-ops is worse
-- than one that fails, so the end state is verified here as well as in
-- supabase/tests/00001_foundation.test.sql. The privilege list includes
-- MAINTAIN on PostgreSQL 17 and later (the skylite 00035 lesson).
do $$
declare
  v_privileges text[] := array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  v_exposed text;
begin
  if current_setting('server_version_num')::integer >= 170000 then
    v_privileges := array_append(v_privileges, 'MAINTAIN');
  end if;

  -- The tables of this migration, and a canary table that proves the default
  -- privileges: anon may hold nothing, authenticated only SELECT on profiles.
  -- Any failure below rolls the whole migration back, canaries included.
  drop table if exists public._pp_00001_privilege_canary;
  create table public._pp_00001_privilege_canary (id integer);

  select string_agg(format('%s:%s.%s', r.role_name, t.table_name, p.privilege), ', ')
    into v_exposed
  from (values ('anon'), ('authenticated')) as r (role_name)
  cross join (values ('public.app_config'), ('public.profiles'), ('public._pp_00001_privilege_canary')) as t (table_name)
  cross join unnest(v_privileges) as p (privilege)
  where has_table_privilege(r.role_name, t.table_name, p.privilege)
    and not (r.role_name = 'authenticated' and t.table_name = 'public.profiles' and p.privilege = 'SELECT');

  if v_exposed is not null then
    raise exception '00001: anon or authenticated still hold table privileges: %', v_exposed;
  end if;

  -- A new table inherits nothing for service_role either, so the explicit
  -- grants below are what it relies on (PR #3 review, H1).
  if has_table_privilege('service_role', 'public._pp_00001_privilege_canary', 'SELECT')
     or has_table_privilege('service_role', 'public._pp_00001_privilege_canary', 'INSERT') then
    raise exception '00001: a new table still inherits default privileges for service_role';
  end if;
  drop table public._pp_00001_privilege_canary;

  select string_agg(format('%s.%s', t.table_name, p.privilege), ', ')
    into v_exposed
  from (values ('public.app_config'), ('public.profiles')) as t (table_name)
  cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p (privilege)
  where not has_table_privilege('service_role', t.table_name, p.privilege);

  if v_exposed is not null then
    raise exception '00001: service_role lacks its explicit table grants: %', v_exposed;
  end if;

  -- A canary function proves the global EXECUTE revoke (R1-19).
  drop function if exists public._pp_00001_execute_canary();
  create function public._pp_00001_execute_canary() returns integer
    language sql set search_path = '' as 'select 1';

  if has_function_privilege('anon', 'public._pp_00001_execute_canary()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public._pp_00001_execute_canary()', 'EXECUTE') then
    raise exception '00001: a new function is still executable by anon or authenticated';
  end if;
  drop function public._pp_00001_execute_canary();

  if has_schema_privilege('anon', 'private', 'USAGE')
     or has_schema_privilege('authenticated', 'private', 'USAGE')
     or not has_schema_privilege('service_role', 'private', 'USAGE') then
    raise exception '00001: schema private must grant USAGE to service_role only';
  end if;
end
$$;
