-- pgTAP tests for supabase/migrations/00005_hardening_rpcs.sql (task PP-18).
--
-- Run with `pnpm db:test` against the local stack after `pnpm db:reset`.
-- Everything runs in one transaction that is rolled back, so nothing here
-- persists. Every address and prompt below is synthetic test data.
--
-- Fixtures are written as postgres; the functions under test are called
-- after `set local role service_role`, so the tests also prove their grants.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(63);

-- ---------------------------------------------------------------------------
-- Helpers and fixtures
-- ---------------------------------------------------------------------------

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

-- Every table privilege the role holds, sorted. NULL means none.
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

create temporary table t_ids (name text primary key, id uuid not null) on commit drop;

insert into t_ids (name, id) values
  ('H1', '00000000-0000-4000-8000-000000001801'),   -- the winner (excluded from traffic)
  ('H2', '00000000-0000-4000-8000-000000001802'),   -- traffic author
  ('H3', '00000000-0000-4000-8000-000000001803');   -- traffic author

create function pg_temp.uid(p_name text)
returns uuid
language sql
stable
as $$ select id from t_ids where name = p_name $$;

-- Inserts a synthetic attempt as postgres and returns its id. Finalized
-- outcomes get finalized_at = now() - p_finalized_ago, and error gets its
-- required code.
create function pg_temp.add_attempt(
  p_user          uuid,
  p_outcome       text,
  p_level         smallint default 1,
  p_epoch         bigint   default 1,
  p_prompt        text     default 'synthetic test prompt',
  p_finalized_ago interval default '0 seconds'
)
returns uuid
language sql
as $$
  insert into public.attempts (
    user_id, level_id, pig_epoch, rule_set_id, idempotency_key, prompt, prompt_sha256,
    prompt_fingerprint, prompt_chars, outcome, error_code, price_cents, spend_day, finalized_at
  ) values (
    p_user, p_level, p_epoch,
    (select rs.id from public.rule_sets as rs where rs.level_id = p_level and rs.state = 'active'),
    gen_random_uuid(), p_prompt,
    md5(random()::text) || md5(random()::text),
    md5(random()::text) || md5(random()::text),
    greatest(1, char_length(coalesce(p_prompt, 'x'))), p_outcome::public.attempt_outcome,
    case when p_outcome = 'error' then 'upstream_error' end,
    100, current_date,
    case when p_outcome <> 'pending' then now() - p_finalized_ago end
  )
  returning id;
$$;

-- Inserts a queued hardening job for an attempt, created p_age ago.
create function pg_temp.add_job(p_attempt uuid, p_level smallint, p_age interval)
returns uuid
language sql
as $$
  insert into public.hardening_jobs (attempt_id, user_id, level_id, trigger, prompt_sha256, created_at)
  select a.id, a.user_id, p_level, 'win', a.prompt_sha256, now() - p_age
  from public.attempts as a where a.id = p_attempt
  returning id;
$$;

-- 00001 revoked the default EXECUTE for functions that postgres creates.
grant execute on function pg_temp.raises(text) to anon, authenticated, service_role;
grant execute on function pg_temp.uid(text) to anon, authenticated, service_role;
grant select on t_ids to anon, authenticated, service_role;

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, is_anonymous)
values
  (pg_temp.uid('H1'), 'authenticated', 'authenticated', 'pp18-h1@example.test', '{"provider": "email"}', '{}', false),
  (pg_temp.uid('H2'), 'authenticated', 'authenticated', 'pp18-h2@example.test', '{"provider": "email"}', '{}', false),
  (pg_temp.uid('H3'), 'authenticated', 'authenticated', 'pp18-h3@example.test', '{"provider": "email"}', '{}', false);

-- Paid wins (one per epoch, attempts_one_win_per_epoch) and their jobs:
-- J1 and J2 at level 1, J3 at level 2, oldest first.
insert into t_ids (name, id) values
  ('W1', pg_temp.add_attempt(pg_temp.uid('H1'), 'win', 1::smallint, 101, 'pp18 grandma vault ritual breach one')),
  ('W2', pg_temp.add_attempt(pg_temp.uid('H1'), 'win', 1::smallint, 102, 'pp18 second synthetic breach')),
  ('W3', pg_temp.add_attempt(pg_temp.uid('H1'), 'win', 2::smallint, 103, 'pp18 third synthetic breach'));
insert into t_ids (name, id) values
  ('J1', pg_temp.add_job(pg_temp.uid('W1'), 1::smallint, '3 minutes')),
  ('J2', pg_temp.add_job(pg_temp.uid('W2'), 1::smallint, '2 minutes')),
  ('J3', pg_temp.add_job(pg_temp.uid('W3'), 2::smallint, '1 minute'));

-- ---------------------------------------------------------------------------
-- leases and claim_lease (section 8.6): 8 tests
-- ---------------------------------------------------------------------------
select has_table('public', 'leases', 'public.leases exists');
select ok((select relrowsecurity from pg_class where oid = 'public.leases'::regclass), 'RLS is enabled on leases');
select is_empty($$ select polname from pg_policy where polrelid = 'public.leases'::regclass $$,
  'leases has no policy: service role only (section 5.3)');

set local role service_role;
select is(public.claim_lease('sweep', 60), true, 'claim_lease returns true when the lease is free');
select is(public.claim_lease('sweep', 60), null::boolean,
  'claim_lease returns NULL, not false, while the term runs (the claim_stripe_webhook_event contract)');
select is(public.claim_lease('other_key', 60), true, 'a different key is an independent lease');
reset role;

update public.leases set held_until = now() - interval '1 second' where key = 'sweep';
set local role service_role;
select is(public.claim_lease('sweep', 60), true, 'claim_lease returns true again once the TTL has passed');
select is(pg_temp.raises($$ select public.claim_lease('Bad Key!', 60) $$), '23514 new row for relation "leases" violates check constraint "leases_key_format"',
  'a malformed lease key is refused by the CHECK');
reset role;

-- ---------------------------------------------------------------------------
-- claim_hardening_job (R1-08): 10 tests
-- ---------------------------------------------------------------------------
update public.app_config set value = 'true' where key = 'kill_switch';
set local role service_role;
select is_empty($$ select * from public.claim_hardening_job() $$, 'R1-08: claim_hardening_job returns empty while kill_switch is true');
reset role;
update public.app_config set value = 'false' where key = 'kill_switch';
update public.app_config set value = 'false' where key = 'hardening_enabled';
set local role service_role;
select is_empty($$ select * from public.claim_hardening_job() $$, 'R1-08: claim_hardening_job returns empty while hardening_enabled is false');
reset role;
update public.app_config set value = 'true' where key = 'hardening_enabled';
select is((select count(*)::integer from public.hardening_jobs where status = 'queued'), 3,
  'the switches left every job queued');

set local role service_role;
select results_eq(
  $$ select id, status, claim_count, claimed_at = now() from public.claim_hardening_job() $$,
  $$ values (pg_temp.uid('J1'), 'processing'::text, 1, true) $$,
  'R1-08: a claim returns exactly one row, the oldest queued job, as processing with claim_count 1'
);
select results_eq(
  $$ select id from public.claim_hardening_job() $$,
  $$ values (pg_temp.uid('J3')) $$,
  'R1-08: the next claim skips level 1, which already has a processing job, and takes level 2'
);
select is_empty($$ select * from public.claim_hardening_job() $$,
  'R1-08: with every level busy or empty, the claim returns empty');
select is_empty(format($$ select * from public.claim_hardening_job(%L) $$, pg_temp.uid('J2')),
  'R1-08: claiming a specific job at a busy level returns empty');
reset role;

update public.hardening_jobs set claimed_at = now() - interval '11 minutes' where id = pg_temp.uid('J1');
set local role service_role;
select results_eq(
  $$ select id, status, claim_count from public.claim_hardening_job() $$,
  $$ values (pg_temp.uid('J1'), 'processing'::text, 2) $$,
  'R1-08: a job processing for more than 10 minutes is re-claimed and its claim_count incremented'
);
reset role;
select is((select claimed_at from public.hardening_jobs where id = pg_temp.uid('J1')), now(),
  'the re-claim stamps a fresh claimed_at');
select ok(
  (select prosrc ~* 'for update of j skip locked' and prosrc ~* 'limit 1'
   from pg_proc where oid = 'public.claim_hardening_job(uuid)'::regprocedure),
  'R1-08: claim_hardening_job takes at most one row with FOR UPDATE SKIP LOCKED'
);

-- ---------------------------------------------------------------------------
-- finish_hardening_job: 12 tests
-- ---------------------------------------------------------------------------
create temporary table t_rule_set on commit drop as
  select rs.id from public.rule_sets as rs where rs.level_id = 1 and rs.state = 'active';
grant select on t_rule_set to service_role;

set local role service_role;
select is(
  pg_temp.raises(format($$ select public.finish_hardening_job(%L, 'promoted', %L, null) $$,
    pg_temp.uid('J1'), (select id from t_rule_set))),
  'ok', 'finish_hardening_job moves a processing job to promoted'
);
reset role;
select results_eq(
  $$ select status, rule_set_id, finished_at = now() from public.hardening_jobs where id = pg_temp.uid('J1') $$,
  $$ select 'promoted'::text, id, true from t_rule_set $$,
  'the promoted job records its rule set and finished_at'
);

set local role service_role;
select is(
  pg_temp.raises(format($$ select public.finish_hardening_job(%L, 'failed', null, 'engine_refusal') $$, pg_temp.uid('J1'))),
  'PT409 invalid_state', 'a finished job cannot move again (PT409)'
);
select is(
  pg_temp.raises(format($$ select public.finish_hardening_job(%L, 'failed', null, null) $$, pg_temp.uid('J2'))),
  'PT409 invalid_state', 'a queued job cannot jump to a terminal status (PT409)'
);
select is(
  pg_temp.raises(format($$ select public.finish_hardening_job(%L, 'queued', null, null) $$, pg_temp.uid('J3'))),
  'PT409 invalid_state', 'processing cannot move back to queued (PT409)'
);
select is(
  pg_temp.raises(format($$ select public.finish_hardening_job(%L, 'promoted', null, null) $$, pg_temp.uid('J3'))),
  'PT422 invariant_violation', 'a promoted finish needs the rule set'
);
select is(
  pg_temp.raises(format($$ select public.finish_hardening_job(%L, 'failed', null, 'engine_refusal') $$, pg_temp.uid('J3'))),
  'ok', 'a processing job may finish failed with a detail code'
);
select is(
  pg_temp.raises($$ select public.finish_hardening_job('00000000-0000-4000-8000-0000000018ff', 'failed', null, null) $$),
  'PT404 not_found', 'an unknown job raises PT404'
);
reset role;
select results_eq(
  $$ select status, error_code, finished_at is not null from public.hardening_jobs where id = pg_temp.uid('J3') $$,
  $$ values ('failed'::text, 'engine_refusal'::text, true) $$,
  'the failed job records its code and finished_at'
);

-- J2 is now claimable (level 1 has no processing job). Finish it, then the
-- queue is empty.
set local role service_role;
select results_eq(
  $$ select id from public.claim_hardening_job() $$,
  $$ values (pg_temp.uid('J2')) $$,
  'once level 1 is free, its next queued job is claimable'
);
select lives_ok(format($$ select public.finish_hardening_job(%L, 'skipped', null, 'no_change') $$, pg_temp.uid('J2')),
  'a processing job may finish skipped');
select is_empty($$ select * from public.claim_hardening_job() $$, 'R1-08: claim_hardening_job returns empty when nothing is queued');
reset role;

-- ---------------------------------------------------------------------------
-- add_breach_to_golden (CH-6b, HC-A3): 6 tests
-- ---------------------------------------------------------------------------
create temporary table t_golden (id uuid) on commit drop;
grant select, insert on t_golden to service_role;

set local role service_role;
insert into t_golden select public.add_breach_to_golden(pg_temp.uid('W1'));
reset role;
select results_eq(
  $$ select g.kind, g.level_id::integer, g.text, g.text_sha256, g.source, g.attempt_id
     from public.golden_prompts as g join t_golden as t on t.id = g.id $$,
  $$ values ('breach'::text, 1, 'pp18 grandma vault ritual breach one'::text,
             encode(extensions.digest('pp18 grandma vault ritual breach one', 'sha256'), 'hex'),
             'breach_auto'::text, pg_temp.uid('W1')) $$,
  'CH-6b: add_breach_to_golden copies the win''s prompt as a breach of its level, hashed with sha256'
);
set local role service_role;
select is(public.add_breach_to_golden(pg_temp.uid('W1')), (select id from t_golden),
  'a repeat returns the existing row''s id');
reset role;
select is((select count(*)::integer from public.golden_prompts
           where kind = 'breach' and text = 'pp18 grandma vault ritual breach one'), 1,
  'add_breach_to_golden is idempotent by hash');

insert into t_ids (name, id) values
  ('X_fail',    pg_temp.add_attempt(pg_temp.uid('H1'), 'fail')),
  ('X_blocked', pg_temp.add_attempt(pg_temp.uid('H1'), 'blocked')),
  ('X_leak',    pg_temp.add_attempt(pg_temp.uid('H1'), 'leak_blocked')),
  ('X_late',    pg_temp.add_attempt(pg_temp.uid('H1'), 'late_win')),
  ('X_error',   pg_temp.add_attempt(pg_temp.uid('H1'), 'error')),
  ('X_pending', pg_temp.add_attempt(pg_temp.uid('H1'), 'pending'));

set local role service_role;
select results_eq(
  $$ select n.name, pg_temp.raises(format('select public.add_breach_to_golden(%L)', t.id))
     from (values ('X_blocked'), ('X_error'), ('X_fail'), ('X_late'), ('X_leak')) as n (name)
     join t_ids as t on t.name = n.name
     order by n.name $$,
  $$ values ('X_blocked'::text, 'PT422 not_a_win'::text), ('X_error', 'PT422 not_a_win'),
            ('X_fail', 'PT422 not_a_win'), ('X_late', 'PT422 not_a_win'), ('X_leak', 'PT422 not_a_win') $$,
  'CH-6b: fail, blocked, leak_blocked, late_win, and error attempts raise PT422 not_a_win'
);
select is(
  pg_temp.raises(format('select public.add_breach_to_golden(%L)', pg_temp.uid('X_pending')))
    || ' / ' || pg_temp.raises($$ select public.add_breach_to_golden('00000000-0000-4000-8000-0000000018fe') $$),
  'PT422 not_a_win / PT422 not_a_win', 'a pending attempt and an unknown id raise PT422 not_a_win'
);
reset role;
select is((select count(*)::integer from public.golden_prompts where attempt_id in (select id from t_ids where name like 'X_%')), 0,
  'no refused attempt reached golden_prompts');

-- ---------------------------------------------------------------------------
-- reserve_ai_spend and settle_ai_spend (R1-08, R1-09): 11 tests
-- ---------------------------------------------------------------------------
set local role service_role;
select is(public.reserve_ai_spend('2026-01-01', 600, 1000, 'attempt'), true, 'an attempt reservation within the cap succeeds');
select is(public.reserve_ai_spend('2026-01-01', 500, 1000, 'hardening'), false,
  'a hardening reservation beyond what attempts left of the cap is refused');
select is(public.reserve_ai_spend('2026-01-01', 400, 1000, 'hardening'), true,
  'R1-09: hardening may use whatever the attempts have not used of the cap');
reset role;
select results_eq(
  $$ select attempt_reserved_micros, hardening_reserved_micros, attempt_calls, hardening_calls
     from public.ai_spend where day = '2026-01-01' $$,
  $$ values (600::bigint, 400::bigint, 1, 1) $$,
  'reservations land on the given spend_day, and only successful ones count as calls'
);
select is_empty($$ select day from public.ai_spend where day in (current_date, '2026-01-02') $$,
  'no other day row was touched');

set local role service_role;
select lives_ok($$ select public.settle_ai_spend('2026-01-01', 'attempt', 600, 450) $$, 'settle_ai_spend settles an attempt reservation');
select lives_ok($$ select public.settle_ai_spend('2026-01-01', 'hardening', 400, 300) $$, 'settle_ai_spend settles a hardening reservation');
reset role;
select results_eq(
  $$ select attempt_reserved_micros, attempt_settled_micros, hardening_reserved_micros, hardening_settled_micros
     from public.ai_spend where day = '2026-01-01' $$,
  $$ values (0::bigint, 450::bigint, 0::bigint, 300::bigint) $$,
  'settle releases exactly the reservation and records the actual spend on the given day'
);

update public.app_config set value = 'true' where key = 'kill_switch';
set local role service_role;
select is(public.reserve_ai_spend('2026-01-01', 1, 1000, 'hardening'), false, 'R1-08: reserve_ai_spend returns false while kill_switch is true');
reset role;
update public.app_config set value = 'false' where key = 'kill_switch';
select is((select hardening_reserved_micros + hardening_calls from public.ai_spend where day = '2026-01-01'), 1::bigint,
  'a refused reservation changes nothing');
set local role service_role;
select is(pg_temp.raises($$ select public.reserve_ai_spend('2026-01-01', 1, 1000, 'other') $$), 'PT422 invariant_violation',
  'an unknown kind raises PT422');
reset role;

-- ---------------------------------------------------------------------------
-- get_traffic_corpus (R2-15): 7 tests
-- ---------------------------------------------------------------------------
-- H1's attempts (the winner) are excluded; so are wins, pending attempts,
-- and purged prompts.
insert into t_ids (name, id) values
  ('T_old',    pg_temp.add_attempt(pg_temp.uid('H2'), 'fail',    1::smallint, 1, 'pp18 traffic older',  '5 minutes')),
  ('T_new',    pg_temp.add_attempt(pg_temp.uid('H3'), 'blocked', 1::smallint, 1, 'pp18 traffic newer',  '1 minute')),
  ('T_err',    pg_temp.add_attempt(pg_temp.uid('H3'), 'error',   1::smallint, 1, 'pp18 traffic error',  '3 minutes')),
  ('T_win',    pg_temp.add_attempt(pg_temp.uid('H2'), 'win',     1::smallint, 104, 'pp18 traffic win')),
  ('T_pend',   pg_temp.add_attempt(pg_temp.uid('H2'), 'pending', 1::smallint, 1, 'pp18 traffic pending')),
  ('T_purged', pg_temp.add_attempt(pg_temp.uid('H2'), 'fail',    1::smallint, 1, 'pp18 traffic purged', '2 minutes'));
update public.attempts set prompt = null where id = pg_temp.uid('T_purged');

set local role service_role;
select results_eq(
  format($$ select prompt, user_id from public.get_traffic_corpus(%L, 500) $$, pg_temp.uid('H1')),
  format($$ values ('pp18 traffic newer'::text, %L::uuid), ('pp18 traffic error', %L), ('pp18 traffic older', %L) $$,
         pg_temp.uid('H3'), pg_temp.uid('H3'), pg_temp.uid('H2')),
  'R2-15: get_traffic_corpus returns (prompt, user_id) of finalized non-win prompts of other users, newest first'
);
select is_empty(
  format($$ select 1 from public.get_traffic_corpus(%L, 500) where user_id = %L $$, pg_temp.uid('H3'), pg_temp.uid('H3')),
  'R2-15: the excluded user''s prompts never appear'
);
select results_eq(
  format($$ select prompt from public.get_traffic_corpus(%L, 1) $$, pg_temp.uid('H1')),
  $$ values ('pp18 traffic newer'::text) $$,
  'the limit keeps the newest rows'
);
select is((select count(*)::integer from public.get_traffic_corpus(pg_temp.uid('H1'), 0)), 1,
  'a limit below 1 is clamped to 1');
select is(pg_temp.raises($$ select * from public.get_traffic_corpus(null, 10) $$), 'PT422 invariant_violation',
  'the user to exclude is required');
reset role;

insert into public.attempts (
  user_id, level_id, pig_epoch, rule_set_id, idempotency_key, prompt, prompt_sha256,
  prompt_fingerprint, prompt_chars, outcome, price_cents, spend_day, finalized_at
)
select pg_temp.uid('H2'), 1, 1, (select id from t_rule_set), gen_random_uuid(), 'pp18 bulk traffic ' || g,
       md5(g::text) || md5(g::text), md5(g::text) || md5(g::text), 20, 'fail', 100, current_date,
       now() - interval '1 hour'
from generate_series(1, 1001) as g;

set local role service_role;
select is((select count(*)::integer from public.get_traffic_corpus(pg_temp.uid('H1'), 5000)), 1000,
  'R2-15: a limit above 1000 is clamped to 1000');
select is((select count(*)::integer from public.get_traffic_corpus(pg_temp.uid('H1'))), 500,
  'the default limit is 500');
reset role;

-- ---------------------------------------------------------------------------
-- Functions and privileges (R1-02, R2-17, H1): 9 tests
-- ---------------------------------------------------------------------------
create temporary table t_functions on commit drop as
  select unnest(array[
    'private._config_bool(text, boolean)',
    'private._config_bigint(text)',
    'public.claim_lease(text, integer)',
    'public.claim_hardening_job(uuid)',
    'public.finish_hardening_job(uuid, text, uuid, text)',
    'public.add_breach_to_golden(uuid)',
    'public.reserve_ai_spend(date, bigint, bigint, text)',
    'public.settle_ai_spend(date, text, bigint, bigint)',
    'public.get_traffic_corpus(uuid, integer)']::regprocedure[]) as fn;

select is_empty(
  $$ select r.role_name || ' ' || f.fn::text
     from (values ('anon'), ('authenticated')) as r (role_name)
     cross join t_functions as f
     where has_function_privilege(r.role_name, f.fn, 'EXECUTE') $$,
  'R2-17: anon and authenticated can execute no 00005 function'
);
select is_empty(
  $$ select f.fn::text from t_functions as f where not has_function_privilege('service_role', f.fn, 'EXECUTE') $$,
  'service_role can execute every 00005 function'
);
select is(
  (select count(*)::integer from t_functions f join pg_proc p on p.oid = f.fn where p.proconfig @> array['search_path=""']),
  9, 'R2-17: every 00005 function sets search_path to the empty string'
);
select is_empty(
  $$ select f.fn::text from t_functions f join pg_proc p on p.oid = f.fn where p.prosecdef $$,
  'every 00005 function is SECURITY INVOKER'
);
select is_empty(
  $$ select f.fn::text from t_functions f join pg_proc p on p.oid = f.fn
     where f.fn::text !~ '_config_' and p.prosrc !~ 'Lock order \(section 5\.1\):' $$,
  'R1-02: every 00005 function that can lock names its lock order in a comment at the top of its body'
);

create temporary table t_bodies on commit drop as
  select f.fn::text as fn,
         regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '''([^'']|'''')*''', '''''', 'g') as body
  from t_functions f join pg_proc p on p.oid = f.fn;
select is_empty(
  $$ select fn from t_bodies
     where body ~* '\m(from|join|into|update|table)\s+(game_state|wallets|attempts|ledger_entries|app_config|hardening_jobs|golden_prompts|ai_spend|leases|rule_sets|levels)\M'
        or body ~* '(^|[^.[:alnum:]_])(_config_bool|_config_bigint|_post_ledger|digest)\s*\('
        or body ~* '::\s*(attempt_outcome|crack_event|rule_set_state|attack_technique)\M' $$,
  'R2-17: every table, project function, and project type in a 00005 body is schema-qualified'
);
select ok((select count(*) from t_bodies where body ~ 'public\.hardening_jobs') >= 2,
  'the scan sees the qualified references, so it is looking at the real bodies');

select is(pg_temp.held_table_privileges('anon', 'public.leases'), null::text[], 'anon holds no privilege on leases');
select ok(
  pg_temp.held_table_privileges('authenticated', 'public.leases') is null
  and pg_temp.held_table_privileges('service_role', 'public.leases') @> array['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  'H1: authenticated holds nothing on leases, and service_role holds explicit DML'
);

select * from finish();
rollback;
