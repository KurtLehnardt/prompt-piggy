-- pgTAP tests for supabase/migrations/00001_foundation.sql (task PP-03).
--
-- Run with `pnpm db:test` against the local stack after `pnpm db:reset`.
-- Everything runs in one transaction that is rolled back, so the fixtures and
-- the objects created here never persist.
--
-- The tests stay valid as later migrations land: they never assert the total
-- number of app_config keys, and they upsert the profiles they need, because
-- PP-12's sign-up trigger creates a profile for every new auth.users row.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(114);

-- ---------------------------------------------------------------------------
-- Helpers and fixtures
-- ---------------------------------------------------------------------------

-- Every table privilege the role holds, sorted. NULL means none. MAINTAIN is
-- included on PostgreSQL 17 and later (the skylite 00035 lesson).
create function pg_temp.held_table_privileges(p_role text, p_table text)
returns text[]
language sql
stable
as $$
  select array_agg(p.privilege order by p.privilege)
  from unnest(
    array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
    || case when current_setting('server_version_num')::integer >= 170000
            then array['MAINTAIN'] else array[]::text[] end
  ) as p (privilege)
  where has_table_privilege(p_role, p_table, p.privilege);
$$;

-- Two users, A and B, with synthetic addresses.
insert into auth.users (id, aud, role, email)
values
  ('00000000-0000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'pp03-user-a@example.test'),
  ('00000000-0000-4000-8000-00000000000b', 'authenticated', 'authenticated', 'pp03-user-b@example.test');

insert into public.profiles (id, display_name)
values
  ('00000000-0000-4000-8000-00000000000a', 'User A'),
  ('00000000-0000-4000-8000-00000000000b', 'User B')
on conflict (id) do update set display_name = excluded.display_name, avatar_url = null;

-- ---------------------------------------------------------------------------
-- Schema private (R2-17): 6 tests
-- ---------------------------------------------------------------------------
select has_schema('private', 'schema private exists');
select ok(not has_schema_privilege('anon', 'private', 'USAGE'), 'anon has no USAGE on schema private');
select ok(not has_schema_privilege('authenticated', 'private', 'USAGE'), 'authenticated has no USAGE on schema private');
select ok(has_schema_privilege('service_role', 'private', 'USAGE'), 'service_role has USAGE on schema private');
select ok(
  not has_schema_privilege('anon', 'private', 'CREATE')
    and not has_schema_privilege('authenticated', 'private', 'CREATE'),
  'anon and authenticated have no CREATE on schema private'
);
select ok(
  not exists (
    select 1
    from pg_namespace n, aclexplode(n.nspacl) as a
    where n.nspname = 'private' and a.grantee = 0
  ),
  'PUBLIC holds no privilege on schema private'
);

-- ---------------------------------------------------------------------------
-- Row-level security: 2 tests
-- ---------------------------------------------------------------------------
select ok(
  (select c.relrowsecurity from pg_class c where c.oid = 'public.profiles'::regclass),
  'RLS is enabled on profiles'
);
select ok(
  (select c.relrowsecurity from pg_class c where c.oid = 'public.app_config'::regclass),
  'RLS is enabled on app_config'
);

-- ---------------------------------------------------------------------------
-- Table privileges on profiles and app_config: 8 tests
-- ---------------------------------------------------------------------------
select is(
  pg_temp.held_table_privileges('anon', 'public.profiles'), null::text[],
  'anon holds no privilege on profiles (including TRUNCATE, REFERENCES, TRIGGER, MAINTAIN)'
);
select is(
  pg_temp.held_table_privileges('authenticated', 'public.profiles'), array['SELECT'],
  'authenticated holds SELECT on profiles and no INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, or MAINTAIN'
);
select ok(
  not has_any_column_privilege('anon', 'public.profiles', 'SELECT')
    and not has_any_column_privilege('anon', 'public.profiles', 'INSERT')
    and not has_any_column_privilege('anon', 'public.profiles', 'UPDATE')
    and not has_any_column_privilege('anon', 'public.profiles', 'REFERENCES'),
  'anon holds no column privilege on profiles'
);
select ok(
  not has_any_column_privilege('authenticated', 'public.profiles', 'INSERT')
    and not has_any_column_privilege('authenticated', 'public.profiles', 'UPDATE')
    and not has_any_column_privilege('authenticated', 'public.profiles', 'REFERENCES'),
  'authenticated holds no column-level INSERT, UPDATE, or REFERENCES on profiles'
);
select is(
  pg_temp.held_table_privileges('anon', 'public.app_config'), null::text[],
  'anon holds no privilege on app_config'
);
select is(
  pg_temp.held_table_privileges('authenticated', 'public.app_config'), null::text[],
  'authenticated holds no privilege on app_config'
);
select ok(
  not has_any_column_privilege('anon', 'public.app_config', 'SELECT')
    and not has_any_column_privilege('authenticated', 'public.app_config', 'SELECT')
    and not has_any_column_privilege('anon', 'public.app_config', 'UPDATE')
    and not has_any_column_privilege('authenticated', 'public.app_config', 'UPDATE'),
  'anon and authenticated hold no column privilege on app_config'
);
select ok(
  pg_temp.held_table_privileges('service_role', 'public.profiles') @> array['DELETE', 'INSERT', 'SELECT', 'UPDATE']
    and pg_temp.held_table_privileges('service_role', 'public.app_config') @> array['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  'service_role holds SELECT, INSERT, UPDATE, and DELETE on profiles and app_config'
);

-- ---------------------------------------------------------------------------
-- Default privileges: objects created after 00001 (skylite 00035, R1-19): 10 tests
-- ---------------------------------------------------------------------------
create table public.zz_pp03_after_00001 (
  id integer generated always as identity primary key,
  note text
);

select is(
  pg_temp.held_table_privileges('anon', 'public.zz_pp03_after_00001'), null::text[],
  'a table created after 00001 grants nothing to anon'
);
select is(
  pg_temp.held_table_privileges('authenticated', 'public.zz_pp03_after_00001'), null::text[],
  'a table created after 00001 grants nothing to authenticated'
);
select ok(
  pg_temp.held_table_privileges('service_role', 'public.zz_pp03_after_00001') @> array['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  'a table created after 00001 grants SELECT, INSERT, UPDATE, and DELETE to service_role'
);
select ok(
  not has_sequence_privilege('anon', pg_get_serial_sequence('public.zz_pp03_after_00001', 'id'), 'USAGE')
    and not has_sequence_privilege('anon', pg_get_serial_sequence('public.zz_pp03_after_00001', 'id'), 'SELECT')
    and not has_sequence_privilege('anon', pg_get_serial_sequence('public.zz_pp03_after_00001', 'id'), 'UPDATE'),
  'a sequence created after 00001 grants nothing to anon'
);
select ok(
  not has_sequence_privilege('authenticated', pg_get_serial_sequence('public.zz_pp03_after_00001', 'id'), 'USAGE')
    and not has_sequence_privilege('authenticated', pg_get_serial_sequence('public.zz_pp03_after_00001', 'id'), 'SELECT')
    and not has_sequence_privilege('authenticated', pg_get_serial_sequence('public.zz_pp03_after_00001', 'id'), 'UPDATE'),
  'a sequence created after 00001 grants nothing to authenticated'
);

create function public.zz_pp03_after_00001_fn()
returns integer
language sql
set search_path = ''
as 'select 1';

create function private.zz_pp03_after_00001_private_fn()
returns integer
language sql
set search_path = ''
as 'select 1';

select ok(
  not has_function_privilege('anon', 'public.zz_pp03_after_00001_fn()', 'execute'),
  'R1-19: a function created in public after 00001 is not executable by anon'
);
select ok(
  not has_function_privilege('authenticated', 'public.zz_pp03_after_00001_fn()', 'execute'),
  'R1-19: a function created in public after 00001 is not executable by authenticated'
);
select ok(
  not exists (
    select 1
    from pg_proc p, aclexplode(p.proacl) as a
    where p.oid = 'public.zz_pp03_after_00001_fn()'::regprocedure and a.grantee = 0
  ),
  'R1-19: a function created in public after 00001 grants nothing to PUBLIC'
);
select ok(
  (select p.proacl is not null from pg_proc p where p.oid = 'public.zz_pp03_after_00001_fn()'::regprocedure),
  'R1-19: a function created after 00001 gets an explicit ACL, not the built-in PUBLIC default'
);
select ok(
  not has_function_privilege('anon', 'private.zz_pp03_after_00001_private_fn()', 'execute')
    and not has_function_privilege('authenticated', 'private.zz_pp03_after_00001_private_fn()', 'execute'),
  'R1-19: a function created in private after 00001 is not executable by anon or authenticated'
);

-- ---------------------------------------------------------------------------
-- Functions of 00001: location, search_path, and EXECUTE grants (R2-17): 12 tests
-- ---------------------------------------------------------------------------
select has_function('private', 'handle_updated_at', array[]::name[], 'handle_updated_at lives in schema private');
select hasnt_function('public', 'handle_updated_at', 'handle_updated_at does not exist in schema public');
select has_function('public', 'app_config_value_ok', array['text', 'jsonb'], 'public.app_config_value_ok(text, jsonb) exists');
select has_function('private', 'profile_display_name_ok', array['text'], 'private.profile_display_name_ok(text) exists');
select has_function('private', 'profile_avatar_url_ok', array['text'], 'private.profile_avatar_url_ok(text) exists');

select is_empty(
  $$
    select p.oid::regprocedure::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and not exists (
        select 1 from pg_depend d
        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
      )
      and not coalesce(p.proconfig @> array['search_path=""'], false)
  $$,
  'R2-17: every function in public and private sets search_path to the empty string'
);
select is(
  (
    select count(*)::integer
    from pg_proc p
    where p.oid in (
      'private.handle_updated_at()'::regprocedure,
      'public.app_config_value_ok(text, jsonb)'::regprocedure,
      'private.profile_display_name_ok(text)'::regprocedure,
      'private.profile_avatar_url_ok(text)'::regprocedure
    )
      and p.proconfig @> array['search_path=""']
      and not p.prosecdef
  ),
  4,
  'R2-17: the four functions of 00001 set search_path to the empty string and are SECURITY INVOKER'
);

select ok(
  not has_function_privilege('anon', 'public.app_config_value_ok(text, jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.app_config_value_ok(text, jsonb)', 'execute'),
  'app_config_value_ok is not executable by anon or authenticated'
);
select ok(
  has_function_privilege('service_role', 'public.app_config_value_ok(text, jsonb)', 'execute'),
  'app_config_value_ok is executable by service_role, which writes app_config'
);
select ok(
  not has_function_privilege('anon', 'private.handle_updated_at()', 'execute')
    and not has_function_privilege('authenticated', 'private.handle_updated_at()', 'execute'),
  'handle_updated_at is not executable by anon or authenticated'
);
select ok(
  not has_function_privilege('anon', 'private.profile_display_name_ok(text)', 'execute')
    and not has_function_privilege('authenticated', 'private.profile_display_name_ok(text)', 'execute')
    and not has_function_privilege('anon', 'private.profile_avatar_url_ok(text)', 'execute')
    and not has_function_privilege('authenticated', 'private.profile_avatar_url_ok(text)', 'execute'),
  'the profile validators are not executable by anon or authenticated'
);
select ok(
  has_function_privilege('service_role', 'private.profile_display_name_ok(text)', 'execute')
    and has_function_privilege('service_role', 'private.profile_avatar_url_ok(text)', 'execute'),
  'the profile validators are executable by service_role, which updates profiles'
);

-- ---------------------------------------------------------------------------
-- app_config seed (CH-1, R2-01, R2-S1): 2 tests
-- ---------------------------------------------------------------------------
select results_eq(
  $$
    select key, value
    from public.app_config
    where key in (
      'kill_switch', 'attempts_enabled', 'hardening_enabled',
      'starting_balance_cents', 'attempt_price_cents', 'repair_price_cents',
      'treasury_seed_cents', 'admin_grant_max_cents', 'refund_budget_per_hour'
    )
    order by key
  $$,
  $$
    values
      ('admin_grant_max_cents'::text,  '10000'::jsonb),
      ('attempt_price_cents',          '100'),
      ('attempts_enabled',             'true'),
      ('hardening_enabled',            'true'),
      ('kill_switch',                  'false'),
      ('refund_budget_per_hour',       '3'),
      ('repair_price_cents',           '100'),
      ('starting_balance_cents',       '2000'),
      ('treasury_seed_cents',          '0')
  $$,
  'app_config is seeded with the nine CH-1 and R2-01 defaults'
);
select is_empty(
  $$ select 1 from public.app_config where key = 'presence_mode' $$,
  'R2-S1: app_config has no presence_mode key'
);

-- ---------------------------------------------------------------------------
-- app_config_value_ok (CH-1, R2-01, R2-S1): 31 tests
-- ---------------------------------------------------------------------------
-- The four cases named in the acceptance criteria.
select is(public.app_config_value_ok('attempt_price_cents', '0'), false, 'rejects an attempt price of 0');
select is(public.app_config_value_ok('refund_budget_per_hour', '21'), false, 'rejects a refund budget of 21');
select is(public.app_config_value_ok('presence_mode', '"heartbeat"'), false, 'rejects the removed key presence_mode');
select is(public.app_config_value_ok('unknown_key', '1'), false, 'rejects an unknown key');

-- Bounds.
select is(public.app_config_value_ok('attempt_price_cents', '1'), true, 'accepts an attempt price of 1');
select is(public.app_config_value_ok('attempt_price_cents', '10000'), true, 'accepts an attempt price of 10000');
select is(public.app_config_value_ok('attempt_price_cents', '10001'), false, 'rejects an attempt price of 10001');
select is(public.app_config_value_ok('repair_price_cents', '0'), false, 'rejects a repair price of 0');
select is(public.app_config_value_ok('refund_budget_per_hour', '0'), true, 'accepts a refund budget of 0');
select is(public.app_config_value_ok('refund_budget_per_hour', '20'), true, 'accepts a refund budget of 20');
select is(public.app_config_value_ok('starting_balance_cents', '0'), true, 'accepts a starting balance of 0');
select is(public.app_config_value_ok('starting_balance_cents', '100001'), false, 'rejects a starting balance of 100001');
select is(public.app_config_value_ok('starting_balance_cents', '-1'), false, 'rejects a negative starting balance');
select is(public.app_config_value_ok('treasury_seed_cents', '1000000'), true, 'accepts a treasury seed of 1000000');
select is(public.app_config_value_ok('treasury_seed_cents', '1000001'), false, 'rejects a treasury seed of 1000001');
select is(public.app_config_value_ok('admin_grant_max_cents', '0'), false, 'rejects an admin grant maximum of 0');
select is(public.app_config_value_ok('admin_grant_max_cents', '100000'), true, 'accepts an admin grant maximum of 100000');

-- Types and shapes. None of these raises; each returns false.
select is(public.app_config_value_ok('attempt_price_cents', '1.5'), false, 'rejects a fractional price');
select is(public.app_config_value_ok('attempt_price_cents', '100.0'), false, 'rejects a non-canonical integer such as 100.0');
select is(public.app_config_value_ok('attempt_price_cents', '"100"'), false, 'rejects a price given as a string');
select is(public.app_config_value_ok('attempt_price_cents', 'true'), false, 'rejects a price given as a boolean');
select is(public.app_config_value_ok('attempt_price_cents', '1e30'), false, 'rejects a price too large for bigint without raising');
select is(public.app_config_value_ok('attempt_price_cents', 'null'), false, 'rejects a JSON null price');
select is(public.app_config_value_ok('attempt_price_cents', null), false, 'rejects a SQL NULL value');
select is(public.app_config_value_ok(null, '1'), false, 'rejects a NULL key');
select is(public.app_config_value_ok('kill_switch', 'true'), true, 'accepts a boolean kill switch');
select is(public.app_config_value_ok('kill_switch', '1'), false, 'rejects a numeric kill switch');
select is(public.app_config_value_ok('attempts_enabled', '"true"'), false, 'rejects a switch given as a string');

-- The CHECK constraints use the function and the key format.
select throws_ok(
  $$ insert into public.app_config (key, value) values ('presence_mode', '"heartbeat"') $$,
  '23514', null,
  'inserting presence_mode violates app_config_value_valid'
);
select throws_ok(
  $$ update public.app_config set value = '0' where key = 'attempt_price_cents' $$,
  '23514', null,
  'setting the attempt price to 0 violates app_config_value_valid'
);
select throws_ok(
  $$ insert into public.app_config (key, value) values ('Bad-Key', 'true') $$,
  '23514', null,
  'a key outside ^[a-z][a-z0-9_]{1,63}$ violates app_config_key_format'
);

-- ---------------------------------------------------------------------------
-- profiles constraints (CH-3, R2-06): 27 tests
-- ---------------------------------------------------------------------------
select hasnt_column('public', 'profiles', 'email', 'profiles has no email column');

select throws_ok(
  $$ update public.profiles set display_name = 'bad' || chr(7) || 'name' where id = '00000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'display_name rejects a control character (BEL)'
);
select throws_ok(
  $$ update public.profiles set display_name = 'two' || chr(10) || 'lines' where id = '00000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'display_name rejects a newline'
);
select throws_ok(
  $$ update public.profiles set display_name = 'next' || chr(133) || 'line' where id = '00000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'display_name rejects a C1 control character (U+0085)'
);
select throws_ok(
  $$ update public.profiles set display_name = 'evil' || chr(8238) || 'gnp.exe' where id = '00000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'display_name rejects U+202E (right-to-left override)'
);
select throws_ok(
  $$ update public.profiles set display_name = 'zero' || chr(8203) || 'width' where id = '00000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'display_name rejects U+200B (zero-width space)'
);
select throws_ok(
  $$ update public.profiles set display_name = 'iso' || chr(8294) || 'late' where id = '00000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'display_name rejects U+2066 (left-to-right isolate)'
);
select throws_ok(
  $$ update public.profiles set display_name = chr(65279) || 'bom' where id = '00000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'display_name rejects U+FEFF (zero-width no-break space)'
);
select throws_ok(
  $$ update public.profiles set display_name = repeat('a', 33) where id = '00000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'display_name rejects 33 characters'
);
select throws_ok(
  $$ update public.profiles set display_name = '' where id = '00000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'display_name rejects the empty string'
);
select lives_ok(
  $$ update public.profiles set display_name = repeat('a', 32) where id = '00000000-0000-4000-8000-00000000000a' $$,
  'display_name accepts 32 characters'
);
select lives_ok(
  $$ update public.profiles set display_name = 'Zoë Ōkubo 李' where id = '00000000-0000-4000-8000-00000000000a' $$,
  'display_name accepts ordinary non-ASCII letters'
);

select throws_ok(
  $$ update public.profiles set avatar_url = 'https://example.com/a/ACg8ocK=s96-c' where id = '00000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'avatar_url rejects another host'
);
select throws_ok(
  $$ update public.profiles set avatar_url = 'https://lh3.googleusercontent.com.evil.example/a/ACg8ocK=s96-c' where id = '00000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'avatar_url rejects a host that only starts with lh3.googleusercontent.com'
);
select throws_ok(
  $$ update public.profiles set avatar_url = 'https://lh3.googleusercontent.com@evil.example/a/ACg8ocK' where id = '00000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'avatar_url rejects a userinfo trick'
);
select throws_ok(
  $$ update public.profiles set avatar_url = 'https://lh4.googleusercontent.com/a/ACg8ocK=s96-c' where id = '00000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'avatar_url rejects another googleusercontent.com host'
);
select throws_ok(
  $$ update public.profiles set avatar_url = 'http://lh3.googleusercontent.com/a/ACg8ocK=s96-c' where id = '00000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'avatar_url rejects plain http'
);
select throws_ok(
  $$ update public.profiles set avatar_url = 'https://lh3.googleusercontent.com/b/ACg8ocK=s96-c' where id = '00000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'avatar_url rejects a path outside /a/ and /a-/'
);
select throws_ok(
  $$ update public.profiles set avatar_url = 'https://lh3.googleusercontent.com/a/../user-content/x' where id = '00000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'avatar_url rejects a .. segment that would leave the account-photo path'
);
select throws_ok(
  $$ update public.profiles set avatar_url = 'https://lh3.googleusercontent.com/a/%2e%2e/user-content/x' where id = '00000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'avatar_url rejects a percent-encoded .. segment'
);
select throws_ok(
  $$ update public.profiles set avatar_url = 'https://lh3.googleusercontent.com/a/ACg8ocK?sz=96' where id = '00000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'avatar_url rejects a query string'
);
select throws_ok(
  $$ update public.profiles set avatar_url = 'https://lh3.googleusercontent.com/a/' where id = '00000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'avatar_url rejects an empty account-photo path'
);
select throws_ok(
  $$ update public.profiles set avatar_url = 'https://lh3.googleusercontent.com/a/' || repeat('x', 480) where id = '00000000-0000-4000-8000-00000000000a' $$,
  '23514', null, 'avatar_url rejects more than 512 characters'
);
select lives_ok(
  $$ update public.profiles set avatar_url = 'https://lh3.googleusercontent.com/a/ACg8ocK_x-Y1abc=s96-c' where id = '00000000-0000-4000-8000-00000000000a' $$,
  'avatar_url accepts a /a/ account photo'
);
select lives_ok(
  $$ update public.profiles set avatar_url = 'https://lh3.googleusercontent.com/a-/AOh14Gh_x-Y1abc=s96-c' where id = '00000000-0000-4000-8000-00000000000a' $$,
  'avatar_url accepts a legacy /a-/ account photo'
);
select lives_ok(
  $$ update public.profiles set avatar_url = null where id = '00000000-0000-4000-8000-00000000000a' $$,
  'avatar_url accepts null (the UI shows initials)'
);

-- handle_updated_at stamps updated_at on every UPDATE, even when the caller
-- tries to set it.
update public.profiles
set updated_at = '2000-01-01T00:00:00Z', live_hidden = false
where id = '00000000-0000-4000-8000-00000000000a';
select is(
  (select updated_at from public.profiles where id = '00000000-0000-4000-8000-00000000000a'),
  now(),
  'the profiles_updated_at trigger sets updated_at to now()'
);

-- ---------------------------------------------------------------------------
-- RLS as user A, user B, and anonymous callers: 13 tests
-- ---------------------------------------------------------------------------
select set_config(
  'request.jwt.claims',
  '{"sub": "00000000-0000-4000-8000-00000000000a", "role": "authenticated"}',
  true
);
set local role authenticated;

select results_eq(
  $$ select id from public.profiles $$,
  $$ values ('00000000-0000-4000-8000-00000000000a'::uuid) $$,
  'as user A, profiles returns only A''s row'
);
select is_empty(
  $$ select 1 from public.profiles where id = '00000000-0000-4000-8000-00000000000b' $$,
  'as user A, B''s profile is invisible'
);
select throws_ok(
  $$ update public.profiles set display_name = 'Renamed' where id = '00000000-0000-4000-8000-00000000000a' $$,
  '42501', null, 'as user A, updating A''s own profile is denied'
);
select throws_ok(
  $$ insert into public.profiles (id, display_name) values ('00000000-0000-4000-8000-00000000000a', 'Dup') $$,
  '42501', null, 'as user A, inserting a profile is denied'
);
select throws_ok(
  $$ delete from public.profiles $$,
  '42501', null, 'as user A, deleting profiles is denied'
);
select throws_ok(
  $$ select * from public.app_config $$,
  '42501', null, 'as user A, reading app_config is denied'
);
select throws_ok(
  $$ select public.app_config_value_ok('kill_switch', 'true') $$,
  '42501', null, 'as user A, calling app_config_value_ok is denied'
);
select throws_ok(
  $$ select private.profile_display_name_ok('x') $$,
  '42501', null, 'as user A, schema private cannot be used'
);

select set_config(
  'request.jwt.claims',
  '{"sub": "00000000-0000-4000-8000-00000000000b", "role": "authenticated"}',
  true
);
select results_eq(
  $$ select id from public.profiles $$,
  $$ values ('00000000-0000-4000-8000-00000000000b'::uuid) $$,
  'as user B, profiles returns only B''s row'
);

select set_config('request.jwt.claims', '{"role": "authenticated"}', true);
select is_empty(
  $$ select 1 from public.profiles $$,
  'an authenticated token without a sub sees no profiles'
);

reset role;
select set_config('request.jwt.claims', '{"role": "anon"}', true);
set local role anon;

select throws_ok(
  $$ select * from public.profiles $$,
  '42501', null, 'anon cannot read profiles'
);
select throws_ok(
  $$ select * from public.app_config $$,
  '42501', null, 'anon cannot read app_config'
);
select throws_ok(
  $$ select public.app_config_value_ok('kill_switch', 'true') $$,
  '42501', null, 'anon cannot call app_config_value_ok'
);

reset role;

-- ---------------------------------------------------------------------------
-- The service role writes through the CHECK functions: 3 tests
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"role": "service_role"}', true);
set local role service_role;

select lives_ok(
  $$ update public.app_config set value = '150' where key = 'attempt_price_cents' $$,
  'service_role can update app_config through app_config_value_ok'
);
select lives_ok(
  $$ update public.profiles set live_hidden = true where id = '00000000-0000-4000-8000-00000000000b' $$,
  'service_role can update profiles through the profile validators'
);
select results_eq(
  $$ select count(*)::integer from public.profiles where id in ('00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b') $$,
  $$ values (2) $$,
  'service_role reads every profile'
);

reset role;

select * from finish();
rollback;
