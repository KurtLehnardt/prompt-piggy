-- pgTAP tests for supabase/migrations/00004_game_ledger.sql (task PP-12).
--
-- Run with `pnpm db:test` against the local stack after `pnpm db:reset`.
-- Everything runs in one transaction that is rolled back, so nothing here
-- persists. Every address and profile below is synthetic test data.
--
-- Users are inserted into auth.users as postgres, which fires the sign-up
-- trigger exactly as GoTrue's insert does. Service-role functions are called
-- after `set local role service_role`, so the tests also prove their grants.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(159);

-- ---------------------------------------------------------------------------
-- Helpers and fixtures
-- ---------------------------------------------------------------------------

-- Every table privilege the role holds, sorted. NULL means none. MAINTAIN is
-- included on PostgreSQL 17 and later.
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

-- Runs a statement and returns 'SQLSTATE token', where the token is the
-- first word of the error message, or 'ok' when it does not raise.
create function pg_temp.raises(p_sql text)
returns text
language plpgsql
as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ' ' || split_part(sqlerrm, ':', 1);
end
$$;

-- Runs a statement and returns its SQLSTATE, or 'ok' when it does not raise.
create function pg_temp.sqlstate_of(p_sql text)
returns text
language plpgsql
as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end
$$;

-- Inserts a synthetic attempt as postgres and returns its id.
create function pg_temp.add_attempt(p_user uuid, p_outcome text, p_epoch bigint default 1)
returns uuid
language sql
as $$
  insert into public.attempts (
    user_id, level_id, pig_epoch, rule_set_id, idempotency_key, prompt, prompt_sha256,
    prompt_fingerprint, prompt_chars, outcome, error_code, price_cents, spend_day, finalized_at
  ) values (
    p_user, 1, p_epoch,
    (select rs.id from public.rule_sets as rs where rs.level_id = 1 and rs.state = 'active'),
    gen_random_uuid(), 'synthetic test prompt',
    md5(random()::text) || md5(random()::text),
    md5(random()::text) || md5(random()::text),
    21, p_outcome::public.attempt_outcome,
    case when p_outcome = 'error' then 'upstream_error' end,
    100, current_date,
    case when p_outcome <> 'pending' then now() end
  )
  returning id;
$$;

-- A valid rule set: the given flags true, the others false.
create function pg_temp.rules(p_on text[] default '{}')
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('schema_version', 1, 'block_keywords', '[]'::jsonb)
      || (select jsonb_object_agg(f, f = any(p_on))
          from unnest(array[
            'reject_roleplay_archetypes', 'reject_authority_claims', 'reject_instruction_override',
            'reject_delimiter_tokens', 'reject_encoded_payloads', 'reject_tool_invocation_language',
            'reject_deferred_instructions', 'reject_mixed_script_obfuscation', 'reject_hypothetical_framing'
          ]) as f);
$$;

-- pg_temp functions are created by postgres, and 00001 revoked the default
-- EXECUTE for functions that postgres creates.
grant execute on function pg_temp.raises(text) to anon, authenticated, service_role;
grant execute on function pg_temp.sqlstate_of(text) to anon, authenticated, service_role;
grant execute on function pg_temp.rules(text[]) to service_role;

-- Named ids used across sections; readable by every role in the tests.
create temporary table t_ids (name text primary key, id uuid not null) on commit drop;
grant select on t_ids to anon, authenticated, service_role;

insert into t_ids (name, id) values
  ('A', '00000000-0000-4000-8000-0000000012a1'),   -- google: full_name and avatar_url
  ('B', '00000000-0000-4000-8000-0000000012b1'),   -- google: name and picture; name holds U+202E
  ('C', '00000000-0000-4000-8000-0000000012c1'),   -- email provider
  ('D', '00000000-0000-4000-8000-0000000012d1'),   -- google: control character; avatar on another host
  ('E', '00000000-0000-4000-8000-0000000012e1'),   -- google: invisible-only name; avatar outside /a/
  ('F', '00000000-0000-4000-8000-0000000012f1'),   -- anonymous
  ('G', '00000000-0000-4000-8000-000000001201'),   -- google: fuzz name (R3-12)
  ('H', '00000000-0000-4000-8000-000000001202'),   -- google: blank full_name, name present
  ('R', '00000000-0000-4000-8000-000000001203'),   -- deleted and re-created with the same id
  ('W', '00000000-0000-4000-8000-000000001204'),   -- deleted while holding a breach fingerprint
  ('M1', '00000000-0000-4000-8000-000000001211'),  -- aura and crack fixtures (balances set directly)
  ('M2', '00000000-0000-4000-8000-000000001212'),
  ('M3', '00000000-0000-4000-8000-000000001213'),
  ('P', '00000000-0000-4000-8000-000000001221'),   -- created before 00004: backfilled
  ('P2', '00000000-0000-4000-8000-000000001222'),  -- created before 00004 with a bad Google profile
  ('P3', '00000000-0000-4000-8000-000000001223');  -- created before 00004, anonymous

create function pg_temp.uid(p_name text)
returns uuid
language sql
stable
as $$ select id from t_ids where name = p_name $$;
grant execute on function pg_temp.uid(text) to anon, authenticated, service_role;

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, is_anonymous)
values
  (pg_temp.uid('A'), 'authenticated', 'authenticated', 'pp12-a@example.test',
   '{"provider": "google", "providers": ["google"]}',
   '{"full_name": "Alice Example", "name": "Alice", "avatar_url": "https://lh3.googleusercontent.com/a/ACg8ocJ_pp12-alice=s96-c"}', false),
  (pg_temp.uid('B'), 'authenticated', 'authenticated', 'pp12-b@example.test',
   '{"provider": "google"}',
   jsonb_build_object('name', E'Bob‮evil', 'picture', 'https://lh3.googleusercontent.com/a-/AOh14Gpp12bob=s96-c'), false),
  (pg_temp.uid('C'), 'authenticated', 'authenticated', 'pp12-c@example.test',
   '{"provider": "email"}',
   '{"full_name": "Carol Email", "avatar_url": "https://lh3.googleusercontent.com/a/ACg8ocJ_pp12-carol=s96-c"}', false),
  (pg_temp.uid('D'), 'authenticated', 'authenticated', 'pp12-d@example.test',
   '{"provider": "google"}',
   jsonb_build_object('full_name', E'Dan\u0007ny', 'avatar_url', 'https://evil.example.com/a/photo.png'), false),
  (pg_temp.uid('E'), 'authenticated', 'authenticated', 'pp12-e@example.test',
   '{"provider": "google"}',
   jsonb_build_object('full_name', E'‮​⁦', 'avatar_url', 'https://lh3.googleusercontent.com/proxy/abc123'), false),
  (pg_temp.uid('F'), 'authenticated', 'authenticated', null,
   '{"provider": "anonymous"}', '{}', true),
  (pg_temp.uid('G'), 'authenticated', 'authenticated', 'pp12-g@example.test',
   '{"provider": "google"}',
   jsonb_build_object('full_name',
     E'Zo­e Line\u0085Next؜ \U0001F600 \U0001F468‍\U0001F469 ' || repeat('x', 40)), false),
  (pg_temp.uid('H'), 'authenticated', 'authenticated', 'pp12-h@example.test',
   '{"provider": "google"}',
   '{"full_name": "   ", "name": "Hank"}', false),
  (pg_temp.uid('R'), 'authenticated', 'authenticated', 'pp12-r@example.test', '{"provider": "google"}', '{"name": "Rita"}', false),
  (pg_temp.uid('W'), 'authenticated', 'authenticated', 'pp12-w@example.test', '{"provider": "google"}', '{"name": "Wes"}', false),
  (pg_temp.uid('M1'), 'authenticated', 'authenticated', 'pp12-m1@example.test', '{"provider": "email"}', '{}', false),
  (pg_temp.uid('M2'), 'authenticated', 'authenticated', 'pp12-m2@example.test', '{"provider": "email"}', '{}', false),
  (pg_temp.uid('M3'), 'authenticated', 'authenticated', 'pp12-m3@example.test', '{"provider": "email"}', '{}', false);

-- ---------------------------------------------------------------------------
-- Sign-up: the profile, the wallet, and the one-time grant (CH-1, CH-3,
-- R2-06, R2-16, R3-12): 20 tests
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select display_name, avatar_url from public.profiles where id = pg_temp.uid('A') $$,
  $$ values ('Alice Example'::text, 'https://lh3.googleusercontent.com/a/ACg8ocJ_pp12-alice=s96-c'::text) $$,
  'CH-3: a Google sign-up copies full_name and avatar_url into the profile'
);
select is(
  (select balance_cents from public.wallets where user_id = pg_temp.uid('A')),
  (select value::text::bigint from public.app_config where key = 'starting_balance_cents'),
  'CH-1: the new wallet holds app_config starting_balance_cents'
);
select is(
  (select balance_cents from public.wallets where user_id = pg_temp.uid('A')), 2000::bigint,
  'CH-1: the starting balance is 2000 cents ($20)'
);
select results_eq(
  $$ select kind, from_account, to_account, amount_cents, user_id
     from public.ledger_entries where external_ref = 'start:' || pg_temp.uid('A')::text $$,
  $$ values ('mint_starting'::text, 'mint'::text, 'player:' || pg_temp.uid('A')::text, 2000::bigint, pg_temp.uid('A')) $$,
  'CH-1: exactly one mint_starting ledger row with external_ref start:<id> moves 2000 from mint to the player'
);
select is(
  (select count(*)::integer from public.ledger_entries where user_id = pg_temp.uid('A') and kind = 'mint_starting'),
  1, 'CH-1: the user has exactly one mint_starting row'
);
select results_eq(
  $$ select display_name, avatar_url from public.profiles where id = pg_temp.uid('B') $$,
  $$ values ('Bobevil'::text, 'https://lh3.googleusercontent.com/a-/AOh14Gpp12bob=s96-c'::text) $$,
  'R2-06: name and picture are used when full_name and avatar_url are absent, and U+202E is stripped'
);
select ok(
  (select display_name ~ '^Player [0-9]{4}$' and avatar_url is null from public.profiles where id = pg_temp.uid('C')),
  'R2-06: a non-Google provider gets Player and four digits and a null avatar, whatever its metadata says'
);
select is(
  (select balance_cents from public.wallets where user_id = pg_temp.uid('C')), 2000::bigint,
  'a non-Google user still gets a wallet and the starting grant'
);
select results_eq(
  $$ select display_name, avatar_url from public.profiles where id = pg_temp.uid('D') $$,
  $$ values ('Danny'::text, null::text) $$,
  'CH-3: control characters are stripped from the name, and an avatar on another host becomes null'
);
select ok(
  (select display_name ~ '^Player [0-9]{4}$' and avatar_url is null from public.profiles where id = pg_temp.uid('E')),
  'a name of only invisible characters falls back to Player and four digits; an avatar outside the account-photo paths becomes null'
);
select ok(
  (select private.profile_display_name_ok(display_name)
          and char_length(display_name) <= 32
          and display_name !~ E'[­ \u0085؜‍]'
          and display_name like 'Zoe Line Next %'
   from public.profiles where id = pg_temp.uid('G')),
  'R3-12: a name with U+00AD, U+2028, U+0085, U+061C, a ZWJ emoji, and more than 32 characters is cleaned, truncated, and passes the CHECK'
);
select is(
  (select display_name from public.profiles where id = pg_temp.uid('H')), 'Hank',
  'a blank full_name falls back to name'
);
select ok(
  not exists (select 1 from public.profiles where id = pg_temp.uid('F'))
  and not exists (select 1 from public.wallets where user_id = pg_temp.uid('F'))
  and not exists (select 1 from public.ledger_entries
                  where user_id = pg_temp.uid('F') or to_account = 'player:' || pg_temp.uid('F')::text),
  'R2-16: an anonymous auth.users row creates no profile, no wallet, and no ledger row'
);

-- What supabase.auth.updateUser({ data }) does: profiles must not change.
update auth.users
set raw_user_meta_data = '{"full_name": "Mallory Renamed", "avatar_url": "https://evil.example.com/a/x.png", "picture": "https://evil.example.com/p.png"}'
where id = pg_temp.uid('A');
select results_eq(
  $$ select display_name, avatar_url from public.profiles where id = pg_temp.uid('A') $$,
  $$ values ('Alice Example'::text, 'https://lh3.googleusercontent.com/a/ACg8ocJ_pp12-alice=s96-c'::text) $$,
  'R2-06: an UPDATE of raw_user_meta_data leaves the profile unchanged'
);
select results_eq(
  $$ select tgname::text collate "default", tgtype::integer, tgfoid::regproc::text collate "default"
     from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal $$,
  $$ values ('on_auth_user_created'::text, 5, 'private.handle_new_user'::text) $$,
  'R2-06: the only trigger on auth.users is the AFTER INSERT FOR EACH ROW sign-up trigger'
);

-- Re-firing the grant path: the same id signs up again after a delete. The
-- journal outlives the wallet, so start:<id> already exists.
delete from auth.users where id = pg_temp.uid('R');
insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
values (pg_temp.uid('R'), 'authenticated', 'authenticated', 'pp12-r@example.test', '{"provider": "google"}', '{"name": "Rita"}');
select is(
  (select count(*)::integer from public.ledger_entries where external_ref = 'start:' || pg_temp.uid('R')::text),
  1, 'CH-1: re-firing the sign-up path never mints a second starting grant'
);
select is(
  (select balance_cents from public.wallets where user_id = pg_temp.uid('R')), 0::bigint,
  'CH-1: the re-created wallet receives no second grant'
);

set local role service_role;
select is(
  pg_temp.sqlstate_of(format(
    $$ select private._post_ledger('mint_starting', 'mint', 'player:%s', 2000, %L, null, 'start:%s') $$,
    pg_temp.uid('A'), pg_temp.uid('A'), pg_temp.uid('A'))),
  '23505', 'CH-1: posting a second start:<id> row fails on the unique external_ref'
);
reset role;

select ok(
  private._sanitize_display_name(E'  Ann \t\n  Lee  ') = 'Ann Lee'
  and private._sanitize_display_name(repeat('y', 50)) = repeat('y', 32)
  and private._sanitize_display_name(null) ~ '^Player [0-9]{4}$'
  and private._sanitize_display_name('') ~ '^Player [0-9]{4}$',
  'the name sanitizer collapses whitespace, truncates to 32, and falls back for null or empty input'
);
select ok(
  private._sanitize_avatar_url('https://lh3.googleusercontent.com/a/ok_photo=s96-c') = 'https://lh3.googleusercontent.com/a/ok_photo=s96-c'
  and private._sanitize_avatar_url('http://lh3.googleusercontent.com/a/ok') is null
  and private._sanitize_avatar_url('https://lh3.googleusercontent.com/a/../../evil') is null
  and private._sanitize_avatar_url('https://lh3.googleusercontent.com/a/x%2F..%2Fevil') is null
  and private._sanitize_avatar_url('https://lh3.googleusercontent.com/a/x?u=1') is null
  and private._sanitize_avatar_url('https://lh3.googleusercontent.com.evil.example/a/x') is null
  and private._sanitize_avatar_url('https://lh3.googleusercontent.com/a/' || repeat('z', 600)) is null
  and private._sanitize_avatar_url(null) is null,
  'the avatar sanitizer keeps only Google account-photo URLs of at most 512 characters'
);

-- ---------------------------------------------------------------------------
-- Wallets: generated aura and the crack range (CH-1, CH-2): 7 tests
-- ---------------------------------------------------------------------------
update public.wallets set balance_cents = 0, total_donated_cents = 0   where user_id = pg_temp.uid('M1');
update public.wallets set balance_cents = 0, total_donated_cents = 500 where user_id = pg_temp.uid('M2');
update public.wallets set balance_cents = 700, total_donated_cents = 700 where user_id = pg_temp.uid('M3');

select is((select aura_bps from public.wallets where user_id = pg_temp.uid('M1')), 0, 'CH-2: aura is 0 when donated and balance are both 0');
select is((select aura_bps from public.wallets where user_id = pg_temp.uid('M2')), 10000, 'CH-2: aura is 10000 when the balance is 0 and donated > 0');
select is((select aura_bps from public.wallets where user_id = pg_temp.uid('M3')), 5000, 'CH-2: aura is 5000 for equal amounts');
select is(
  pg_temp.sqlstate_of(format($$ update public.wallets set aura_bps = 9999 where user_id = %L $$, pg_temp.uid('M3'))),
  '428C9', 'CH-2: an UPDATE that sets aura_bps fails (generated column)'
);
select is(
  pg_temp.sqlstate_of(format($$ update public.wallets set crack_count = 4 where user_id = %L $$, pg_temp.uid('M1'))),
  '23514', 'CH-1: crack_count rejects 4'
);
select is(
  pg_temp.sqlstate_of(format($$ update public.wallets set crack_count = -1 where user_id = %L $$, pg_temp.uid('M1'))),
  '23514', 'CH-1: crack_count rejects -1'
);
select is(
  pg_temp.sqlstate_of(format($$ update public.wallets set balance_cents = -1 where user_id = %L $$, pg_temp.uid('M1'))),
  '23514', 'T28: a negative balance is rejected'
);

-- ---------------------------------------------------------------------------
-- game_state and attempts (CH-1): 7 tests
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select id::integer, current_level::integer, pig_epoch, treasury_cents from public.game_state $$,
  $$ select 1, 1, 1::bigint, (select value::text::bigint from public.app_config where key = 'treasury_seed_cents') $$,
  'CH-1: game_state is one row seeded at level 1, epoch 1, and treasury_seed_cents'
);
select is(
  pg_temp.sqlstate_of($$ insert into public.game_state (id) values (2) $$),
  '23514', 'CH-1: game_state is a singleton (id = 1 only)'
);

insert into t_ids (name, id) values ('A_fail', pg_temp.add_attempt(pg_temp.uid('A'), 'fail'));
insert into t_ids (name, id) values ('A_win', pg_temp.add_attempt(pg_temp.uid('A'), 'win', 1));
insert into t_ids (name, id) values ('B_blocked', pg_temp.add_attempt(pg_temp.uid('B'), 'blocked'));
select is(
  pg_temp.sqlstate_of(format($$ select pg_temp.add_attempt(%L, 'win', 1) $$, pg_temp.uid('B'))),
  '23505', 'CH-1, T28: the unique index allows at most one win per pig_epoch'
);
select is(
  pg_temp.sqlstate_of(format($$ select pg_temp.add_attempt(%L, 'win', 2) $$, pg_temp.uid('B'))),
  'ok', 'a win for another epoch is allowed'
);
select is(
  pg_temp.sqlstate_of(format($$ select pg_temp.add_attempt(%L, 'late_win', 1) $$, pg_temp.uid('B'))),
  'ok', 'a late_win for an epoch that already has a win is allowed'
);
select is(
  pg_temp.sqlstate_of(format(
    $$ update public.attempts set outcome = 'error', error_code = null where id = %L $$, (select id from t_ids where name = 'A_fail'))),
  '23514', 'an error outcome needs an error code'
);
select is(
  pg_temp.sqlstate_of(format(
    $$ update public.attempts set outcome = 'pending' where id = %L $$, (select id from t_ids where name = 'A_fail'))),
  '23514', 'a pending attempt cannot carry finalized_at'
);

insert into public.donations (user_id, amount_cents, idempotency_key)
values (pg_temp.uid('A'), 100, gen_random_uuid()), (pg_temp.uid('B'), 200, gen_random_uuid());

-- ---------------------------------------------------------------------------
-- RLS as user A and as anon (T11): 30 tests
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', format('{"sub": "%s", "role": "authenticated"}', pg_temp.uid('A')), true);
set local role authenticated;

select results_eq($$ select id from public.profiles $$, $$ select pg_temp.uid('A') $$,
  'RLS: as A, profiles returns only A''s row');
select results_eq($$ select user_id from public.wallets $$, $$ select pg_temp.uid('A') $$,
  'RLS: as A, wallets returns only A''s row');
select results_eq(
  $$ select id from public.attempts order by id $$,
  $$ select id from t_ids where name in ('A_fail', 'A_win') order by id $$,
  'RLS: as A, attempts returns only A''s rows'
);
select results_eq($$ select amount_cents from public.donations $$, $$ values (100::bigint) $$,
  'RLS: as A, donations returns only A''s rows');
select ok(
  (select count(*) > 0 and bool_and(user_id = pg_temp.uid('A')) from public.ledger_entries),
  'RLS: as A, ledger_entries returns only A''s rows'
);
select is_empty(
  $$ select 1 from public.wallets where user_id = pg_temp.uid('B')
     union all select 1 from public.attempts where id = (select id from t_ids where name = 'B_blocked')
     union all select 1 from public.ledger_entries where user_id = pg_temp.uid('B') $$,
  'RLS: as A, none of B''s wallet, attempts, or ledger rows is visible'
);
select results_eq(
  $$ select refund_withheld, outcome::text, cracks_after from public.attempts where id = (select id from t_ids where name = 'A_fail') $$,
  $$ values (false, 'fail'::text, null::smallint) $$,
  'column grant: the owner reads refund_withheld, outcome, and cracks_after'
);
select throws_ok($$ select rule_set_id from public.attempts $$, '42501', null,
  'column grant: attempts.rule_set_id is not readable as authenticated');
select throws_ok($$ select prompt_fingerprint from public.attempts $$, '42501', null,
  'column grant: attempts.prompt_fingerprint is not readable as authenticated');
select throws_ok($$ select validator_reasons from public.attempts $$, '42501', null,
  'column grant: attempts.validator_reasons is not readable as authenticated');
select throws_ok($$ select tripwire_probability from public.attempts $$, '42501', null,
  'column grant: attempts.tripwire_probability is not readable as authenticated');
select throws_ok($$ select cost_micros from public.attempts $$, '42501', null,
  'column grant: attempts.cost_micros is not readable as authenticated');
select throws_ok(
  format($$ update public.wallets set crack_count = 0, balance_cents = 999999 where user_id = %L $$, pg_temp.uid('A')),
  '42501', null, 'HC-A5: as A, updating the own wallet (cracks or balance) is denied');
select throws_ok($$ update public.game_state set treasury_cents = 0 $$, '42501', null,
  'HC-A5: as A, updating game_state is denied');
select throws_ok(
  format($$ insert into public.ledger_entries (kind, from_account, to_account, amount_cents, user_id)
            values ('admin_grant', 'mint', 'player:%s', 100, %L) $$, pg_temp.uid('A'), pg_temp.uid('A')),
  '42501', null, 'T11: as A, inserting a ledger row is denied');
select throws_ok($$ delete from public.attempts $$, '42501', null, 'T11: as A, deleting attempts is denied');
select throws_ok(
  format($$ select private._post_ledger('admin_grant', 'mint', 'player:%s', 100, %L, null, null) $$, pg_temp.uid('A'), pg_temp.uid('A')),
  '42501', null, 'R2-17: as A, private._post_ledger cannot be used');
select throws_ok(
  format($$ select * from public.presence_ping(%L) $$, pg_temp.uid('A')),
  '42501', null, 'T32: as A, presence_ping is not executable');
select throws_ok($$ select * from public.get_live_players() $$, '42501', null,
  'T32: as A, get_live_players is not executable');
select is((select count(*)::integer from public.get_level_status()), 5,
  'R2-07: authenticated can execute get_level_status');
select is((select count(*)::integer from public.get_public_config()), 1,
  'R2-07: authenticated can execute get_public_config');
select is((select count(*)::integer from public.game_state), 1, 'authenticated reads game_state');

reset role;
select set_config('request.jwt.claims', '{"role": "anon"}', true);
set local role anon;

select is((select count(*)::integer from public.game_state), 1, 'R2-07: anon reads game_state');
select lives_ok($$ select id, event_type, player_id from public.live_feed $$, 'R2-07: anon reads live_feed');
select is((select count(*)::integer from public.levels), 5, 'R2-07: anon reads levels');
select is(
  (select array_agg(t order by t) from unnest(array[
     pg_temp.sqlstate_of('select 1 from public.wallets'),
     pg_temp.sqlstate_of('select id from public.attempts'),
     pg_temp.sqlstate_of('select 1 from public.ledger_entries'),
     pg_temp.sqlstate_of('select 1 from public.donations'),
     pg_temp.sqlstate_of('select 1 from public.profiles'),
     pg_temp.sqlstate_of('select 1 from public.blocked_fingerprints'),
     pg_temp.sqlstate_of('select 1 from public.hardening_jobs')]) as t),
  array_fill('42501'::text, array[7]),
  'R2-07: anon reads none of wallets, attempts, ledger_entries, donations, profiles, blocked_fingerprints, hardening_jobs'
);
select is((select count(*)::integer from public.get_level_status()), 5, 'R2-07: anon can execute get_level_status');
select is((select count(*)::integer from public.get_public_config()), 1, 'R2-07: anon can execute get_public_config');
select throws_ok(
  format($$ select * from public.presence_ping(%L) $$, pg_temp.uid('A')),
  '42501', null, 'T32: anon cannot execute presence_ping');
select throws_ok($$ select * from public.get_live_players() $$, '42501', null,
  'T32: anon cannot execute get_live_players');

reset role;
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- Privileges, RLS, and policies in the catalog (T11, HC-A5): 10 tests
-- ---------------------------------------------------------------------------
create temporary table t_tables on commit drop as
  select unnest(array[
    'public.game_state', 'public.wallets', 'public.attempts', 'public.ledger_entries',
    'public.donations', 'public.live_feed', 'public.blocked_fingerprints', 'public.ai_spend',
    'public.rate_limits', 'public.hardening_jobs', 'public.admin_actions']) as table_name;

select is_empty(
  $$ select r.role_name || ' ' || t.table_name || ' ' || p.privilege
     from (values ('anon'), ('authenticated')) as r (role_name)
     cross join t_tables as t
     cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
       || case when current_setting('server_version_num')::integer >= 170000 then array['MAINTAIN'] else array[]::text[] end) as p (privilege)
     where has_table_privilege(r.role_name, t.table_name, p.privilege)
        or case when p.privilege in ('INSERT', 'UPDATE', 'REFERENCES')
                then has_any_column_privilege(r.role_name, t.table_name, p.privilege) else false end $$,
  'T11, HC-A5: anon and authenticated hold no INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, or MAINTAIN on any 00004 table'
);
select results_eq(
  $$ select c.relname::text collate "default" from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
       and has_any_column_privilege('anon', c.oid, 'SELECT')
     order by 1 $$,
  $$ values ('game_state'::text), ('levels'::text), ('live_feed'::text) $$,
  'R2-07: anon can select game_state, live_feed, and levels and nothing else'
);
select results_eq(
  $$ select c.relname::text collate "default" from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
       and has_any_column_privilege('authenticated', c.oid, 'SELECT')
     order by 1 $$,
  $$ values ('attempts'::text), ('donations'::text), ('game_state'::text), ('ledger_entries'::text),
            ('levels'::text), ('live_feed'::text), ('profiles'::text), ('wallets'::text) $$,
  'authenticated can select exactly the section 5.3 tables'
);
select is_empty(
  $$ select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'S'
       and (has_sequence_privilege('anon', c.oid, 'USAGE') or has_sequence_privilege('authenticated', c.oid, 'USAGE')
            or has_sequence_privilege('anon', c.oid, 'UPDATE') or has_sequence_privilege('authenticated', c.oid, 'UPDATE')) $$,
  'anon and authenticated hold no privilege on any sequence'
);
select results_eq(
  $$ select a.attname::text collate "default" from pg_attribute a
     where a.attrelid = 'public.attempts'::regclass and a.attnum > 0 and not a.attisdropped
       and has_column_privilege('authenticated', 'public.attempts', a.attname, 'SELECT')
     order by 1 $$,
  $$ select unnest(array['crack_event', 'cracks_after', 'created_at', 'finalized_at', 'id', 'level_id', 'outcome',
                         'payout_cents', 'price_cents', 'prompt', 'refund_cents', 'refund_withheld', 'reply', 'technique']) $$,
  'T11: the attempts column grant to authenticated is exactly the section 5.3 list'
);
select is(
  (select pg_temp.held_table_privileges('authenticated', 'public.attempts')), null::text[],
  'authenticated holds no table-level privilege on attempts (column grant only)'
);
select is(
  (select count(*)::integer from t_tables t join pg_class c on c.oid = t.table_name::regclass where c.relrowsecurity),
  11, 'RLS is enabled on every 00004 table'
);
select results_eq(
  $$ select polrelid::regclass::text collate "default", polname::text collate "default", polcmd::text collate "default", polpermissive,
            (select array_agg(r::regrole::text collate "default" order by r::regrole::text collate "default") from unnest(polroles) as r)
     from pg_policy
     where polrelid in (select table_name::regclass from t_tables)
     order by 1, 2 $$,
  $$ values
       ('attempts'::text, 'attempts: owner reads own rows'::text, 'r'::text, true, array['authenticated']),
       ('donations', 'donations: owner reads own rows', 'r', true, array['authenticated']),
       ('game_state', 'game_state: public read', 'r', true, array['anon', 'authenticated']),
       ('ledger_entries', 'ledger_entries: owner reads own rows', 'r', true, array['authenticated']),
       ('live_feed', 'live_feed: public read', 'r', true, array['anon', 'authenticated']),
       ('wallets', 'wallets: owner reads own row', 'r', true, array['authenticated']) $$,
  'section 5.3: 00004 has SELECT policies only, and blocked_fingerprints, ai_spend, rate_limits, hardening_jobs, and admin_actions have none'
);
select is_empty(
  $$ select polrelid::regclass::text || ' ' || polname from pg_policy p join pg_class c on c.oid = p.polrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and p.polpermissive and p.polcmd <> 'r' $$,
  'there is no permissive INSERT, UPDATE, DELETE, or ALL policy anywhere in public'
);
select ok(
  (select bool_and(pg_temp.held_table_privileges('service_role', t.table_name) @> array['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
   from t_tables as t)
  and has_sequence_privilege('service_role', 'public.ledger_entries_id_seq', 'USAGE')
  and has_sequence_privilege('service_role', 'public.donations_id_seq', 'USAGE')
  and has_sequence_privilege('service_role', 'public.live_feed_id_seq', 'USAGE')
  and has_sequence_privilege('service_role', 'public.admin_actions_id_seq', 'USAGE'),
  'H1: service_role holds explicit DML on every 00004 table and USAGE on every 00004 sequence'
);

-- ---------------------------------------------------------------------------
-- Functions: location, grants, search_path, and definer rights (R2-07,
-- R2-17, R2-30, T32): 13 tests
-- ---------------------------------------------------------------------------
create temporary table t_functions on commit drop as
  select unnest(array[
    'private._post_ledger(text, text, text, bigint, uuid, uuid, text)',
    'private._sanitize_display_name(text)',
    'private._sanitize_avatar_url(text)',
    'private.handle_new_user()',
    'private._provision_user(uuid, jsonb, jsonb, boolean)',
    'private._backfill_users()',
    'private.ledger_append_only()',
    'private.rule_set_activated_feed()',
    'public.get_level_status()',
    'public.get_public_config()',
    'public.get_live_players(integer, integer, text)',
    'public.presence_ping(uuid, integer, integer, text)']::regprocedure[]) as fn;

select hasnt_function('public', '_post_ledger', 'R2-17: _post_ledger does not exist in schema public');
select hasnt_function('public', 'handle_new_user', 'R2-17: handle_new_user does not exist in schema public');
select hasnt_function('public', '_sanitize_display_name', 'R2-17: the sanitizers do not exist in schema public');
select is(
  (select count(*)::integer from t_functions f join pg_proc p on p.oid = f.fn where p.proconfig @> array['search_path=""']),
  12, 'R2-17: every 00004 function sets search_path to the empty string'
);
select results_eq(
  $$ select f.fn::text collate "default" from t_functions f join pg_proc p on p.oid = f.fn where p.prosecdef order by 1 $$,
  $$ values ('get_level_status()'::text), ('get_public_config()'::text), ('private.handle_new_user()'::text) $$,
  'only handle_new_user, get_level_status, and get_public_config are SECURITY DEFINER; rule_set_activated_feed is SECURITY INVOKER (R2-30)'
);
select is_empty(
  $$ select r.role_name || ' ' || f.fn::text
     from (values ('anon'), ('authenticated')) as r (role_name)
     cross join t_functions as f
     where has_function_privilege(r.role_name, f.fn, 'EXECUTE')
       and f.fn not in ('public.get_level_status()'::regprocedure, 'public.get_public_config()'::regprocedure) $$,
  'R2-17, T32: anon and authenticated can execute no 00004 function except get_level_status and get_public_config'
);
select ok(
  has_function_privilege('anon', 'public.get_level_status()', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.get_level_status()', 'EXECUTE')
  and has_function_privilege('anon', 'public.get_public_config()', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.get_public_config()', 'EXECUTE'),
  'R2-07: get_level_status and get_public_config are executable by anon and authenticated'
);
select ok(
  has_function_privilege('service_role', 'private._post_ledger(text, text, text, bigint, uuid, uuid, text)', 'EXECUTE')
  and has_function_privilege('service_role', 'private._sanitize_display_name(text)', 'EXECUTE')
  and has_function_privilege('service_role', 'private._sanitize_avatar_url(text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.get_live_players(integer, integer, text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.presence_ping(uuid, integer, integer, text)', 'EXECUTE'),
  'R2-17: service_role can execute _post_ledger, the sanitizers, get_live_players, and presence_ping'
);
select results_eq(
  $$ select f.fn::text collate "default", pg_get_function_result(f.fn) collate "default" from t_functions f
     where f.fn::text like '%get_%' or f.fn::text like '%presence_ping%' order by 1 $$,
  $$ values
       ('get_level_status()'::text, 'TABLE(level_id smallint, name text, active_version integer, last_hardened_at timestamp with time zone)'::text),
       ('get_live_players(integer,integer,text)', 'TABLE(list_hash text, players jsonb)'),
       ('get_public_config()', 'TABLE(attempts_enabled boolean, attempt_price_cents bigint, repair_price_cents bigint)'),
       ('presence_ping(uuid,integer,integer,text)', 'TABLE(list_hash text, players jsonb)') $$,
  'R2-07, T32: the public read and wall functions return no email, balance, crack count, or presence mode column'
);

-- Schema qualification: with comments and string literals removed, no 00004
-- function body names a project table or function without its schema. The
-- behavioural proof is the rest of this file: every function ran here with
-- search_path set to the empty string.
create temporary table t_bodies on commit drop as
  select f.fn::text as fn,
         regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '''([^'']|'''')*''', '''''', 'g') as body
  from t_functions f join pg_proc p on p.oid = f.fn;
select is_empty(
  $$ select fn from t_bodies
     where body ~* '\m(from|join|into|update|table)\s+(game_state|wallets|attempts|ledger_entries|donations|live_feed|profiles|app_config|levels|rule_sets)\M' $$,
  'R2-17: every table reference in a 00004 function is schema-qualified'
);
select is_empty(
  $$ select fn from t_bodies
     where body ~* '(^|[^.[:alnum:]_])(_post_ledger|_sanitize_display_name|_sanitize_avatar_url|_provision_user|profile_display_name_ok|profile_avatar_url_ok|get_live_players)\s*\('
        or body ~* '::\s*(attempt_outcome|crack_event|rule_set_state|attack_technique)\M' $$,
  'R2-17: every call to a project function and every project type in a 00004 function is schema-qualified'
);
select ok(
  (select count(*) from t_bodies where body ~ 'public\.wallets') >= 3,
  'the scan sees the qualified references, so it is looking at the real bodies'
);
select results_eq(
  $$ select attempts_enabled, attempt_price_cents, repair_price_cents from public.get_public_config() $$,
  $$ values (true, 100::bigint, 100::bigint) $$,
  'get_public_config returns the public subset of app_config'
);

-- ---------------------------------------------------------------------------
-- The presence wall (R2-S1, R3-02, PR #6 M4, T32): 25 tests
-- ---------------------------------------------------------------------------
update public.wallets set last_seen_at = null;

set local role service_role;
select lives_ok(format($$ select * from public.presence_ping(%L) $$, pg_temp.uid('A')), 'service_role can call presence_ping');
reset role;
select is((select last_seen_at from public.wallets where user_id = pg_temp.uid('A')), now(),
  'R2-S1: the first ping sets last_seen_at');

update public.wallets set last_seen_at = now() - interval '30 seconds' where user_id = pg_temp.uid('A');
set local role service_role;
select lives_ok(format($$ select * from public.presence_ping(%L) $$, pg_temp.uid('A')), 'a ping 30 seconds after the last write runs');
reset role;
select is((select last_seen_at from public.wallets where user_id = pg_temp.uid('A')), now() - interval '30 seconds',
  'R2-S1: a ping within 60 seconds of the last write does not write');

update public.wallets set last_seen_at = now() - interval '61 seconds' where user_id = pg_temp.uid('A');
set local role service_role;
select lives_ok(format($$ select * from public.presence_ping(%L) $$, pg_temp.uid('A')), 'a ping 61 seconds after the last write runs');
reset role;
select is((select last_seen_at from public.wallets where user_id = pg_temp.uid('A')), now(),
  'R2-S1: a ping more than 60 seconds after the last write writes again');

update public.wallets set last_seen_at = now() - interval '20 seconds' where user_id = pg_temp.uid('C');
update public.wallets set last_seen_at = now() - interval '50 minutes' where user_id = pg_temp.uid('D');
update public.wallets set last_seen_at = now() - interval '2 hours' where user_id = pg_temp.uid('E');
update public.wallets set last_seen_at = now() where user_id = pg_temp.uid('B');
update public.profiles set live_hidden = true where id = pg_temp.uid('B');

create temporary table t_wall on commit drop as
  select g.list_hash, g.players from public.get_live_players(3600, 150) as g;
grant select on t_wall to service_role;
set local role service_role;

select results_eq(
  format($$ select list_hash, players from public.presence_ping(%L, 120, 150) $$, pg_temp.uid('A')),
  $$ select list_hash, players from public.get_live_players(120, 150) $$,
  'R2-S1: presence_ping returns the same rows as get_live_players for the same window'
);
select results_eq(
  $$ select (e.value ->> 'id')::uuid from public.get_live_players(120, 150) as g,
            jsonb_array_elements(g.players) with ordinality as e (value, ord) order by e.ord $$,
  $$ values (pg_temp.uid('A')), (pg_temp.uid('C')) $$,
  'the 120-second wall lists A then C, newest first; hidden B and older D and E are omitted'
);
select ok(
  not exists (select 1 from t_wall as w, jsonb_array_elements(w.players) as e where (e ->> 'id')::uuid = pg_temp.uid('B')),
  'T18: a live_hidden player is omitted even when recently seen'
);
select is_empty(
  $$ select e from t_wall as w, jsonb_array_elements(w.players) as e
     where (select array_agg(k order by k) from jsonb_object_keys(e) as k)
           is distinct from array['auraBps', 'avatarUrl', 'id', 'lastSeenBucket', 'name'] $$,
  'R3-02, T32: each player carries exactly id, name, avatarUrl, auraBps, and lastSeenBucket (no email, balance, crack count, or donation total)'
);
select results_eq(
  $$ select (e ->> 'id')::uuid, (e ->> 'lastSeenBucket')::integer from t_wall as w, jsonb_array_elements(w.players) as e order by 2, 1 $$,
  $$ select * from (values (pg_temp.uid('A'), 0), (pg_temp.uid('C'), 0), (pg_temp.uid('D'), 25)) as v (id, bucket) order by 2, 1 $$,
  'lastSeenBucket is floor(seconds since last seen / 120), relative to now'
);
select ok(
  exists (select 1 from public.get_live_players(1, 150) as g, jsonb_array_elements(g.players) as e
          where (e ->> 'id')::uuid = pg_temp.uid('C')),
  'the window is clamped up to 30 seconds'
);
select ok(
  (select bool_or((e ->> 'id')::uuid = pg_temp.uid('D')) and not bool_or((e ->> 'id')::uuid = pg_temp.uid('E'))
   from public.get_live_players(100000, 150) as g, jsonb_array_elements(g.players) as e),
  'the window is clamped down to 3600 seconds'
);
select is((select jsonb_array_length(players) from public.get_live_players(3600, 0)), 1,
  'the limit is clamped up to 1');
select is((select jsonb_array_length(players) from public.get_live_players(3600, 100000)), 3,
  'the limit is clamped down to 150 (all three eligible players fit)');
select is((select jsonb_array_length(players) from public.get_live_players(3600, 2)), 2,
  'the limit caps the list');
select ok(
  (select list_hash ~ '^[0-9a-f]{32}$' from t_wall),
  'R3-02: list_hash is 32 lowercase hex characters, which ListHashSchema accepts'
);
select is_empty(
  format($$ select 1 from public.get_live_players(3600, 150, %L) $$, (select list_hash from t_wall)),
  'R3-02: a matching known hash returns no row (unchanged)'
);
select is_empty(
  format($$ select 1 from public.presence_ping(%L, 3600, 150, %L) $$, pg_temp.uid('A'), (select list_hash from t_wall)),
  'R3-02: presence_ping with a matching known hash returns no row'
);
select is(
  (select count(*)::integer from public.get_live_players(3600, 150, 'NOT-A-HASH')), 1,
  'an invalid known hash is ignored and the list is returned'
);
reset role;

-- Recency and order change; id, name, avatar, and aura do not.
update public.wallets set last_seen_at = now() - interval '55 minutes' where user_id = pg_temp.uid('C');
set local role service_role;
select is_empty(
  format($$ select 1 from public.get_live_players(3600, 150, %L) $$, (select list_hash from t_wall)),
  'PR #6 M4: the hash excludes lastSeenBucket and the list order, so a recency change keeps it unchanged'
);
reset role;
update public.wallets set total_donated_cents = 500 where user_id = pg_temp.uid('A');
set local role service_role;
select isnt_empty(
  format($$ select 1 from public.get_live_players(3600, 150, %L) $$, (select list_hash from t_wall)),
  'an aura change changes the hash'
);
select is(
  pg_temp.raises(format($$ select * from public.presence_ping(%L) $$, pg_temp.uid('F'))),
  'PT403 forbidden', 'R2-16: presence_ping refuses a user without a wallet (an anonymous session)'
);
select is(
  pg_temp.raises($$ select * from public.presence_ping(null) $$),
  'PT422 invariant_violation', 'presence_ping refuses a null user id'
);
reset role;
update public.wallets set last_seen_at = null;
set local role service_role;
select results_eq(
  $$ select list_hash, players from public.get_live_players() $$,
  $$ values (md5('[]'), '[]'::jsonb) $$,
  'an empty wall is one row with an empty players array'
);
reset role;

-- ---------------------------------------------------------------------------
-- The ledger: append-only, the single mover, and the invariant (T28): 14 tests
-- ---------------------------------------------------------------------------
create temporary table t_before on commit drop as
  select (select balance_cents from public.wallets where user_id = pg_temp.uid('A')) as a_balance,
         (select treasury_cents from public.game_state) as treasury;
grant select on t_before to service_role;

set local role service_role;
select is(
  pg_temp.raises($$ update public.ledger_entries set amount_cents = 1 $$),
  'PT403 forbidden', 'UPDATE on ledger_entries raises PT403 even as service_role'
);
select is(
  pg_temp.raises($$ delete from public.ledger_entries $$),
  'PT403 forbidden', 'DELETE on ledger_entries raises PT403 even as service_role'
);
select is(
  pg_temp.sqlstate_of(format(
    $$ insert into public.ledger_entries (kind, from_account, to_account, amount_cents, user_id)
       values ('donation', 'cncf', 'player:%s', 100, %L) $$, pg_temp.uid('A'), pg_temp.uid('A'))),
  '23514', 'T28: a ledger row from cncf is rejected by the CHECK'
);
select is(
  pg_temp.raises(format($$ select private._post_ledger('donation', 'cncf', 'player:%s', 100, %L, null, null) $$,
    pg_temp.uid('A'), pg_temp.uid('A'))),
  'PT422 invariant_violation', 'T28: _post_ledger refuses to debit cncf'
);

select lives_ok(
  format($$ select private._post_ledger('attempt_fee', 'player:%s', 'treasury', 100, %L, %L, 'fee:%s') $$,
    pg_temp.uid('A'), pg_temp.uid('A'), (select id from t_ids where name = 'A_fail'), (select id from t_ids where name = 'A_fail')),
  'service_role can post an attempt fee'
);
select results_eq(
  $$ select (select balance_cents from public.wallets where user_id = pg_temp.uid('A')), (select treasury_cents from public.game_state) $$,
  $$ select a_balance - 100, treasury + 100 from t_before $$,
  'CH-1: an attempt fee moves 100 cents from the wallet to the treasury'
);
select is(
  pg_temp.raises(format($$ select private._post_ledger('attempt_fee', 'player:%s', 'treasury', 100000000, %L, null, null) $$,
    pg_temp.uid('A'), pg_temp.uid('A'))),
  'PT402 insufficient_funds', 'T28: a debit beyond the balance raises PT402 insufficient_funds'
);
select is(
  pg_temp.raises(format($$ select private._post_ledger('payout', 'treasury', 'player:%s', 100000000, %L, null, null) $$,
    pg_temp.uid('B'), pg_temp.uid('B'))),
  'PT422 invariant_violation', 'T28: a payout beyond the treasury raises PT422'
);
select is(
  pg_temp.raises(format($$ select private._post_ledger('payout', 'mint', 'player:%s', 100, %L, null, null) $$,
    pg_temp.uid('B'), pg_temp.uid('B'))),
  'PT422 invariant_violation', 'T28: _post_ledger refuses accounts that do not fit the kind'
);
select is(
  pg_temp.raises(format($$ select private._post_ledger('attempt_fee', 'player:%s', 'treasury', 100, %L, null, null) $$,
    pg_temp.uid('A'), pg_temp.uid('B'))),
  'PT422 invariant_violation', 'T28: _post_ledger refuses a user id that does not own the player account'
);
select lives_ok(
  format($$ select private._post_ledger('payout', 'treasury', 'player:%s', (select treasury_cents from public.game_state), %L, %L, 'payout:%s') $$,
    pg_temp.uid('B'), pg_temp.uid('B'), (select id from t_ids where name = 'A_win'), (select id from t_ids where name = 'A_win')),
  'service_role can pay the whole treasury out'
);
select is(
  pg_temp.sqlstate_of(format($$ select private._post_ledger('attempt_fee', 'player:%s', 'treasury', 100, %L, null, 'fee:%s') $$,
    pg_temp.uid('A'), pg_temp.uid('A'), (select id from t_ids where name = 'A_fail'))),
  '23505', 'T28: a second row with the same external_ref fails, so a fee is never taken twice'
);
reset role;
select is(
  pg_temp.raises($$ truncate public.ledger_entries $$),
  'PT403 forbidden', 'TRUNCATE on ledger_entries raises PT403 even for the table owner'
);
-- R and the M fixtures had their balances set directly above, so they are
-- outside the invariant.
select is_empty(
  $$ select w.user_id
     from public.wallets as w
     where w.user_id not in (pg_temp.uid('R'), pg_temp.uid('M1'), pg_temp.uid('M2'), pg_temp.uid('M3'))
       and w.balance_cents <> coalesce((select sum(l.amount_cents) from public.ledger_entries as l
                                         where l.to_account = 'player:' || w.user_id::text), 0)
                            - coalesce((select sum(l.amount_cents) from public.ledger_entries as l
                                         where l.from_account = 'player:' || w.user_id::text), 0)
     union all
     select null::uuid
     from public.game_state as g
     where g.treasury_cents <> coalesce((select sum(l.amount_cents) from public.ledger_entries as l where l.to_account = 'treasury'), 0)
                             - coalesce((select sum(l.amount_cents) from public.ledger_entries as l where l.from_account = 'treasury'), 0) $$,
  'T28: every wallet and the treasury equal their journal balance (incoming minus outgoing)'
);

-- ---------------------------------------------------------------------------
-- Public tables carry no private data (T15): 3 tests
-- ---------------------------------------------------------------------------
select is_empty(
  $$ select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'live_feed'
       and column_name in ('prompt', 'reply', 'email', 'display_name', 'balance_cents') $$,
  'T15: live_feed has no column named prompt, reply, email, display_name, or balance_cents'
);
select results_eq(
  $$ select column_name::text collate "default" from information_schema.columns
     where table_schema = 'public' and table_name = 'live_feed' and data_type = 'text' $$,
  $$ values ('event_type'::text) $$,
  'T15: live_feed has no free-text column (event_type is a CHECKed label)'
);
select results_eq(
  $$ select column_name::text collate "default" from information_schema.columns
     where table_schema = 'public' and table_name = 'game_state' order by ordinal_position $$,
  $$ values ('id'::text), ('current_level'::text), ('pig_epoch'::text), ('treasury_cents'::text),
            ('total_attempts'::text), ('total_wins'::text), ('total_paid_out_cents'::text), ('updated_at'::text) $$,
  'T15: game_state has no per-user column'
);

-- ---------------------------------------------------------------------------
-- The rule-set activation feed (R1-20): 5 tests
-- ---------------------------------------------------------------------------
insert into t_ids (name, id) values ('l1_v0', (select id from public.rule_sets where level_id = 1 and state = 'active'));
with ins as (
  insert into public.rule_sets (level_id, parent_id, state, rules, rules_sha256, source, technique)
  values (1, (select id from t_ids where name = 'l1_v0'), 'proposed', pg_temp.rules(array['reject_roleplay_archetypes']),
          private.rule_set_sha256(pg_temp.rules(array['reject_roleplay_archetypes'])), 'hardening', 'roleplay_persona')
  returning id
)
insert into t_ids (name, id) select 'l1_candidate', ins.id from ins;
insert into public.rule_gate_runs (rule_set_id, passed, failure_codes, finished_at)
values ((select id from t_ids where name = 'l1_candidate'), true, '{}', now());

create temporary table t_feed_mark on commit drop as select coalesce(max(id), 0) as last_id from public.live_feed;
grant select on t_feed_mark to service_role;

select is(
  (select count(*)::integer from public.live_feed where id > (select last_id from t_feed_mark)), 0,
  'R1-20: inserting a proposed rule set writes no feed row'
);
set local role service_role;
select is(public.promote_rule_set((select id from t_ids where name = 'l1_candidate')), 1, 'the hardening candidate is promoted to version 1');
reset role;
select results_eq(
  $$ select event_type, level_id::integer, rule_version, player_id, outcome::text
     from public.live_feed where id > (select last_id from t_feed_mark) $$,
  $$ values ('hardened'::text, 1, 1, null::uuid, null::text) $$,
  'R1-20: promoting a hardening rule set inserts exactly one hardened row; superseding the parent inserts none'
);
update t_feed_mark set last_id = (select max(id) from public.live_feed);
set local role service_role;
select lives_ok(
  format($$ select public.rollback_rule_set(1::smallint, %L) $$, (select id from t_ids where name = 'l1_v0')),
  'service_role rolls level 1 back to version 0'
);
reset role;
select results_eq(
  $$ select event_type, level_id::integer, rule_version from public.live_feed where id > (select last_id from t_feed_mark) $$,
  $$ values ('rules_reset'::text, 1, 2) $$,
  'R1-20: inserting a row that is already active fires one rules_reset row; rolling back the parent fires none'
);

-- ---------------------------------------------------------------------------
-- Paid wins only (CH-6b): 8 tests
-- ---------------------------------------------------------------------------
insert into t_ids (name, id) values
  ('B_fail', pg_temp.add_attempt(pg_temp.uid('B'), 'fail')),
  ('B_leak', pg_temp.add_attempt(pg_temp.uid('B'), 'leak_blocked')),
  ('B_late', pg_temp.add_attempt(pg_temp.uid('B'), 'late_win')),
  ('B_error', pg_temp.add_attempt(pg_temp.uid('B'), 'error')),
  ('l2_active', (select id from public.rule_sets where level_id = 2 and state = 'active'));

select is(
  pg_temp.sqlstate_of(format(
    $$ insert into public.hardening_jobs (attempt_id, user_id, level_id, trigger, prompt_sha256)
       values (%L, %L, 1, 'admin', repeat('a', 64)) $$, (select id from t_ids where name = 'B_fail'), pg_temp.uid('B'))),
  '23514', 'CH-6b: hardening_jobs rejects any trigger other than win'
);
select lives_ok(
  format($$ insert into public.hardening_jobs (attempt_id, user_id, level_id, trigger, prompt_sha256)
            values (%L, %L, 1, 'win', repeat('a', 64)) $$, (select id from t_ids where name = 'A_win'), pg_temp.uid('A')),
  'CH-6b: a hardening job for a paid win is accepted'
);

set local role service_role;
select is(
  pg_temp.raises(format($$ select public.insert_rule_proposal(2::smallint, %L, %L, 'roleplay_persona', %L) $$,
    (select id from t_ids where name = 'l2_active'), pg_temp.rules(array['reject_roleplay_archetypes', 'reject_authority_claims']),
    (select id from t_ids where name = 'B_fail'))),
  'PT422 not_a_win', 'CH-6b: insert_rule_proposal raises not_a_win for a fail source attempt'
);
select is(
  pg_temp.raises(format($$ select public.insert_rule_proposal(2::smallint, %L, %L, 'roleplay_persona', %L) $$,
    (select id from t_ids where name = 'l2_active'), pg_temp.rules(array['reject_roleplay_archetypes', 'reject_authority_claims']),
    (select id from t_ids where name = 'B_blocked'))),
  'PT422 not_a_win', 'CH-6b: insert_rule_proposal raises not_a_win for a blocked source attempt'
);
select is(
  pg_temp.raises(format($$ select public.insert_rule_proposal(2::smallint, %L, %L, 'roleplay_persona', %L) $$,
    (select id from t_ids where name = 'l2_active'), pg_temp.rules(array['reject_roleplay_archetypes', 'reject_authority_claims']),
    (select id from t_ids where name = 'B_leak'))),
  'PT422 not_a_win', 'CH-6b: insert_rule_proposal raises not_a_win for a leak_blocked source attempt'
);
select is(
  pg_temp.raises(format($$ select public.insert_rule_proposal(2::smallint, %L, %L, 'roleplay_persona', %L) $$,
    (select id from t_ids where name = 'l2_active'), pg_temp.rules(array['reject_roleplay_archetypes', 'reject_authority_claims']),
    (select id from t_ids where name = 'B_late'))),
  'PT422 not_a_win', 'CH-6b: insert_rule_proposal raises not_a_win for a late_win source attempt'
);
select is(
  pg_temp.raises(format($$ select public.insert_rule_proposal(2::smallint, %L, %L, 'roleplay_persona', %L) $$,
    (select id from t_ids where name = 'l2_active'), pg_temp.rules(array['reject_roleplay_archetypes', 'reject_authority_claims']),
    (select id from t_ids where name = 'B_error'))),
  'PT422 not_a_win', 'CH-6b: insert_rule_proposal raises not_a_win for an error source attempt'
);
select isnt(
  public.insert_rule_proposal(2::smallint, (select id from t_ids where name = 'l2_active'),
    pg_temp.rules(array['reject_roleplay_archetypes', 'reject_authority_claims']), 'roleplay_persona',
    (select id from t_ids where name = 'A_win')),
  null, 'CH-6b: insert_rule_proposal accepts a paid win as the source attempt'
);
reset role;

-- ---------------------------------------------------------------------------
-- The realtime publication (T15, R2-S1): 2 tests
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select tablename::text collate "default" from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' order by 1 $$,
  $$ values ('game_state'::text), ('live_feed'::text) $$,
  'T15: supabase_realtime publishes exactly game_state and live_feed in schema public'
);
do $$ begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'game_state') then
    alter publication supabase_realtime add table public.game_state;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'live_feed') then
    alter publication supabase_realtime add table public.live_feed;
  end if;
end $$;
select results_eq(
  $$ select tablename::text collate "default" from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' order by 1 $$,
  $$ values ('game_state'::text), ('live_feed'::text) $$,
  'R2-S1: re-running the publication block is a no-op'
);

-- ---------------------------------------------------------------------------
-- Foreign keys and their indexes (R2-19): 5 tests
-- ---------------------------------------------------------------------------
-- The skill's missing-foreign-key-index query (schema-foreign-key-indexes),
-- limited to schema public and excluding references to the five-row levels
-- table (section 5.1).
select is_empty(
  $$ select c.conrelid::regclass::text || '.' || a.attname
     from pg_constraint c
     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
     where c.contype = 'f'
       and c.connamespace = 'public'::regnamespace
       and c.confrelid <> 'public.levels'::regclass
       and not exists (
         select 1 from pg_index i
         where i.indrelid = c.conrelid and a.attnum = any (i.indkey)
       ) $$,
  'R2-19: every foreign-key column except references to levels has an index'
);
select results_eq(
  $$ select c.conrelid::regclass::text collate "default", c.conname::text collate "default", c.confdeltype::text collate "default"
     from pg_constraint c
     where c.contype = 'f' and c.confrelid = 'public.attempts'::regclass
     order by 1, 2 $$,
  $$ values ('blocked_fingerprints'::text, 'blocked_fingerprints_attempt_id_fkey'::text, 'n'::text),
            ('golden_prompts', 'golden_prompts_attempt_fk', 'n'),
            ('hardening_jobs', 'hardening_jobs_attempt_id_fkey', 'c'),
            ('rule_sets', 'rule_sets_source_attempt_fk', 'n') $$,
  'R2-19: the foreign keys to attempts; fingerprints, rule sets, and golden prompts use on delete set null'
);
select col_is_null('public', 'blocked_fingerprints', 'attempt_id', 'R2-19: blocked_fingerprints.attempt_id is nullable');

insert into t_ids (name, id) values ('W_win', pg_temp.add_attempt(pg_temp.uid('W'), 'late_win'));
insert into public.blocked_fingerprints (fingerprint, level_id, attempt_id)
values (repeat('b', 64), 1, (select id from t_ids where name = 'W_win'));
delete from auth.users where id = pg_temp.uid('W');
select results_eq(
  $$ select level_id::integer, attempt_id from public.blocked_fingerprints where fingerprint = repeat('b', 64) $$,
  $$ values (1, null::uuid) $$,
  'R2-19: deleting a user keeps their breach fingerprint blocked'
);
select ok(
  exists (select 1 from public.ledger_entries where external_ref = 'start:' || pg_temp.uid('W')::text)
  and not exists (select 1 from public.wallets where user_id = pg_temp.uid('W')),
  'the journal outlives a deleted user''s wallet'
);

-- ---------------------------------------------------------------------------
-- Backfill of accounts created before 00004 (CH-1, R2-06, R2-16): 8 tests
-- ---------------------------------------------------------------------------
-- In replica mode ordinary triggers do not fire, so these rows look like
-- Google sign-ups that happened before the sign-up trigger existed.
set local session_replication_role = replica;
insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, is_anonymous)
values
  (pg_temp.uid('P'), 'authenticated', 'authenticated', 'pp12-p@example.test',
   '{"provider": "google", "providers": ["google"]}',
   '{"name": "Pre Existing", "picture": "https://lh3.googleusercontent.com/a/ACg8ocJ_pp12-pre=s96-c"}', false),
  (pg_temp.uid('P2'), 'authenticated', 'authenticated', 'pp12-p2@example.test',
   '{"provider": "google"}',
   jsonb_build_object('full_name', E'\u202E\u0007\u200B', 'avatar_url', 'https://evil.example.com/a/x.png'), false),
  (pg_temp.uid('P3'), 'authenticated', 'authenticated', null, '{"provider": "anonymous"}', '{}', true);
set local session_replication_role = default;

select ok(
  not exists (select 1 from public.profiles where id in (pg_temp.uid('P'), pg_temp.uid('P2'), pg_temp.uid('P3')))
  and not exists (select 1 from public.wallets where user_id in (pg_temp.uid('P'), pg_temp.uid('P2'), pg_temp.uid('P3'))),
  'the pre-existing users start with no profile and no wallet'
);
select is(private._backfill_users(), 2, 'the backfill provisions exactly the two pre-existing non-anonymous users');
select results_eq(
  $$ select (select count(*)::integer from public.profiles where id = pg_temp.uid('P')),
            (select count(*)::integer from public.wallets where user_id = pg_temp.uid('P')),
            (select balance_cents from public.wallets where user_id = pg_temp.uid('P')),
            (select count(*)::integer from public.ledger_entries
              where user_id = pg_temp.uid('P') and kind = 'mint_starting'
                and external_ref = 'start:' || pg_temp.uid('P')::text and amount_cents = 2000) $$,
  $$ values (1, 1, 2000::bigint, 1) $$,
  'CH-1: a pre-existing Google user gets exactly one profile, one wallet, and one 2000-cent start:<id> grant'
);
select results_eq(
  $$ select display_name, avatar_url from public.profiles where id = pg_temp.uid('P') $$,
  $$ values ('Pre Existing'::text, 'https://lh3.googleusercontent.com/a/ACg8ocJ_pp12-pre=s96-c'::text) $$,
  'R2-06: the backfill takes the same sanitized Google snapshot as the sign-up trigger'
);
select ok(
  (select p.display_name ~ '^Player [0-9]{4}$' and p.avatar_url is null and w.balance_cents = 2000
   from public.profiles as p join public.wallets as w on w.user_id = p.id
   where p.id = pg_temp.uid('P2')),
  'a bad Google profile falls back to Player and four digits and a null avatar, and is still funded'
);
select ok(
  not exists (select 1 from public.profiles where id = pg_temp.uid('P3'))
  and not exists (select 1 from public.wallets where user_id = pg_temp.uid('P3'))
  and not exists (select 1 from public.ledger_entries where user_id = pg_temp.uid('P3')),
  'R2-16: the backfill leaves a pre-existing anonymous user unprovisioned'
);

create temporary table t_backfill_before on commit drop as
  select (select count(*) from public.profiles) as profiles,
         (select count(*) from public.wallets) as wallets,
         (select count(*) from public.ledger_entries) as ledger_rows,
         (select sum(balance_cents) from public.wallets) as balances,
         (select string_agg(id::text || ':' || display_name || ':' || coalesce(avatar_url, ''), ',' order by id) from public.profiles) as identities;
select is(private._backfill_users(), 0, 'a re-run of the backfill finds nothing to provision');
select results_eq(
  $$ select (select count(*) from public.profiles), (select count(*) from public.wallets),
            (select count(*) from public.ledger_entries), (select sum(balance_cents) from public.wallets),
            (select string_agg(id::text || ':' || display_name || ':' || coalesce(avatar_url, ''), ',' order by id) from public.profiles) $$,
  $$ select profiles, wallets, ledger_rows, balances, identities from t_backfill_before $$,
  'CH-1: re-running the backfill changes no profile, wallet, balance, or ledger row'
);

-- ---------------------------------------------------------------------------
-- Enums and config (CH-1): 2 tests
-- ---------------------------------------------------------------------------
select enum_has_labels('public', 'attempt_outcome',
  array['pending', 'win', 'late_win', 'fail', 'blocked', 'leak_blocked', 'error'],
  'attempt_outcome has the seven section 5.2 labels');
update public.app_config set value = 'true' where key = 'kill_switch';
select is((select attempts_enabled from public.get_public_config()), false,
  'get_public_config reports attempts disabled while the kill switch is on');

select * from finish();
rollback;
