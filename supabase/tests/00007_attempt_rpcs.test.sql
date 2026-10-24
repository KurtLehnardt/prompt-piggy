-- pgTAP tests for supabase/migrations/00007_attempt_rpcs.sql (task PP-22).
--
-- Run with `pnpm db:test` against the local stack after `pnpm db:reset`.
-- Everything runs in one transaction that is rolled back, so nothing here
-- persists. Every address and prompt below is synthetic test data.
--
-- Fixtures are written as postgres; the functions under test are called
-- after `set local role service_role`, so the tests also prove their grants.
-- No fixture sets a balance or the treasury directly: every cent moves
-- through the RPCs and private._post_ledger, so the ledger invariant at the
-- end covers the whole run. now() is fixed inside one transaction, so token
-- buckets do not refill between calls and a stale attempt is staged by
-- moving its created_at back.
--
-- Two sessions racing one key cannot be expressed in a single pgTAP
-- session; scripts/db/concurrency.mjs proves that case (and the global lock
-- order) against the local stack.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(116);

-- ---------------------------------------------------------------------------
-- Helpers and fixtures
-- ---------------------------------------------------------------------------

create temporary table t_ids (name text primary key, id uuid not null) on commit drop;

insert into t_ids (name, id) values
  ('ADMIN', '00000000-0000-4000-8000-0000000022a0'),   -- reset_game caller (admin_actions has no FK)
  ('PA', '00000000-0000-4000-8000-0000000022a1'),      -- start basics, replay, in-flight
  ('PB', '00000000-0000-4000-8000-0000000022a2'),      -- stale attempt with another key
  ('PC', '00000000-0000-4000-8000-0000000022a3'),      -- stale attempt with the same key (R3-06)
  ('PC2', '00000000-0000-4000-8000-0000000022a4'),     -- same-key recovery under the kill switch
  ('PD', '00000000-0000-4000-8000-0000000022a5'),      -- kill switch, rate limit
  ('PE', '00000000-0000-4000-8000-0000000022a6'),      -- daily cap
  ('PF', '00000000-0000-4000-8000-0000000022a7'),      -- pig_changed, insufficient funds
  ('PG', '00000000-0000-4000-8000-0000000022a8'),      -- spend cap
  ('PK', '00000000-0000-4000-8000-0000000022a9'),      -- record_attempt invariants
  ('PH', '00000000-0000-4000-8000-0000000022aa'),      -- cracks
  ('PI', '00000000-0000-4000-8000-0000000022ab'),      -- error path and refund budget
  ('PI2', '00000000-0000-4000-8000-0000000022ac'),     -- unstorable reply (R3-07)
  ('PL', '00000000-0000-4000-8000-0000000022ad'),      -- late win
  ('PX', '00000000-0000-4000-8000-0000000022ae'),      -- fills the treasury
  ('PW', '00000000-0000-4000-8000-0000000022af'),      -- paid win
  ('PY', '00000000-0000-4000-8000-0000000022b0'),      -- replays the blocked fingerprint
  ('PJ', '00000000-0000-4000-8000-0000000022b1'),      -- per-user job cap
  ('P4', '00000000-0000-4000-8000-0000000022b2'),      -- level 4 secret, hardening disabled
  ('PS', '00000000-0000-4000-8000-0000000022b3'),      -- level 5 win with a seed
  ('PN5', '00000000-0000-4000-8000-0000000022b4'),     -- level_not_configured
  ('Q1', '00000000-0000-4000-8000-0000000022c1'),      -- ledger invariant sequence
  ('Q2', '00000000-0000-4000-8000-0000000022c2'),
  ('Q3', '00000000-0000-4000-8000-0000000022c3'),
  ('ANON', '00000000-0000-4000-8000-0000000022d0');    -- anonymous session: no wallet

create function pg_temp.uid(p_name text)
returns uuid
language sql
stable
as $$ select id from t_ids where name = p_name $$;

-- Runs a statement and returns {state, token, hint}: the SQLSTATE, the first
-- word of the message, and the hint parsed as JSON when it is JSON.
create function pg_temp.err(p_sql text)
returns jsonb
language plpgsql
as $$
declare
  v_hint text;
begin
  execute p_sql;
  return jsonb_build_object('state', 'ok');
exception when others then
  get stacked diagnostics v_hint = pg_exception_hint;
  return jsonb_build_object(
    'state', sqlstate,
    'token', split_part(sqlerrm, ':', 1),
    'hint', case when v_hint ~ '^\s*\{' then v_hint::jsonb end);
end
$$;

-- 'SQLSTATE token', or 'ok'.
create function pg_temp.raises(p_sql text)
returns text
language sql
as $$
  select case when e->>'state' = 'ok' then 'ok' else (e->>'state') || ' ' || (e->>'token') end
  from pg_temp.err(p_sql) as e
$$;

-- A 64-character hex string, as the route's sha256 and fingerprint are.
create function pg_temp.hex64()
returns text
language sql
volatile
as $$ select md5(random()::text) || md5(random()::text) $$;

-- start_attempt with route-like defaults; returns the result row as jsonb.
create function pg_temp.start_full(
  p_user     uuid,
  p_key      uuid    default null,
  p_fp       text    default null,
  p_epoch    bigint  default null,
  p_reserve  bigint  default 1000,
  p_cap      bigint  default 1000000000,
  p_share    integer default 8000,
  p_capacity integer default 100,
  p_daily    integer default 1000
)
returns jsonb
language sql
as $$
  select to_jsonb(s)
  from public.start_attempt(
    p_user, coalesce(p_key, gen_random_uuid()),
    coalesce(p_epoch, (select g.pig_epoch from public.game_state as g where g.id = 1)),
    'pp22 synthetic attack prompt', pg_temp.hex64(), coalesce(p_fp, pg_temp.hex64()),
    p_reserve, p_cap, p_share, p_capacity, 600, p_daily, 45) as s
$$;

create function pg_temp.start(
  p_user     uuid,
  p_key      uuid    default null,
  p_fp       text    default null,
  p_epoch    bigint  default null,
  p_reserve  bigint  default 1000,
  p_cap      bigint  default 1000000000,
  p_share    integer default 8000,
  p_capacity integer default 100,
  p_daily    integer default 1000
)
returns uuid
language sql
as $$
  select (pg_temp.start_full(p_user, p_key, p_fp, p_epoch, p_reserve, p_cap, p_share, p_capacity, p_daily)
          ->> 'attempt_id')::uuid
$$;

-- record_attempt with consistent flags for the outcome; returns the result
-- row as jsonb.
create function pg_temp.rec(
  p_id     uuid,
  p_outcome text,
  p_error  text    default null,
  p_block  boolean default false,
  p_cost   bigint  default 500,
  p_reply  text    default 'pp22 synthetic reply',
  p_jobs   integer default 3,
  p_tool   boolean default null,
  p_canary boolean default null
)
returns jsonb
language sql
as $$
  select to_jsonb(r)
  from public.record_attempt(
    p_id, p_outcome::public.attempt_outcome, p_reply, array['keyword']::text[], array['roleplay']::text[],
    0.25::real, 'unclassified'::public.attack_technique,
    coalesce(p_canary, p_outcome = 'leak_blocked'), coalesce(p_tool, p_outcome = 'win'),
    p_cost, p_error, p_block, p_jobs) as r
$$;

create temporary table t_r (name text primary key, r jsonb) on commit drop;
create function pg_temp.keep(p_name text, p_r jsonb) returns jsonb
language sql as $$ insert into t_r values (p_name, p_r) on conflict (name) do update set r = excluded.r returning r $$;
create function pg_temp.r(p_name text) returns jsonb
language sql stable as $$ select r from t_r where name = p_name $$;
create function pg_temp.id(p_name text) returns uuid
language sql stable as $$ select (r ->> 'attempt_id')::uuid from t_r where name = p_name $$;

create temporary table t_before (name text primary key, v bigint) on commit drop;
create function pg_temp.snap(p_name text, p_value bigint) returns bigint
language sql as $$ insert into t_before values (p_name, p_value) on conflict (name) do update set v = excluded.v returning v $$;
create function pg_temp.was(p_name text) returns bigint
language sql stable as $$ select v from t_before where name = p_name $$;

create function pg_temp.balance(p_user uuid) returns bigint
language sql stable as $$ select balance_cents from public.wallets where user_id = p_user $$;
create function pg_temp.cracks(p_user uuid) returns smallint
language sql stable as $$ select crack_count from public.wallets where user_id = p_user $$;
create function pg_temp.treasury() returns bigint
language sql stable as $$ select treasury_cents from public.game_state where id = 1 $$;
create function pg_temp.epoch() returns bigint
language sql stable as $$ select pig_epoch from public.game_state where id = 1 $$;
create function pg_temp.level() returns smallint
language sql stable as $$ select current_level from public.game_state where id = 1 $$;
create function pg_temp.reserved() returns bigint
language sql stable as $$ select coalesce((select attempt_reserved_micros from public.ai_spend where day = current_date), 0) $$;
create function pg_temp.settled() returns bigint
language sql stable as $$ select coalesce((select attempt_settled_micros from public.ai_spend where day = current_date), 0) $$;
create function pg_temp.calls() returns bigint
language sql stable as $$ select coalesce((select attempt_calls from public.ai_spend where day = current_date), 0)::bigint $$;
create function pg_temp.feed_max() returns bigint
language sql stable as $$ select coalesce(max(id), 0) from public.live_feed $$;
create function pg_temp.outcome(p_id uuid) returns text
language sql stable as $$ select outcome::text from public.attempts where id = p_id $$;

-- Every violated ledger invariant (R2-19, section 9.4), as text:
--   - for every wallet, incoming minus outgoing journal amounts equal the balance;
--   - the treasury's journal balance equals the stored treasury;
--   - wallets + treasury + journal balances of player accounts without a
--     wallet equal everything minted minus everything donated.
create function pg_temp.ledger_problems()
returns setof text
language sql
stable
as $$
  with flows as (
    select l.to_account as account, l.amount_cents as amount from public.ledger_entries as l
    union all
    select l.from_account, -l.amount_cents from public.ledger_entries as l
  ),
  net as (
    select f.account, sum(f.amount) as amount from flows as f group by f.account
  )
  select format('wallet %s: journal %s, balance %s', w.user_id, coalesce(n.amount, 0), w.balance_cents)
  from public.wallets as w
  left join net as n on n.account = 'player:' || w.user_id::text
  where coalesce(n.amount, 0) <> w.balance_cents
  union all
  select format('treasury: journal %s, stored %s', coalesce((select n.amount from net as n where n.account = 'treasury'), 0), g.treasury_cents)
  from public.game_state as g
  where g.id = 1
    and coalesce((select n.amount from net as n where n.account = 'treasury'), 0) <> g.treasury_cents
  union all
  select 'conservation: wallets + treasury + orphaned player accounts <> minted - donated'
  where (select coalesce(sum(w.balance_cents), 0) from public.wallets as w)
        + (select g.treasury_cents from public.game_state as g where g.id = 1)
        + (select coalesce(sum(n.amount), 0) from net as n
           where n.account like 'player:%'
             and not exists (select 1 from public.wallets as w where 'player:' || w.user_id::text = n.account))
        <> (select coalesce(sum(l.amount_cents), 0) from public.ledger_entries as l where l.from_account = 'mint')
           - (select coalesce(sum(l.amount_cents), 0) from public.ledger_entries as l where l.to_account = 'cncf')
$$;

grant select on t_ids, t_r, t_before to service_role;
grant insert, update on t_r, t_before to service_role;
grant execute on function pg_temp.uid(text) to service_role;
grant execute on function pg_temp.err(text) to service_role;
grant execute on function pg_temp.raises(text) to service_role;
grant execute on function pg_temp.hex64() to service_role;
grant execute on function pg_temp.start_full(uuid, uuid, text, bigint, bigint, bigint, integer, integer, integer) to service_role;
grant execute on function pg_temp.start(uuid, uuid, text, bigint, bigint, bigint, integer, integer, integer) to service_role;
grant execute on function pg_temp.rec(uuid, text, text, boolean, bigint, text, integer, boolean, boolean) to service_role;
grant execute on function pg_temp.keep(text, jsonb) to service_role;
grant execute on function pg_temp.r(text) to service_role;
grant execute on function pg_temp.id(text) to service_role;
grant execute on function pg_temp.snap(text, bigint) to service_role;
grant execute on function pg_temp.was(text) to service_role;
grant execute on function pg_temp.balance(uuid) to service_role;
grant execute on function pg_temp.cracks(uuid) to service_role;
grant execute on function pg_temp.treasury() to service_role;
grant execute on function pg_temp.epoch() to service_role;
grant execute on function pg_temp.level() to service_role;
grant execute on function pg_temp.reserved() to service_role;
grant execute on function pg_temp.settled() to service_role;
grant execute on function pg_temp.calls() to service_role;
grant execute on function pg_temp.feed_max() to service_role;
grant execute on function pg_temp.outcome(uuid) to service_role;
grant execute on function pg_temp.ledger_problems() to service_role;

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, is_anonymous)
select t.id, 'authenticated', 'authenticated', lower('pp22-' || t.name || '@example.test'),
       '{"provider": "email"}', '{}', t.name = 'ANON'
from t_ids as t
where t.name <> 'ADMIN';

update public.app_config set value = '3'   where key = 'refund_budget_per_hour';
update public.app_config set value = '100' where key = 'attempt_price_cents';
update public.app_config set value = '0'   where key = 'treasury_seed_cents';
update public.app_config set value = 'false' where key = 'kill_switch';
update public.app_config set value = 'true'  where key = 'attempts_enabled';
update public.app_config set value = 'true'  where key = 'hardening_enabled';

-- The pig starts this run at level 1 in a fresh epoch.
select public.reset_game(pg_temp.uid('ADMIN'), 1::smallint);

set local role service_role;

-- ---------------------------------------------------------------------------
-- Catalog: grants, search_path, and HC3 (R2-17, HC3, HC-A5): 7 tests
-- ---------------------------------------------------------------------------
select is_empty(
  $$ select format('%s:%s', r.role_name, f.fn)
     from (values ('anon', false), ('authenticated', false), ('service_role', true)) as r (role_name, expected)
     cross join unnest(array[
       'private._attempt_replay(uuid)',
       'public.start_attempt(uuid, uuid, bigint, text, text, text, bigint, bigint, integer, integer, integer, integer, integer)',
       'public.record_attempt(uuid, public.attempt_outcome, text, text[], text[], real, public.attack_technique, boolean, boolean, bigint, text, boolean, integer)',
       'public.attempt_result(uuid, uuid)']) as f (fn)
     where has_function_privilege(r.role_name, f.fn, 'EXECUTE') <> r.expected $$,
  'R2-17: anon and authenticated cannot execute any 00007 function; service_role can'
);

select is(
  (select count(*)::integer
   from pg_proc as p join pg_namespace as n on n.oid = p.pronamespace
   where (n.nspname, p.proname) in (('public', 'start_attempt'), ('public', 'record_attempt'),
                                    ('public', 'attempt_result'), ('private', '_attempt_replay'))
     and not p.prosecdef
     and p.proconfig @> array['search_path=""']),
  4,
  'R2-17: every 00007 function is SECURITY INVOKER and sets search_path to the empty string'
);

select is_empty(
  $$ select a.name
     from pg_proc as p
     cross join unnest(p.proargnames) as a (name)
     where p.oid in ('public.start_attempt(uuid, uuid, bigint, text, text, text, bigint, bigint, integer, integer, integer, integer, integer)'::regprocedure,
                     'private._attempt_replay(uuid)'::regprocedure)
       and a.name ~* 'crack' $$,
  'HC3: no parameter or result column of start_attempt or its replay helper names a crack'
);

select set_eq(
  $$ select a.name
     from pg_proc as p
     cross join unnest(p.proargnames, p.proargmodes) as a (name, mode)
     where p.oid = 'public.start_attempt(uuid, uuid, bigint, text, text, text, bigint, bigint, integer, integer, integer, integer, integer)'::regprocedure
       and a.mode = 't' $$,
  $$ values ('attempt_id'), ('level_id'), ('pig_epoch'), ('rule_set_id'), ('rules'), ('rule_version'),
            ('level_secret'), ('fingerprint_blocked'), ('price_cents'), ('wallet_balance_cents'),
            ('treasury_cents'), ('replay') $$,
  'start_attempt returns exactly the section 5.4 columns'
);

select ok(
  not exists (select 1 from pg_proc as p
              where p.oid in ('public.start_attempt(uuid, uuid, bigint, text, text, text, bigint, bigint, integer, integer, integer, integer, integer)'::regprocedure,
                              'private._attempt_replay(uuid)'::regprocedure)
                and p.prosrc ~* 'crack'),
  'HC3: start_attempt and its replay helper never read or mention the crack count'
);

select is(
  (select array_agg(p.proname::text order by p.proname::text)
   from pg_proc as p join pg_namespace as n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private')
     and p.prosrc ~* '\mset\M[^;]*\mcrack_count\M\s*='),
  array['record_attempt', 'repair_glass'],
  'HC-A5: only record_attempt and repair_glass assign wallets.crack_count'
);

select is(
  (select count(*)::integer from pg_proc as p join pg_namespace as n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('start_attempt', 'record_attempt', 'attempt_result')),
  3,
  'each public 00007 function has exactly one signature'
);

-- ---------------------------------------------------------------------------
-- start_attempt: the fee before any model call (CH-1, R2-29, R2-12): 10 tests
-- ---------------------------------------------------------------------------
select pg_temp.snap('pa_balance', pg_temp.balance(pg_temp.uid('PA')));
select pg_temp.snap('treasury', pg_temp.treasury());
select pg_temp.snap('total_attempts', (select total_attempts from public.game_state where id = 1));
select pg_temp.snap('reserved', pg_temp.reserved());
select pg_temp.snap('calls', pg_temp.calls());

select pg_temp.keep('A1', pg_temp.start_full(pg_temp.uid('PA'), '00000000-0000-4000-8000-00000022e001'));

select is(
  (pg_temp.r('A1') ->> 'replay')::boolean, false,
  'a new attempt is not a replay'
);

select ok(
  pg_temp.balance(pg_temp.uid('PA')) = pg_temp.was('pa_balance') - 100
  and (pg_temp.r('A1') ->> 'wallet_balance_cents')::bigint = pg_temp.was('pa_balance') - 100
  and (pg_temp.r('A1') ->> 'price_cents')::bigint = 100,
  'CH-1: start_attempt debits attempt_price_cents (100) from the wallet before it returns'
);

select ok(
  pg_temp.treasury() = pg_temp.was('treasury') + 100
  and (pg_temp.r('A1') ->> 'treasury_cents')::bigint = pg_temp.treasury(),
  'CH-1: the fee lands in the treasury'
);

select is(
  (select format('%s|%s|%s|%s|%s|%s', l.kind, l.from_account, l.to_account, l.amount_cents, l.user_id, l.external_ref)
   from public.ledger_entries as l where l.attempt_id = pg_temp.id('A1')),
  format('attempt_fee|player:%s|treasury|100|%s|fee:%s', pg_temp.uid('PA'), pg_temp.uid('PA'), pg_temp.id('A1')),
  'R2-29: the fee''s single ledger row carries the new attempt''s id'
);

select is(
  (select format('%s|%s|%s|%s|%s|%s|%s|%s', a.outcome, a.level_id, a.pig_epoch, a.rule_set_id, a.price_cents,
                 a.reserved_micros, a.spend_day = current_date, a.finalized_at is null)
   from public.attempts as a where a.id = pg_temp.id('A1')),
  format('pending|1|%s|%s|100|1000|t|t', pg_temp.epoch(),
         (select rs.id from public.rule_sets as rs where rs.level_id = 1 and rs.state = 'active')),
  'the attempt is pending and pins the level, epoch, active rule set, price, reservation, and spend day'
);

select ok(
  (pg_temp.r('A1') ->> 'rule_set_id')::uuid = (select rs.id from public.rule_sets as rs where rs.level_id = 1 and rs.state = 'active')
  and (pg_temp.r('A1') -> 'rules') = (select rs.rules from public.rule_sets as rs where rs.level_id = 1 and rs.state = 'active')
  and (pg_temp.r('A1') ->> 'rule_version')::integer = (select rs.version from public.rule_sets as rs where rs.level_id = 1 and rs.state = 'active')
  and (pg_temp.r('A1') ->> 'level_id')::integer = 1
  and (pg_temp.r('A1') ->> 'pig_epoch')::bigint = pg_temp.epoch(),
  'the result carries the pinned level, epoch, and the active rule set with its version'
);

select ok(
  pg_temp.r('A1') -> 'level_secret' = 'null'::jsonb
  and (pg_temp.r('A1') ->> 'fingerprint_blocked')::boolean = false,
  'R2-12: level_secret is null at levels 1 to 3; an unknown fingerprint is not blocked'
);

select is(
  (select format('%s|%s|%s', w.in_flight_attempt_id = pg_temp.id('A1'), w.total_attempts, w.last_seen_at is not null)
   from public.wallets as w where w.user_id = pg_temp.uid('PA')),
  't|1|t',
  'the wallet records the in-flight attempt, the attempt count, and the last-seen time'
);

select ok(
  (select total_attempts from public.game_state where id = 1) = pg_temp.was('total_attempts') + 1
  and pg_temp.reserved() = pg_temp.was('reserved') + 1000
  and pg_temp.calls() = pg_temp.was('calls') + 1,
  'game_state counts the attempt, and the spend reservation is taken (one call, 1000 micros)'
);

select is(
  (select string_agg(format('%s=%s', r.bucket, r.tokens::numeric(10, 0)), ',' order by r.bucket)
   from public.rate_limits as r where r.user_id = pg_temp.uid('PA')),
  'attempt=99,attempt_daily=1',
  'the attempt token and the daily count are consumed once'
);

-- ---------------------------------------------------------------------------
-- Replays and in-flight attempts (R2-05, R1-05, R2-13, R3-06): 14 tests
-- ---------------------------------------------------------------------------
select pg_temp.keep('E_same', pg_temp.err(format(
  'select pg_temp.start(%L, %L)', pg_temp.uid('PA'), '00000000-0000-4000-8000-00000022e001')));

select ok(
  pg_temp.r('E_same') ->> 'state' = 'PT409' and pg_temp.r('E_same') ->> 'token' = 'attempt_in_flight'
  and (pg_temp.r('E_same') -> 'hint' ->> 'sameKey')::boolean = true
  and (pg_temp.r('E_same') -> 'hint' ->> 'retryAfterSeconds')::integer between 1 and 45,
  'R2-05: the same key on a pending attempt raises PT409 attempt_in_flight with sameKey true and the seconds until it is stale'
);

select pg_temp.keep('E_other', pg_temp.err(format('select pg_temp.start(%L)', pg_temp.uid('PA'))));

select ok(
  pg_temp.r('E_other') ->> 'state' = 'PT409' and pg_temp.r('E_other') ->> 'token' = 'attempt_in_flight'
  and (pg_temp.r('E_other') -> 'hint' ->> 'sameKey')::boolean = false
  and (pg_temp.r('E_other') -> 'hint' ->> 'retryAfterSeconds')::integer between 1 and 45,
  'R2-13: another pending attempt of the player raises attempt_in_flight with sameKey false and the seconds until it is stale'
);

select ok(
  pg_temp.balance(pg_temp.uid('PA')) = pg_temp.was('pa_balance') - 100
  and (select count(*) from public.attempts where user_id = pg_temp.uid('PA')) = 1
  and (select string_agg(r.tokens::numeric(10, 0)::text, ',' order by r.bucket) from public.rate_limits as r
       where r.user_id = pg_temp.uid('PA')) = '99,1',
  'a refused in-flight call charges nothing and consumes no token'
);

select pg_temp.keep('A1_rec', pg_temp.rec(pg_temp.id('A1'), 'fail'));

select pg_temp.keep('A1_replay', pg_temp.start_full(pg_temp.uid('PA'), '00000000-0000-4000-8000-00000022e001'));

select ok(
  (pg_temp.r('A1_replay') ->> 'replay')::boolean = true
  and pg_temp.id('A1_replay') = pg_temp.id('A1'),
  'R2-05: the same key on a finalized attempt returns it with replay true'
);

select ok(
  pg_temp.balance(pg_temp.uid('PA')) = pg_temp.was('pa_balance') - 100
  and (select count(*) from public.ledger_entries as l where l.kind = 'attempt_fee' and l.user_id = pg_temp.uid('PA')) = 1
  and (pg_temp.r('A1_replay') ->> 'wallet_balance_cents')::bigint = pg_temp.was('pa_balance') - 100,
  'R2-05: a replay charges nothing: one fee for one key'
);

select ok(
  (select string_agg(r.tokens::numeric(10, 0)::text, ',' order by r.bucket) from public.rate_limits as r
   where r.user_id = pg_temp.uid('PA')) = '99,1'
  and pg_temp.r('A1_replay') -> 'level_secret' = 'null'::jsonb
  and (pg_temp.r('A1_replay') ->> 'price_cents')::bigint = 100,
  'a replay consumes no token or daily count, carries the stored price, and no level secret'
);

-- A stale attempt with another key is reaped first (R1-18, R2-13).
select pg_temp.keep('B1', pg_temp.start_full(pg_temp.uid('PB')));
update public.attempts set created_at = now() - interval '60 seconds' where id = pg_temp.id('B1');
select pg_temp.snap('reserved', pg_temp.reserved());
select pg_temp.snap('settled', pg_temp.settled());
select pg_temp.keep('B2', pg_temp.start_full(pg_temp.uid('PB')));

select is(
  (select format('%s|%s|%s|%s', a.outcome, a.error_code, a.refund_cents, a.finalized_at is not null)
   from public.attempts as a where a.id = pg_temp.id('B1')),
  'error|reaped|100|t',
  'R2-13: a stale in-flight attempt is reaped as error reaped with a refund before the new one starts'
);

select ok(
  pg_temp.id('B2') is not null
  and pg_temp.balance(pg_temp.uid('PB')) = 1900
  and (select in_flight_attempt_id from public.wallets where user_id = pg_temp.uid('PB')) = pg_temp.id('B2'),
  'the new attempt starts after the reap: 2000 - 100 + 100 refund - 100 = 1900, and it is the one in flight'
);

select ok(
  pg_temp.reserved() = pg_temp.was('reserved') - 1000 + 1000
  and pg_temp.settled() = pg_temp.was('settled') + 1000,
  'R2-04: the reaped attempt''s reservation is released once and settled at the reservation'
);

select pg_temp.rec(pg_temp.id('B2'), 'fail');

-- A stale attempt with the same key is reaped and replayed (R3-06).
select pg_temp.keep('C1', pg_temp.start_full(pg_temp.uid('PC'), '00000000-0000-4000-8000-00000022e0c1'));
update public.attempts set created_at = now() - interval '60 seconds' where id = pg_temp.id('C1');
select pg_temp.keep('C1_again', pg_temp.start_full(pg_temp.uid('PC'), '00000000-0000-4000-8000-00000022e0c1'));

select ok(
  (pg_temp.r('C1_again') ->> 'replay')::boolean = true and pg_temp.id('C1_again') = pg_temp.id('C1'),
  'R3-06: a same-key re-post that finds a stale pending attempt returns it with replay true'
);

select is(
  (select format('%s|%s|%s|%s', a.outcome, a.error_code, a.refund_cents, a.crack_event)
   from public.attempts as a where a.id = pg_temp.id('C1')),
  'error|reaped|100|none',
  'R3-06: the stale same-key attempt was settled through the budgeted error path before the call returned'
);

select ok(
  pg_temp.balance(pg_temp.uid('PC')) = 2000
  and (select in_flight_attempt_id from public.wallets where user_id = pg_temp.uid('PC')) is null
  and (select count(*) from public.ledger_entries as l where l.kind = 'attempt_fee' and l.user_id = pg_temp.uid('PC')) = 1
  and (select count(*) from public.attempts where user_id = pg_temp.uid('PC')) = 1,
  'R3-06: the recovery charges nothing and opens no second attempt; the fee was refunded'
);

select pg_temp.keep('C2', pg_temp.start_full(pg_temp.uid('PC2'), '00000000-0000-4000-8000-00000022e0c2'));
update public.attempts set created_at = now() - interval '60 seconds' where id = pg_temp.id('C2');
update public.app_config set value = 'true' where key = 'kill_switch';
select pg_temp.keep('C2_again', pg_temp.start_full(pg_temp.uid('PC2'), '00000000-0000-4000-8000-00000022e0c2'));
update public.app_config set value = 'false' where key = 'kill_switch';

select ok(
  (pg_temp.r('C2_again') ->> 'replay')::boolean = true
  and pg_temp.outcome(pg_temp.id('C2')) = 'error'
  and pg_temp.balance(pg_temp.uid('PC2')) = 2000,
  'R3-06: the same-key recovery also works while the kill switch is on, because it charges nothing'
);

select is(
  pg_temp.raises(format('select pg_temp.start(%L)', pg_temp.uid('ANON'))),
  'PT403 forbidden',
  'a player without a wallet (an anonymous session) is refused with PT403'
);

-- ---------------------------------------------------------------------------
-- Refusals charge nothing (R2-20, R2-12, R1-09, T16): 17 tests
-- ---------------------------------------------------------------------------
update public.app_config set value = 'true' where key = 'kill_switch';
select is(
  pg_temp.raises(format('select pg_temp.start(%L)', pg_temp.uid('PD'))),
  'PT503 kill_switch',
  'kill_switch on raises PT503'
);
update public.app_config set value = 'false' where key = 'kill_switch';

update public.app_config set value = 'false' where key = 'attempts_enabled';
select is(
  pg_temp.raises(format('select pg_temp.start(%L)', pg_temp.uid('PD'))),
  'PT503 kill_switch',
  'attempts_enabled off raises PT503 kill_switch'
);
update public.app_config set value = 'true' where key = 'attempts_enabled';

select ok(
  pg_temp.balance(pg_temp.uid('PD')) = 2000
  and not exists (select 1 from public.attempts where user_id = pg_temp.uid('PD'))
  and not exists (select 1 from public.rate_limits where user_id = pg_temp.uid('PD')),
  'the kill switch charges nothing and consumes no token'
);

select pg_temp.keep('D1', pg_temp.start_full(pg_temp.uid('PD'), p_capacity => 1));
select pg_temp.rec(pg_temp.id('D1'), 'fail');
select pg_temp.keep('E_rate', pg_temp.err(format('select pg_temp.start(%L, p_capacity => 1)', pg_temp.uid('PD'))));

select ok(
  pg_temp.r('E_rate') ->> 'state' = 'PT429' and pg_temp.r('E_rate') ->> 'token' = 'rate_limited'
  and (pg_temp.r('E_rate') -> 'hint' ->> 'retryAfterSeconds')::integer >= 1,
  'an exhausted token bucket raises PT429 rate_limited with a retry hint'
);

select ok(
  pg_temp.balance(pg_temp.uid('PD')) = 1900
  and (select count(*) from public.attempts where user_id = pg_temp.uid('PD')) = 1,
  'the rate-limited call charges nothing'
);

select pg_temp.keep('E1', pg_temp.start_full(pg_temp.uid('PE'), p_daily => 1));
select pg_temp.rec(pg_temp.id('E1'), 'fail');

select is(
  pg_temp.raises(format('select pg_temp.start(%L, p_daily => 1)', pg_temp.uid('PE'))),
  'PT429 daily_cap',
  'R1-09: the daily attempt cap raises PT429 daily_cap'
);

select pg_temp.keep('E_pig', pg_temp.err(format('select pg_temp.start(%L, p_epoch => %s)', pg_temp.uid('PF'), pg_temp.epoch() + 1)));

select is(
  (pg_temp.r('E_pig') ->> 'state') || ' ' || (pg_temp.r('E_pig') ->> 'token'),
  'PT409 pig_changed',
  'R2-20: a stale expectedEpoch raises PT409 pig_changed'
);

select ok(
  (pg_temp.r('E_pig') -> 'hint' ->> 'pigEpoch')::bigint = pg_temp.epoch()
  and (pg_temp.r('E_pig') -> 'hint' ->> 'level')::integer = pg_temp.level(),
  'R2-20: the pig_changed hint carries the current pigEpoch and level'
);

select is(pg_temp.balance(pg_temp.uid('PF')), 2000::bigint, 'pig_changed charges nothing');

select public.donate(pg_temp.uid('PF'), 1950, '00000000-0000-4000-8000-00000022e0f1', 100, 600);
select pg_temp.keep('E_funds', pg_temp.err(format('select pg_temp.start(%L)', pg_temp.uid('PF'))));

select ok(
  pg_temp.r('E_funds') ->> 'state' = 'PT402' and pg_temp.r('E_funds') ->> 'token' = 'insufficient_funds'
  and (pg_temp.r('E_funds') -> 'hint' ->> 'balanceCents')::bigint = 50
  and (pg_temp.r('E_funds') -> 'hint' ->> 'priceCents')::bigint = 100,
  'a balance below the price raises PT402 insufficient_funds with the balance and price in the hint'
);

select ok(
  pg_temp.balance(pg_temp.uid('PF')) = 50
  and not exists (select 1 from public.attempts where user_id = pg_temp.uid('PF')),
  'insufficient_funds charges nothing'
);

select pg_temp.snap('treasury', pg_temp.treasury());
select pg_temp.snap('reserved', pg_temp.reserved());
select pg_temp.snap('settled', pg_temp.settled());

select is(
  pg_temp.raises(format('select pg_temp.start(%L, p_reserve => 1000, p_cap => 1000, p_share => 8000)', pg_temp.uid('PG'))),
  'PT503 spend_cap',
  'R1-09: a reservation over the attempts'' share of the cap raises PT503 spend_cap'
);

update public.ai_spend set hardening_reserved_micros = 5000 where day = current_date;
select is(
  pg_temp.raises(format('select pg_temp.start(%L, p_reserve => 1000, p_cap => %s, p_share => 10000)',
                        pg_temp.uid('PG'), pg_temp.reserved() + pg_temp.settled() + 1000 + 4999)),
  'PT503 spend_cap',
  'R1-09: a reservation within the share but over the whole daily cap (hardening included) raises PT503 spend_cap'
);
update public.ai_spend set hardening_reserved_micros = 0 where day = current_date;

select ok(
  pg_temp.balance(pg_temp.uid('PG')) = 2000
  and pg_temp.treasury() = pg_temp.was('treasury')
  and pg_temp.reserved() = pg_temp.was('reserved')
  and not exists (select 1 from public.attempts where user_id = pg_temp.uid('PG'))
  and not exists (select 1 from public.rate_limits where user_id = pg_temp.uid('PG') and tokens < 100 and bucket = 'attempt'),
  'spend_cap rolls the whole transaction back: fee, attempt, reservation, and token'
);

select is(
  array[
    pg_temp.raises(format('select public.start_attempt(%L, gen_random_uuid(), 1, ''x'', %L, %L, 1000, 1000000, 8000, 10, 6, 150, 10)', pg_temp.uid('PG'), pg_temp.hex64(), pg_temp.hex64())),
    pg_temp.raises(format('select public.start_attempt(%L, gen_random_uuid(), 1, ''x'', %L, %L, 0, 1000000, 8000, 10, 6, 150, 45)', pg_temp.uid('PG'), pg_temp.hex64(), pg_temp.hex64())),
    pg_temp.raises(format('select public.start_attempt(%L, gen_random_uuid(), 1, ''x'', ''abc'', %L, 1000, 1000000, 8000, 10, 6, 150, 45)', pg_temp.uid('PG'), pg_temp.hex64())),
    pg_temp.raises(format('select public.start_attempt(%L, gen_random_uuid(), 1, '''', %L, %L, 1000, 1000000, 8000, 10, 6, 150, 45)', pg_temp.uid('PG'), pg_temp.hex64(), pg_temp.hex64())),
    pg_temp.raises(format('select public.start_attempt(%L, gen_random_uuid(), 0, ''x'', %L, %L, 1000, 1000000, 8000, 10, 6, 150, 45)', pg_temp.uid('PG'), pg_temp.hex64(), pg_temp.hex64())),
    pg_temp.raises(format('select public.start_attempt(%L, gen_random_uuid(), 1, ''x'', %L, %L, 1000, 1000000, 10001, 10, 6, 150, 45)', pg_temp.uid('PG'), pg_temp.hex64(), pg_temp.hex64())),
    pg_temp.raises(format('select public.start_attempt(%L, gen_random_uuid(), 1, ''x'', %L, %L, 1000, 1000000, 8000, 0, 6, 150, 45)', pg_temp.uid('PG'), pg_temp.hex64(), pg_temp.hex64())),
    pg_temp.raises(format('select public.start_attempt(%L, null, 1, ''x'', %L, %L, 1000, 1000000, 8000, 10, 6, 150, 45)', pg_temp.uid('PG'), pg_temp.hex64(), pg_temp.hex64()))
  ],
  array_fill('PT422 invariant_violation'::text, array[8]),
  'out-of-bounds parameters raise PT422: stale seconds, reservation, hash, prompt, epoch, share, capacity, key'
);

select is(
  pg_temp.raises(format('select public.start_attempt(%L, gen_random_uuid(), 1, ''x'', %L, %L, 1000, 1000000, 8000, 10, 6, 150, 301)', pg_temp.uid('PG'), pg_temp.hex64(), pg_temp.hex64())),
  'PT422 invariant_violation',
  'p_stale_seconds above 300 raises PT422'
);

select is(pg_temp.balance(pg_temp.uid('PG')), 2000::bigint, 'invalid calls charge nothing');

-- ---------------------------------------------------------------------------
-- record_attempt invariants (T12, CH-6b): 14 tests
-- ---------------------------------------------------------------------------
select pg_temp.keep('K1', pg_temp.start_full(pg_temp.uid('PK')));

select is(
  pg_temp.raises(format('select pg_temp.rec(%L, ''win'', p_tool => false)', pg_temp.id('K1'))),
  'PT422 invariant_violation',
  'T12: a win without tool_called raises PT422'
);

select is(
  pg_temp.raises(format('select pg_temp.rec(%L, ''win'', p_canary => true)', pg_temp.id('K1'))),
  'PT422 invariant_violation',
  'T12: a win with canary_leaked raises PT422'
);

select is(
  array[
    pg_temp.raises(format('select pg_temp.rec(%L, ''leak_blocked'', p_canary => false)', pg_temp.id('K1'))),
    pg_temp.raises(format('select pg_temp.rec(%L, ''blocked'', p_tool => true)', pg_temp.id('K1')))
  ],
  array_fill('PT422 invariant_violation'::text, array[2]),
  'leak_blocked needs canary_leaked, and blocked needs no tool call'
);

select is(
  array[
    pg_temp.raises(format('select pg_temp.rec(%L, ''error'')', pg_temp.id('K1'))),
    pg_temp.raises(format('select pg_temp.rec(%L, ''error'', ''incomplete'')', pg_temp.id('K1'))),
    pg_temp.raises(format('select pg_temp.rec(%L, ''error'', ''content_filter'')', pg_temp.id('K1'))),
    pg_temp.raises(format('select pg_temp.rec(%L, ''error'', ''Bad-Code'')', pg_temp.id('K1')))
  ],
  array_fill('PT422 invariant_violation'::text, array[4]),
  'R2-01: error needs a well-formed system error code and never takes one an attacker can produce'
);

select is(
  array[
    pg_temp.raises(format('select pg_temp.rec(%L, ''win'', ''upstream_error'')', pg_temp.id('K1'))),
    pg_temp.raises(format('select pg_temp.rec(%L, ''blocked'', ''incomplete'')', pg_temp.id('K1'))),
    pg_temp.raises(format('select pg_temp.rec(%L, ''leak_blocked'', ''incomplete'')', pg_temp.id('K1'))),
    pg_temp.raises(format('select pg_temp.rec(%L, ''fail'', ''banana_split'')', pg_temp.id('K1')))
  ],
  array_fill('PT422 invariant_violation'::text, array[4]),
  'win, blocked, and leak_blocked reject a detail code; fail rejects one outside its list'
);

select is(
  array[
    pg_temp.raises(format('select pg_temp.rec(%L, ''fail'', p_block => true)', pg_temp.id('K1'))),
    pg_temp.raises(format('select pg_temp.rec(%L, ''blocked'', p_block => true)', pg_temp.id('K1'))),
    pg_temp.raises(format('select pg_temp.rec(%L, ''leak_blocked'', p_block => true)', pg_temp.id('K1'))),
    pg_temp.raises(format('select pg_temp.rec(%L, ''error'', ''upstream_error'', p_block => true)', pg_temp.id('K1')))
  ],
  array_fill('PT422 invariant_violation'::text, array[4]),
  'CH-6b: p_block_fingerprint with any outcome other than win raises PT422'
);

select is(
  array[
    pg_temp.raises(format('select pg_temp.rec(%L, ''pending'')', pg_temp.id('K1'))),
    pg_temp.raises(format('select pg_temp.rec(%L, ''late_win'', p_tool => true)', pg_temp.id('K1'))),
    pg_temp.raises(format('select pg_temp.rec(%L, ''fail'', p_jobs => 0)', pg_temp.id('K1'))),
    pg_temp.raises(format('select pg_temp.rec(%L, ''fail'', p_jobs => 21)', pg_temp.id('K1'))),
    pg_temp.raises(format('select pg_temp.rec(%L, ''fail'', p_cost => -1)', pg_temp.id('K1')))
  ],
  array_fill('PT422 invariant_violation'::text, array[5]),
  'pending and late_win are never inputs; the job cap is 1..20 and the cost is not negative'
);

select is(
  array[
    pg_temp.raises(format($q$select public.record_attempt(%L, 'fail', null, '{}', '{}', 1.5, null, false, false, 0, null, false, 3)$q$, pg_temp.id('K1'))),
    pg_temp.raises(format($q$select public.record_attempt(%L, 'fail', null, '{Bad Code}', '{}', null, null, false, false, 0, null, false, 3)$q$, pg_temp.id('K1'))),
    pg_temp.raises(format($q$select public.record_attempt(%L, 'fail', null, '{}', '{}', null, null, null, false, 0, null, false, 3)$q$, pg_temp.id('K1')))
  ],
  array_fill('PT422 invariant_violation'::text, array[3]),
  'a tripwire probability outside 0..1, a malformed reason code, or a null flag raises PT422'
);

select is(
  pg_temp.raises('select pg_temp.rec(gen_random_uuid(), ''fail'')'),
  'PT404 not_found',
  'record_attempt for an unknown attempt raises PT404'
);

select is(pg_temp.outcome(pg_temp.id('K1')), 'pending', 'every refused finalize left the attempt pending');

select pg_temp.keep('K1_rec', pg_temp.rec(pg_temp.id('K1'), 'fail', 'incomplete'));

select is(
  (select format('%s|%s', a.outcome, a.error_code) from public.attempts as a where a.id = pg_temp.id('K1')),
  'fail|incomplete',
  'R2-01: fail accepts a detail code such as incomplete (a charged failure)'
);

select is(
  pg_temp.raises(format('select pg_temp.rec(%L, ''fail'')', pg_temp.id('K1'))),
  'PT409 already_finalized',
  'T12: a double finalize raises PT409 already_finalized'
);

select is(
  array[
    pg_temp.raises(format('select pg_temp.rec(%L, ''win'')', pg_temp.id('K1'))),
    pg_temp.raises(format('select pg_temp.rec(%L, ''error'', ''upstream_error'')', pg_temp.id('K1')))
  ],
  array_fill('PT409 already_finalized'::text, array[2]),
  'T12: neither a forged win nor an error can finalize it again'
);

select ok(
  pg_temp.cracks(pg_temp.uid('PK')) = 1 and pg_temp.balance(pg_temp.uid('PK')) = 1900,
  'the refused second finalizes changed no crack and no money'
);

-- ---------------------------------------------------------------------------
-- Cracks (CH-1, HC-A5): 7 tests
-- ---------------------------------------------------------------------------
select pg_temp.snap('feed', pg_temp.feed_max());
select pg_temp.keep('H1', pg_temp.rec(pg_temp.start(pg_temp.uid('PH')), 'fail'));
select pg_temp.keep('H2', pg_temp.rec(pg_temp.start(pg_temp.uid('PH')), 'blocked'));
select pg_temp.keep('H3', pg_temp.rec(pg_temp.start(pg_temp.uid('PH')), 'leak_blocked'));
select pg_temp.keep('H4', pg_temp.rec(pg_temp.start(pg_temp.uid('PH')), 'fail'));

select is(
  array[pg_temp.r('H1') ->> 'crack_event', pg_temp.r('H2') ->> 'crack_event',
        pg_temp.r('H3') ->> 'crack_event', pg_temp.r('H4') ->> 'crack_event'],
  array['crack', 'crack', 'shatter', 'none'],
  'CH-1: fail, blocked, and leak_blocked give the events crack, crack, shatter, then none'
);

select is(
  array[(pg_temp.r('H1') ->> 'cracks_after')::integer, (pg_temp.r('H2') ->> 'cracks_after')::integer,
        (pg_temp.r('H3') ->> 'cracks_after')::integer, (pg_temp.r('H4') ->> 'cracks_after')::integer],
  array[1, 2, 3, 3],
  'CH-1: each failed attempt adds one crack, capped at 3'
);

select is(pg_temp.cracks(pg_temp.uid('PH')), 3::smallint, 'the wallet keeps 3 cracks: nothing resets them at 3');

select is(
  (select string_agg(format('%s:%s', a.crack_event, a.cracks_after), ',' order by a.cracks_after, a.crack_event = 'none'::public.crack_event)
   from public.attempts as a where a.user_id = pg_temp.uid('PH')),
  'crack:1,crack:2,shatter:3,none:3',
  'each attempt stores its crack event and the count after it'
);

select is(
  (select string_agg(f.outcome::text, ',' order by f.id) from public.live_feed as f
   where f.id > pg_temp.was('feed') and f.player_id = pg_temp.uid('PH') and f.event_type = 'attempt'),
  'fail,blocked,leak_blocked,fail',
  'every finalized non-error attempt writes one attempt feed row'
);

select pg_temp.keep('H5', pg_temp.rec(pg_temp.start(pg_temp.uid('PH')), 'error', 'upstream_timeout'));

select ok(
  pg_temp.r('H5') ->> 'crack_event' = 'none' and (pg_temp.r('H5') ->> 'cracks_after')::integer = 3
  and pg_temp.cracks(pg_temp.uid('PH')) = 3,
  'CH-1: an error leaves the cracks unchanged and reports the current count (R3-13)'
);

select ok(
  (select count(*) from public.live_feed as f
   where f.id > pg_temp.was('feed') and f.player_id = pg_temp.uid('PH')) = 4,
  'the error wrote no feed row'
);

-- ---------------------------------------------------------------------------
-- The error path (R2-04, R2-01, R3-07): 10 tests
-- ---------------------------------------------------------------------------
select pg_temp.keep('I1', pg_temp.start_full(pg_temp.uid('PI'), p_reserve => 1000));
select pg_temp.snap('reserved', pg_temp.reserved());
select pg_temp.snap('settled', pg_temp.settled());
select pg_temp.snap('feed', pg_temp.feed_max());
select pg_temp.keep('I1_rec', pg_temp.rec(pg_temp.id('I1'), 'error', 'upstream_error', p_cost => 700));

select is(
  format('%s|%s|%s', pg_temp.r('I1_rec') ->> 'outcome', pg_temp.r('I1_rec') ->> 'refund_cents', pg_temp.r('I1_rec') ->> 'refund_withheld'),
  'error|100|false',
  'R2-04: record_attempt error returns the error outcome with the refund'
);

select ok(
  pg_temp.reserved() = pg_temp.was('reserved') - 1000 and pg_temp.settled() = pg_temp.was('settled') + 700,
  'R2-04: one error record releases exactly reserved_micros once and records the actual cost'
);

select is(
  (select format('%s|%s|%s|%s|%s|%s|%s', a.outcome, a.error_code, a.refund_cents, a.refund_withheld, a.cost_micros,
                 a.crack_event, a.finalized_at is not null)
   from public.attempts as a where a.id = pg_temp.id('I1')),
  'error|upstream_error|100|f|700|none|t',
  'the attempt is finalized with its code, refund, and actual cost'
);

select ok(
  pg_temp.balance(pg_temp.uid('PI')) = 2000 and pg_temp.cracks(pg_temp.uid('PI')) = 0
  and (select in_flight_attempt_id from public.wallets where user_id = pg_temp.uid('PI')) is null,
  'the refund makes the player whole, cracks are unchanged, and the in-flight marker is cleared'
);

select is(
  (select count(*)::integer from public.live_feed as f where f.id > pg_temp.was('feed')),
  0,
  'R2-04: an error writes no live_feed row'
);

select (pg_temp.rec(pg_temp.start(pg_temp.uid('PI')), 'error', 'upstream_config') ->> 'refund_cents');
select (pg_temp.rec(pg_temp.start(pg_temp.uid('PI')), 'error', 'upstream_error') ->> 'refund_cents');
select pg_temp.keep('I4', pg_temp.rec(pg_temp.start(pg_temp.uid('PI')), 'error', 'upstream_error'));

select ok(
  (pg_temp.r('I4') ->> 'refund_withheld')::boolean = true and (pg_temp.r('I4') ->> 'refund_cents')::bigint = 0
  and pg_temp.balance(pg_temp.uid('PI')) = 1900,
  'R2-01: the fourth system error in an hour keeps the fee and sets refund_withheld'
);

select is(pg_temp.cracks(pg_temp.uid('PI')), 0::smallint, 'a withheld refund adds no crack either');

select pg_temp.snap('feed', pg_temp.feed_max());
select pg_temp.keep('I2', pg_temp.rec(pg_temp.start(pg_temp.uid('PI2')), 'fail', p_reply => repeat('x', 1300)));

select is(
  format('%s|%s', pg_temp.r('I2') ->> 'outcome', pg_temp.r('I2') ->> 'refund_cents'),
  'error|100',
  'R3-07: a reply that cannot be stored settles as an error, refunded within the budget'
);

select is(
  (select format('%s|%s|%s', a.outcome, a.error_code, a.reply is null)
   from public.attempts as a where a.user_id = pg_temp.uid('PI2')),
  'error|reply_unstorable|t',
  'R3-07: the attempt records reply_unstorable and stores no reply'
);

select ok(
  pg_temp.cracks(pg_temp.uid('PI2')) = 0
  and (select count(*) from public.live_feed as f where f.id > pg_temp.was('feed')) = 0
  and (select count(*) from public.attempts as a where a.user_id = pg_temp.uid('PI2') and a.refund_cents > 0) = 1,
  'R3-07: no crack and no feed row, and the refund counts against the budget'
);

-- ---------------------------------------------------------------------------
-- Paid wins, late wins, fingerprints, jobs, and breach rows
-- (CH-1, CH-6b, R1-03, section 9.1): 24 tests
-- ---------------------------------------------------------------------------
select pg_temp.snap('epoch0', pg_temp.epoch());
select pg_temp.snap('level0', pg_temp.level());
select pg_temp.keep('L1', pg_temp.start_full(pg_temp.uid('PL')));                -- races the win below
select pg_temp.rec(pg_temp.start(pg_temp.uid('PX')), 'fail');
select pg_temp.rec(pg_temp.start(pg_temp.uid('PX')), 'blocked');
select pg_temp.keep('W1', pg_temp.start_full(pg_temp.uid('PW'), p_fp => repeat('ab', 32)));
select pg_temp.snap('treasury', pg_temp.treasury());
select pg_temp.snap('pw_balance', pg_temp.balance(pg_temp.uid('PW')));
select pg_temp.snap('feed', pg_temp.feed_max());
select pg_temp.snap('total_wins', (select total_wins from public.game_state where id = 1));
select pg_temp.snap('paid_out', (select total_paid_out_cents from public.game_state where id = 1));
select pg_temp.snap('reserved', pg_temp.reserved());
select pg_temp.snap('settled', pg_temp.settled());
select pg_temp.keep('W1_rec', pg_temp.rec(pg_temp.id('W1'), 'win', p_block => true, p_cost => 800));

select is(pg_temp.r('W1_rec') ->> 'outcome', 'win', 'a win whose pinned epoch is current is a paid win');

select ok(
  pg_temp.was('treasury') >= 400
  and (pg_temp.r('W1_rec') ->> 'payout_cents')::bigint = pg_temp.was('treasury')
  and pg_temp.balance(pg_temp.uid('PW')) = pg_temp.was('pw_balance') + pg_temp.was('treasury')
  and (pg_temp.r('W1_rec') ->> 'wallet_balance_cents')::bigint = pg_temp.balance(pg_temp.uid('PW')),
  'CH-1: the winner receives the whole treasury'
);

select ok(
  pg_temp.treasury() = 0 and (pg_temp.r('W1_rec') ->> 'treasury_cents')::bigint = 0,
  'CH-1: the treasury resets to treasury_seed_cents (0)'
);

select ok(
  pg_temp.level() = pg_temp.was('level0') + 1 and pg_temp.epoch() = pg_temp.was('epoch0') + 1
  and (pg_temp.r('W1_rec') ->> 'level_from')::bigint = pg_temp.was('level0')
  and (pg_temp.r('W1_rec') ->> 'level_to')::bigint = pg_temp.was('level0') + 1
  and (pg_temp.r('W1_rec') ->> 'current_level')::bigint = pg_temp.level()
  and (pg_temp.r('W1_rec') ->> 'pig_epoch')::bigint = pg_temp.epoch(),
  'R1-03: the pig advances one level and pig_epoch increments'
);

select ok(
  (select total_wins from public.game_state where id = 1) = pg_temp.was('total_wins') + 1
  and (select total_paid_out_cents from public.game_state where id = 1) = pg_temp.was('paid_out') + pg_temp.was('treasury')
  and (select total_wins from public.wallets where user_id = pg_temp.uid('PW')) = 1,
  'the game and wallet totals count the paid win and the payout'
);

select is(
  (select format('%s|%s|%s|%s|%s', l.kind, l.from_account, l.to_account, l.amount_cents, l.external_ref)
   from public.ledger_entries as l where l.attempt_id = pg_temp.id('W1') and l.kind = 'payout'),
  format('payout|treasury|player:%s|%s|payout:%s', pg_temp.uid('PW'), pg_temp.was('treasury'), pg_temp.id('W1')),
  'the payout is one ledger row from the treasury with external_ref payout:<attempt id>'
);

select is(
  (select string_agg(format('%s:%s:%s:%s', f.event_type, f.level_id, coalesce(f.outcome::text, '-'), coalesce(f.amount_cents::text, '-')), ',' order by f.id)
   from public.live_feed as f where f.id > pg_temp.was('feed')),
  format('attempt:%s:win:%s,level_advanced:%s:-:-', pg_temp.was('level0'), pg_temp.was('treasury'), pg_temp.was('level0') + 1),
  'a paid win writes the attempt feed row (with the payout) and the level_advanced row'
);

select is(
  (select format('%s|%s|%s|%s|%s|%s', j.level_id, j.trigger, j.status, j.user_id, j.prompt_sha256 = a.prompt_sha256,
                 j.id = (pg_temp.r('W1_rec') ->> 'hardening_job_id')::uuid)
   from public.hardening_jobs as j join public.attempts as a on a.id = j.attempt_id
   where j.attempt_id = pg_temp.id('W1')),
  format('%s|win|queued|%s|t|t', pg_temp.was('level0'), pg_temp.uid('PW')),
  'CH-6b: a paid win creates one queued hardening job for the beaten level, and it is not processed'
);

select is(
  (select format('%s|%s', b.level_id, b.attempt_id) from public.blocked_fingerprints as b where b.fingerprint = repeat('ab', 32)),
  format('%s|%s', pg_temp.was('level0'), pg_temp.id('W1')),
  'CH-6b: p_block_fingerprint on a paid win blocks the prompt fingerprint'
);

select is(
  (select format('%s|%s|%s', g.kind, g.level_id, g.source) from public.golden_prompts as g where g.attempt_id = pg_temp.id('W1')),
  format('breach|%s|breach_auto', pg_temp.was('level0')),
  'HC-A3: a paid win records its breach row in golden_prompts'
);

select ok(
  pg_temp.r('W1_rec') ->> 'crack_event' = 'none' and pg_temp.cracks(pg_temp.uid('PW')) = 0
  and (select in_flight_attempt_id from public.wallets where user_id = pg_temp.uid('PW')) is null,
  'CH-1: a win leaves the cracks unchanged and clears the in-flight marker'
);

select ok(
  pg_temp.reserved() = pg_temp.was('reserved') - 1000 and pg_temp.settled() = pg_temp.was('settled') + 800,
  'the win settles its spend once, last'
);

select pg_temp.keep('Y1', pg_temp.start_full(pg_temp.uid('PY'), p_fp => repeat('ab', 32)));

select ok(
  (pg_temp.r('Y1') ->> 'fingerprint_blocked')::boolean = true
  and (select reserved_micros from public.attempts where id = pg_temp.id('Y1')) = 0,
  'CH-6b: the next start_attempt with that fingerprint returns fingerprint_blocked true and reserves no spend'
);

select pg_temp.rec(pg_temp.id('Y1'), 'blocked');

-- The attempt that started before the win.
select pg_temp.snap('treasury', pg_temp.treasury());
select pg_temp.snap('pl_balance', pg_temp.balance(pg_temp.uid('PL')));
select pg_temp.snap('epoch1', pg_temp.epoch());
select pg_temp.snap('level1', pg_temp.level());
select pg_temp.snap('feed', pg_temp.feed_max());
select pg_temp.keep('L1_rec', pg_temp.rec(pg_temp.id('L1'), 'win', p_block => true));

select ok(
  pg_temp.r('L1_rec') ->> 'outcome' = 'late_win' and (pg_temp.r('L1_rec') ->> 'payout_cents')::bigint = 0
  and pg_temp.outcome(pg_temp.id('L1')) = 'late_win',
  'R1-03: a second win for the same epoch becomes late_win with no payout'
);

select ok(
  pg_temp.treasury() = pg_temp.was('treasury') and pg_temp.balance(pg_temp.uid('PL')) = pg_temp.was('pl_balance')
  and pg_temp.epoch() = pg_temp.was('epoch1') and pg_temp.level() = pg_temp.was('level1')
  and pg_temp.r('L1_rec') -> 'level_to' = 'null'::jsonb,
  'a late win moves no money and leaves the pig as it is'
);

select ok(
  not exists (select 1 from public.blocked_fingerprints where attempt_id = pg_temp.id('L1'))
  and not exists (select 1 from public.hardening_jobs where attempt_id = pg_temp.id('L1'))
  and not exists (select 1 from public.golden_prompts where attempt_id = pg_temp.id('L1')),
  'CH-6b: a late win creates no fingerprint, no job, and no breach row'
);

select ok(
  pg_temp.r('L1_rec') ->> 'crack_event' = 'none' and pg_temp.cracks(pg_temp.uid('PL')) = 0
  and (select string_agg(f.outcome::text, ',') from public.live_feed as f where f.id > pg_temp.was('feed')) = 'late_win',
  'a late win leaves the cracks unchanged and writes one late_win feed row'
);

select is(
  (select count(*)::integer from public.attempts where pig_epoch = pg_temp.was('epoch0') and outcome = 'win'),
  1,
  'exactly one paid win for the epoch'
);

-- The per-user job cap and the hardening switch.
select pg_temp.keep('J1', pg_temp.rec(pg_temp.start(pg_temp.uid('PJ')), 'win', p_jobs => 1));
select pg_temp.keep('J2', pg_temp.rec(pg_temp.start(pg_temp.uid('PJ')), 'win', p_jobs => 1));

select ok(
  pg_temp.r('J1') ->> 'outcome' = 'win' and pg_temp.r('J1') ->> 'hardening_job_id' is not null,
  'the first paid win of the hour creates a job'
);

select ok(
  pg_temp.r('J2') ->> 'outcome' = 'win' and pg_temp.r('J2') -> 'hardening_job_id' = 'null'::jsonb
  and (select count(*) from public.hardening_jobs where user_id = pg_temp.uid('PJ')) = 1,
  'the per-user job cap (p_user_jobs_per_hour) is honoured: the second paid win is still paid but creates no job'
);

-- Level 4 now: the secret payload comes back with the start.
select pg_temp.keep('P4a', pg_temp.start_full(pg_temp.uid('P4')));

select ok(
  pg_temp.level() = 4 and (pg_temp.r('P4a') ->> 'level_id')::integer = 4
  and (pg_temp.r('P4a') -> 'level_secret') = (select ls.payload from public.level_secrets as ls where ls.level_id = 4),
  'R2-12: at level 4 start_attempt returns the level_secrets payload'
);

update public.app_config set value = 'false' where key = 'hardening_enabled';
select pg_temp.keep('P4a_rec', pg_temp.rec(pg_temp.id('P4a'), 'win', p_block => true));
update public.app_config set value = 'true' where key = 'hardening_enabled';

select ok(
  pg_temp.r('P4a_rec') ->> 'outcome' = 'win'
  and not exists (select 1 from public.hardening_jobs where attempt_id = pg_temp.id('P4a'))
  and exists (select 1 from public.blocked_fingerprints where attempt_id = pg_temp.id('P4a'))
  and exists (select 1 from public.golden_prompts where attempt_id = pg_temp.id('P4a')),
  'with hardening_enabled off a paid win still blocks its fingerprint and records its breach row, but queues no job'
);

-- Level 5: the top, with a treasury seed.
update public.app_config set value = '25' where key = 'treasury_seed_cents';
select pg_temp.keep('S1', pg_temp.start_full(pg_temp.uid('PS')));
select pg_temp.snap('epoch5', pg_temp.epoch());
select pg_temp.snap('feed', pg_temp.feed_max());
select pg_temp.keep('S1_rec', pg_temp.rec(pg_temp.id('S1'), 'win'));
update public.app_config set value = '0' where key = 'treasury_seed_cents';

select ok(
  (pg_temp.r('S1') -> 'level_secret') = (select ls.payload from public.level_secrets as ls where ls.level_id = 5)
  and (pg_temp.r('S1') ->> 'level_id')::integer = 5,
  'R2-12: at level 5 start_attempt returns the level 5 secret payload'
);

select ok(
  pg_temp.r('S1_rec') ->> 'outcome' = 'win' and pg_temp.level() = 5
  and pg_temp.epoch() = pg_temp.was('epoch5') + 1
  and (pg_temp.r('S1_rec') ->> 'level_from')::integer = 5 and (pg_temp.r('S1_rec') ->> 'level_to')::integer = 5,
  'section 9.1: at level 5 the level stays 5 and the epoch still increments'
);

select ok(
  pg_temp.treasury() = 25
  and (select format('%s|%s|%s|%s', l.from_account, l.to_account, l.amount_cents, l.external_ref)
       from public.ledger_entries as l where l.kind = 'mint_treasury_seed' and l.attempt_id = pg_temp.id('S1'))
      = format('mint|treasury|25|seed:epoch:%s', pg_temp.epoch())
  and not exists (select 1 from public.live_feed as f where f.id > pg_temp.was('feed') and f.event_type = 'level_advanced'),
  'the treasury resets to a non-zero seed through the ledger (seed:epoch:<n>), and a level 5 win writes no level_advanced row'
);

-- ---------------------------------------------------------------------------
-- level_not_configured (R2-12): 2 tests
-- ---------------------------------------------------------------------------
reset role;
create temporary table t_secret on commit drop as select * from public.level_secrets where level_id = 5;
delete from public.level_secrets where level_id = 5;
set local role service_role;

select is(
  pg_temp.raises(format('select pg_temp.start(%L)', pg_temp.uid('PN5'))),
  'PT503 level_not_configured',
  'R2-12: at level 5 without a level_secrets row start_attempt raises PT503 level_not_configured'
);

select ok(
  pg_temp.balance(pg_temp.uid('PN5')) = 2000 and not exists (select 1 from public.attempts where user_id = pg_temp.uid('PN5')),
  'R2-12: level_not_configured charges nothing'
);

reset role;
insert into public.level_secrets select * from t_secret;
set local role service_role;

-- ---------------------------------------------------------------------------
-- attempt_result (R2-05, R2-14): 6 tests
-- ---------------------------------------------------------------------------
select is(
  (select format('%s|%s|%s|%s|%s|%s|%s', r.outcome, r.payout_cents, r.level_id, r.level_to, r.cracks_after, r.crack_event, r.refund_cents)
   from public.attempt_result(pg_temp.uid('PW'), pg_temp.id('W1')) as r),
  format('win|%s|%s|%s|0|none|0', (pg_temp.r('W1_rec') ->> 'payout_cents'), pg_temp.was('level0'), pg_temp.was('level0') + 1),
  'R2-05: attempt_result returns the stored outcome, payout, level change, and cracks of a paid win'
);

select ok(
  (select r.wallet_balance_cents = pg_temp.balance(pg_temp.uid('PW')) and r.treasury_cents = pg_temp.treasury()
          and r.current_level = pg_temp.level() and r.pig_epoch = pg_temp.epoch()
          and r.aura_bps = (select aura_bps from public.wallets where user_id = pg_temp.uid('PW'))
   from public.attempt_result(pg_temp.uid('PW'), pg_temp.id('W1')) as r),
  'attempt_result carries the current wallet and game values'
);

select is(
  (select format('%s|%s|%s|%s|%s', r.outcome, r.refund_cents, r.refund_withheld, r.cracks_after, coalesce(r.level_to::text, '-'))
   from public.attempt_result(pg_temp.uid('PI'), pg_temp.id('I1')) as r),
  'error|100|f|0|-',
  'R2-14: attempt_result returns an error''s refund and cracks, and no level change'
);

select is(
  (select format('%s|%s|%s', r.outcome, r.payout_cents, coalesce(r.level_to::text, '-'))
   from public.attempt_result(pg_temp.uid('PL'), pg_temp.id('L1')) as r),
  'late_win|0|-',
  'attempt_result of a late win shows no payout and no level change'
);

select is_empty(
  format('select * from public.attempt_result(%L, %L)', pg_temp.uid('PA'), pg_temp.id('W1')),
  'attempt_result returns nothing for another player''s attempt'
);

select pg_temp.keep('R1', pg_temp.start_full(pg_temp.uid('PA')));

select is_empty(
  format('select * from public.attempt_result(%L, %L)', pg_temp.uid('PA'), pg_temp.id('R1')),
  'attempt_result returns nothing for a pending attempt'
);

select pg_temp.rec(pg_temp.id('R1'), 'fail');

-- ---------------------------------------------------------------------------
-- CH-6b and the ledger invariant over a scripted sequence (R2-19): 4 tests
-- ---------------------------------------------------------------------------
select is_empty(
  $$ select a.id from public.attempts as a
     where a.outcome <> 'win'
       and (exists (select 1 from public.hardening_jobs as j where j.attempt_id = a.id)
            or exists (select 1 from public.blocked_fingerprints as b where b.attempt_id = a.id)
            or exists (select 1 from public.golden_prompts as g where g.attempt_id = a.id)) $$,
  'CH-6b: fail, blocked, leak_blocked, late_win, and error created no job, no fingerprint, and no breach row'
);

create temporary table t_ops (n integer) on commit drop;
grant select, insert on t_ops to service_role;

do $$
declare
  v_users    uuid[] := array[pg_temp.uid('Q1'), pg_temp.uid('Q2'), pg_temp.uid('Q3')];
  v_outcomes text[] := array['fail', 'error', 'blocked', 'leak_blocked', 'fail', 'win'];
  v_user     uuid;
  v_id       uuid;
  v_outcome  text;
begin
  for i in 1..50 loop
    v_user := v_users[1 + (i % 3)];
    begin
      if i % 5 in (0, 1, 2) then
        v_id := pg_temp.start(v_user);
        v_outcome := v_outcomes[1 + (i % 6)];
        perform pg_temp.rec(v_id, v_outcome, case when v_outcome = 'error' then 'upstream_error' end,
                            p_block => v_outcome = 'win');
      elsif i % 5 = 3 then
        perform public.repair_glass(v_user, gen_random_uuid(), 100, 600);
      else
        perform public.donate(v_user, 1 + (i % 7), gen_random_uuid(), 100, 600);
      end if;
    exception when others then
      -- Only nothing_to_repair and insufficient_funds are expected refusals.
      if sqlstate not in ('PT409', 'PT402') then
        raise;
      end if;
    end;
    insert into t_ops values (i);
  end loop;
end
$$;

select is((select count(*)::integer from t_ops), 50, 'the scripted sequence ran 50 attempts, repairs, and donations');

select is_empty(
  'select * from pg_temp.ledger_problems()',
  'R2-19: for every wallet the journal equals the balance, the treasury matches, and wallets + treasury + orphaned accounts = minted - donated'
);

select is_empty(
  $$ select a.id from public.attempts as a
     where (select count(*) from public.ledger_entries as l where l.kind = 'attempt_fee' and l.attempt_id = a.id) <> 1
        or (a.outcome = 'win' and a.payout_cents > 0
            and (select count(*) from public.ledger_entries as l where l.kind = 'payout' and l.attempt_id = a.id) <> 1) $$,
  'CH-1: every attempt paid exactly one fee, and every paid win exactly one payout'
);

select * from finish();
rollback;
