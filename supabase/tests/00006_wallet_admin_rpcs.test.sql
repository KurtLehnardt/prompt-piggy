-- pgTAP tests for supabase/migrations/00006_wallet_admin_rpcs.sql (task PP-18).
--
-- Run with `pnpm db:test` against the local stack after `pnpm db:reset`.
-- Everything runs in one transaction that is rolled back, so nothing here
-- persists. Every address and prompt below is synthetic test data.
--
-- Fixtures are written as postgres; the functions under test are called
-- after `set local role service_role`, so the tests also prove their grants.
-- Where a fixture sets a balance directly, it says so: that only stages a
-- state, and every movement under test goes through private._post_ledger.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(97);

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

create temporary table t_ids (name text primary key, id uuid not null) on commit drop;

insert into t_ids (name, id) values
  ('ADMIN', '00000000-0000-4000-8000-0000000018a0'),   -- an admin id (admin_actions has no FK)
  ('P1', '00000000-0000-4000-8000-0000000018a1'),      -- error finalization and the refund budget
  ('P2', '00000000-0000-4000-8000-0000000018a2'),      -- reaper
  ('P3', '00000000-0000-4000-8000-0000000018a3'),      -- reaper
  ('P4', '00000000-0000-4000-8000-0000000018a4'),      -- reaper (fresh attempt)
  ('P5', '00000000-0000-4000-8000-0000000018a5'),      -- repair
  ('P6', '00000000-0000-4000-8000-0000000018a6'),      -- payout receiver; repair rate limit
  ('P7', '00000000-0000-4000-8000-0000000018a7'),      -- donate
  ('P8', '00000000-0000-4000-8000-0000000018a8'),      -- admin grant and hide
  ('P9', '00000000-0000-4000-8000-0000000018a9');      -- retention

create function pg_temp.uid(p_name text)
returns uuid
language sql
stable
as $$ select id from t_ids where name = p_name $$;

-- Stages what start_attempt (PP-22) does, as postgres: the fee through the
-- ledger, a pending attempt in the current epoch created p_age ago, the
-- spend reservation on current_date, and the in-flight marker. Returns the
-- attempt id.
create function pg_temp.start_fake(p_user uuid, p_reserved bigint default 1000, p_age interval default '0 seconds')
returns uuid
language plpgsql
as $$
declare
  v_id uuid := gen_random_uuid();
begin
  perform private._post_ledger('attempt_fee', 'player:' || p_user::text, 'treasury', 100, p_user, v_id, 'fee:' || v_id::text);
  insert into public.attempts (
    id, user_id, level_id, pig_epoch, rule_set_id, idempotency_key, prompt, prompt_sha256,
    prompt_fingerprint, prompt_chars, price_cents, reserved_micros, spend_day, created_at
  ) values (
    v_id, p_user, 1, (select g.pig_epoch from public.game_state as g where g.id = 1),
    (select rs.id from public.rule_sets as rs where rs.level_id = 1 and rs.state = 'active'),
    gen_random_uuid(), 'pp18 synthetic attempt prompt',
    md5(random()::text) || md5(random()::text), md5(random()::text) || md5(random()::text),
    29, 100, p_reserved, current_date, now() - p_age
  );
  insert into public.ai_spend (day) values (current_date) on conflict (day) do nothing;
  update public.ai_spend set attempt_reserved_micros = attempt_reserved_micros + p_reserved where day = current_date;
  update public.wallets set in_flight_attempt_id = v_id where user_id = p_user;
  return v_id;
end
$$;

-- Inserts a finalized synthetic attempt as postgres, created p_age ago.
create function pg_temp.add_attempt(p_user uuid, p_outcome text, p_epoch bigint, p_prompt text, p_age interval)
returns uuid
language sql
as $$
  insert into public.attempts (
    user_id, level_id, pig_epoch, rule_set_id, idempotency_key, prompt, prompt_sha256,
    prompt_fingerprint, prompt_chars, reply, outcome, price_cents, spend_day, created_at, finalized_at
  ) values (
    p_user, 1, p_epoch,
    (select rs.id from public.rule_sets as rs where rs.level_id = 1 and rs.state = 'active'),
    gen_random_uuid(), p_prompt,
    md5(random()::text) || md5(random()::text), md5(random()::text) || md5(random()::text),
    char_length(p_prompt), 'synthetic reply', p_outcome::public.attempt_outcome, 100, current_date,
    now() - p_age, case when p_outcome <> 'pending' then now() - p_age end
  )
  returning id;
$$;

grant execute on function pg_temp.raises(text) to anon, authenticated, service_role;
grant execute on function pg_temp.uid(text) to anon, authenticated, service_role;
grant select on t_ids to anon, authenticated, service_role;

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, is_anonymous)
select t.id, 'authenticated', 'authenticated', lower('pp18-' || t.name || '@example.test'),
       '{"provider": "email"}', '{}', false
from t_ids as t
where t.name like 'P%';

update public.app_config set value = '3' where key = 'refund_budget_per_hour';

-- Values captured before each step, compared after it.
create temporary table t_before (name text primary key, v bigint) on commit drop;
create function pg_temp.snap(p_name text, p_value bigint) returns void
language sql as $$ insert into t_before values (p_name, p_value) on conflict (name) do update set v = excluded.v $$;
create function pg_temp.was(p_name text) returns bigint
language sql stable as $$ select v from t_before where name = p_name $$;

create function pg_temp.balance(p_user uuid) returns bigint
language sql stable as $$ select balance_cents from public.wallets where user_id = p_user $$;
create function pg_temp.treasury() returns bigint
language sql stable as $$ select treasury_cents from public.game_state where id = 1 $$;
create function pg_temp.reserved() returns bigint
language sql stable as $$ select coalesce((select attempt_reserved_micros from public.ai_spend where day = current_date), 0) $$;
create function pg_temp.settled() returns bigint
language sql stable as $$ select coalesce((select attempt_settled_micros from public.ai_spend where day = current_date), 0) $$;
grant select on t_before to service_role;
grant execute on function pg_temp.was(text) to service_role;
grant execute on function pg_temp.balance(uuid) to service_role;
grant execute on function pg_temp.treasury() to service_role;
grant execute on function pg_temp.reserved() to service_role;
grant execute on function pg_temp.settled() to service_role;

-- ---------------------------------------------------------------------------
-- private._finalize_attempt_error (R2-01, R2-04): 19 tests
-- ---------------------------------------------------------------------------
insert into t_ids (name, id) values ('A1', pg_temp.start_fake(pg_temp.uid('P1'), 1000));
update public.wallets set crack_count = 2 where user_id = pg_temp.uid('P1');
select pg_temp.snap('p1', pg_temp.balance(pg_temp.uid('P1')));
select pg_temp.snap('treasury', pg_temp.treasury());
select pg_temp.snap('reserved', pg_temp.reserved());
select pg_temp.snap('settled', pg_temp.settled());

set local role service_role;
select results_eq(
  format($$ select refund_cents, refund_withheld from private._finalize_attempt_error(%L, 'upstream_error', 700) $$, pg_temp.uid('A1')),
  $$ values (100::bigint, false) $$,
  'R2-04: _finalize_attempt_error refunds price_cents and reports no withholding'
);
reset role;
select results_eq(
  $$ select outcome::text, error_code, refund_cents, refund_withheld, cost_micros, finalized_at = now(), crack_event::text, cracks_after::integer
     from public.attempts where id = pg_temp.uid('A1') $$,
  $$ values ('error'::text, 'upstream_error'::text, 100::bigint, false, 700::bigint, true, 'none'::text, 2) $$,
  'the attempt is finalized as error with its code, refund, cost, and finalized_at'
);
select is(pg_temp.balance(pg_temp.uid('P1')), pg_temp.was('p1') + 100, 'the player gets the 100-cent price back');
select is(pg_temp.treasury(), pg_temp.was('treasury') - 100, 'R2-04: the refund comes from the treasury while the epoch is current');
select results_eq(
  format($$ select kind, from_account, to_account, amount_cents from public.ledger_entries where external_ref = 'refund:%s' $$, pg_temp.uid('A1')),
  format($$ values ('attempt_refund'::text, 'treasury'::text, 'player:%s'::text, 100::bigint) $$, pg_temp.uid('P1')),
  'the refund is one attempt_refund ledger row with external_ref refund:<attempt id>'
);
select is((select crack_count::integer from public.wallets where user_id = pg_temp.uid('P1')), 2, 'cracks are unchanged by an error');
select is((select in_flight_attempt_id from public.wallets where user_id = pg_temp.uid('P1')), null::uuid,
  'in_flight_attempt_id is cleared');
select is(pg_temp.reserved(), pg_temp.was('reserved') - 1000,
  'R2-04: attempt_reserved_micros decreases by exactly the attempt''s reserved_micros');
select is(pg_temp.settled(), pg_temp.was('settled') + 700, 'R2-04: attempt_settled_micros increases by the actual spend');

set local role service_role;
select is(pg_temp.raises(format($$ select * from private._finalize_attempt_error(%L, 'upstream_error', 700) $$, pg_temp.uid('A1'))),
  'PT409 already_finalized', 'R2-04: a second call raises PT409 already_finalized');
reset role;
select is((select count(*)::integer from public.ledger_entries where attempt_id = pg_temp.uid('A1') and kind = 'attempt_refund'), 1,
  'the second call refunded nothing');

-- A payout empties the pot and moves the pig on; the attempt's epoch is old.
insert into t_ids (name, id) values ('A2', pg_temp.start_fake(pg_temp.uid('P1'), 1000));
select private._post_ledger('payout', 'treasury', 'player:' || pg_temp.uid('P6')::text, pg_temp.treasury(),
                            pg_temp.uid('P6'), null, 'payout:pp18-test-payout')
where pg_temp.treasury() > 0;
update public.game_state set pig_epoch = pig_epoch + 1 where id = 1;
select pg_temp.snap('p1', pg_temp.balance(pg_temp.uid('P1')));

set local role service_role;
select results_eq(
  format($$ select refund_cents, refund_withheld from private._finalize_attempt_error(%L, 'upstream_timeout', 0) $$, pg_temp.uid('A2')),
  $$ values (100::bigint, false) $$,
  'R2-04: an error after a payout is still refunded'
);
reset role;
select results_eq(
  format($$ select kind, from_account, amount_cents from public.ledger_entries where external_ref = 'refund:%s' $$, pg_temp.uid('A2')),
  $$ values ('refund_mint'::text, 'mint'::text, 100::bigint) $$,
  'R2-04: after a payout the refund is minted (refund_mint), so the winner keeps the pot'
);
select ok(pg_temp.treasury() = 0 and pg_temp.balance(pg_temp.uid('P1')) = pg_temp.was('p1') + 100,
  'the treasury is untouched and the player is made whole');

-- The refund budget: P1 has 2 refunds this hour; the third is refunded and
-- the fourth keeps the fee.
insert into t_ids (name, id) values ('A3', pg_temp.start_fake(pg_temp.uid('P1'), 0));
set local role service_role;
select results_eq(
  format($$ select refund_cents, refund_withheld from private._finalize_attempt_error(%L, 'upstream_config', 0) $$, pg_temp.uid('A3')),
  $$ values (100::bigint, false) $$,
  'R2-01: the third error within an hour is still inside a budget of 3'
);
reset role;
insert into t_ids (name, id) values ('A4', pg_temp.start_fake(pg_temp.uid('P1'), 0));
select pg_temp.snap('p1', pg_temp.balance(pg_temp.uid('P1')));
set local role service_role;
select results_eq(
  format($$ select refund_cents, refund_withheld from private._finalize_attempt_error(%L, 'upstream_error', 0) $$, pg_temp.uid('A4')),
  $$ values (0::bigint, true) $$,
  'R2-01: the fourth error for one user within an hour keeps the fee and sets refund_withheld'
);
reset role;
select ok(
  pg_temp.balance(pg_temp.uid('P1')) = pg_temp.was('p1')
  and not exists (select 1 from public.ledger_entries where external_ref = 'refund:' || pg_temp.uid('A4')::text)
  and (select refund_withheld and refund_cents = 0 and outcome = 'error' from public.attempts where id = pg_temp.uid('A4')),
  'R2-01: over the budget no money moves, and the attempt records refund_withheld'
);
select is((select crack_count::integer from public.wallets where user_id = pg_temp.uid('P1')), 2,
  'R2-01: a withheld refund adds no crack');
select ok(
  not has_function_privilege('anon', 'private._finalize_attempt_error(uuid, text, bigint)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private._finalize_attempt_error(uuid, text, bigint)', 'EXECUTE')
  and has_function_privilege('service_role', 'private._finalize_attempt_error(uuid, text, bigint)', 'EXECUTE'),
  'R2-04: anon and authenticated cannot execute _finalize_attempt_error; service_role can'
);

-- ---------------------------------------------------------------------------
-- reap_stale_attempts (R1-18, R2-13): 8 tests
-- ---------------------------------------------------------------------------
insert into t_ids (name, id) values
  ('S1', pg_temp.start_fake(pg_temp.uid('P2'), 800, '60 seconds')),
  ('S2', pg_temp.start_fake(pg_temp.uid('P3'), 900, '50 seconds')),
  ('F1', pg_temp.start_fake(pg_temp.uid('P4'), 500, '10 seconds'));
select pg_temp.snap('reserved', pg_temp.reserved());

set local role service_role;
select is(public.reap_stale_attempts(), 2, 'R1-18: reap_stale_attempts finalizes the two attempts older than 45 seconds');
reset role;
select results_eq(
  $$ select t.name, a.outcome::text, a.error_code, a.cost_micros = a.reserved_micros, a.refund_cents
     from public.attempts a join t_ids t on t.id = a.id where t.name in ('S1', 'S2', 'F1') order by t.name $$,
  $$ values ('F1'::text, 'pending'::text, null::text, false, 0::bigint),
            ('S1', 'error', 'reaped', true, 100::bigint),
            ('S2', 'error', 'reaped', true, 100::bigint) $$,
  'R1-18: stale attempts end as error reaped with actual = reserved and a refund; a fresh one stays pending'
);
select is(pg_temp.reserved(), pg_temp.was('reserved') - 1700, 'the reaper releases exactly the stale reservations');
select ok(
  (select in_flight_attempt_id is null from public.wallets where user_id = pg_temp.uid('P2'))
  and (select in_flight_attempt_id = pg_temp.uid('F1') from public.wallets where user_id = pg_temp.uid('P4')),
  'the reaper clears the stale in-flight markers only'
);
set local role service_role;
select is(public.reap_stale_attempts(45), 0, 'a second run finds nothing to reap');
select is(pg_temp.raises($$ select public.reap_stale_attempts(5) $$), 'PT422 invariant_violation',
  'a threshold below 30 seconds is refused');
reset role;
select is(
  (select pg_get_function_arguments(oid) from pg_proc where oid = 'public.reap_stale_attempts(integer, integer)'::regprocedure),
  'p_older_than_seconds integer DEFAULT 45, p_limit integer DEFAULT 50',
  'R2-13: the reaper threshold defaults to 45 seconds'
);
select ok(
  (select strpos(prosrc, 'from public.wallets as w where w.user_id = any (v_users) order by w.user_id for update') > 0
      and strpos(prosrc, 'from public.wallets as w where w.user_id = any (v_users) order by w.user_id for update')
          < strpos(prosrc, 'from public.game_state as g where g.id = 1 for update')
      and strpos(prosrc, 'from public.game_state as g where g.id = 1 for update')
          < strpos(prosrc, 'from public.attempts as a where a.id = any (v_ids) order by a.id for update')
      and strpos(prosrc, 'from public.attempts as a where a.id = any (v_ids) order by a.id for update')
          < strpos(prosrc, 'private._finalize_attempt_error(')
   from pg_proc where oid = 'public.reap_stale_attempts(integer, integer)'::regprocedure),
  'R1-02: the reaper locks wallets (user_id order), then game_state, then attempts (id order), then settles spend'
);

-- ---------------------------------------------------------------------------
-- repair_glass (CH-1): 14 tests
-- ---------------------------------------------------------------------------
-- Staged state: 2 cracks and $5.00 (set directly, see the header).
update public.wallets set crack_count = 2, balance_cents = 500 where user_id = pg_temp.uid('P5');
select pg_temp.snap('treasury', pg_temp.treasury());

set local role service_role;
select results_eq(
  format($$ select cracks::integer, wallet_balance_cents, treasury_cents, replay
            from public.repair_glass(%L, '00000000-0000-4000-8000-00000000c001', 10, 10) $$, pg_temp.uid('P5')),
  format($$ values (0, 400::bigint, %s::bigint, false) $$, pg_temp.was('treasury') + 100),
  'CH-1: with 2 cracks and $5.00, repair charges 100 cents to the treasury, clears the cracks, and returns the new balance'
);
reset role;
select is((select crack_count::integer from public.wallets where user_id = pg_temp.uid('P5')), 0, 'CH-1: the stored crack count is 0');
select results_eq(
  format($$ select kind, from_account, to_account, amount_cents from public.ledger_entries
            where external_ref = 'repair:%s:00000000-0000-4000-8000-00000000c001' $$, pg_temp.uid('P5')),
  format($$ values ('repair_fee'::text, 'player:%s'::text, 'treasury'::text, 100::bigint) $$, pg_temp.uid('P5')),
  'the charge is one repair_fee ledger row from the player to the treasury'
);

update public.wallets set crack_count = 3 where user_id = pg_temp.uid('P5');
set local role service_role;
select results_eq(
  format($$ select cracks::integer, wallet_balance_cents, replay
            from public.repair_glass(%L, '00000000-0000-4000-8000-00000000c001', 10, 10) $$, pg_temp.uid('P5')),
  $$ values (3, 400::bigint, true) $$,
  'CH-1: a repeated idempotency key returns replay true without charging again'
);
reset role;
select is((select count(*)::integer from public.ledger_entries where kind = 'repair_fee' and user_id = pg_temp.uid('P5')), 1,
  'the replay wrote no second ledger row');

update public.wallets set crack_count = 0 where user_id = pg_temp.uid('P5');
select pg_temp.snap('treasury', pg_temp.treasury());
set local role service_role;
select is(pg_temp.raises(format($$ select * from public.repair_glass(%L, '00000000-0000-4000-8000-00000000c002', 10, 10) $$, pg_temp.uid('P5'))),
  'PT409 nothing_to_repair', 'CH-1: at 0 cracks repair raises PT409 nothing_to_repair');
reset role;
select ok(pg_temp.balance(pg_temp.uid('P5')) = 400 and pg_temp.treasury() = pg_temp.was('treasury')
          and (select count(*) from public.ledger_entries where kind = 'repair_fee' and user_id = pg_temp.uid('P5')) = 1,
  'CH-1: nothing moves when there is nothing to repair');

-- Staged state: 1 crack and $0.50.
update public.wallets set crack_count = 1, balance_cents = 50 where user_id = pg_temp.uid('P5');
set local role service_role;
select is(pg_temp.raises(format($$ select * from public.repair_glass(%L, '00000000-0000-4000-8000-00000000c003', 10, 10) $$, pg_temp.uid('P5'))),
  'PT402 insufficient_funds', 'CH-1: with $0.50 repair raises PT402 insufficient_funds');
reset role;
select ok(pg_temp.balance(pg_temp.uid('P5')) = 50
          and (select crack_count from public.wallets where user_id = pg_temp.uid('P5')) = 1,
  'a refused repair charges nothing and keeps the cracks');

-- The price comes from app_config.
update public.app_config set value = '250' where key = 'repair_price_cents';
update public.wallets set crack_count = 2, balance_cents = 400 where user_id = pg_temp.uid('P5');
set local role service_role;
select results_eq(
  format($$ select cracks::integer, wallet_balance_cents from public.repair_glass(%L, '00000000-0000-4000-8000-00000000c004', 10, 10) $$, pg_temp.uid('P5')),
  $$ values (0, 150::bigint) $$,
  'CH-1: repair_glass charges app_config repair_price_cents'
);
reset role;
update public.app_config set value = '100' where key = 'repair_price_cents';
select is(
  (select pg_get_function_identity_arguments(oid) from pg_proc where oid = 'public.repair_glass(uuid, uuid, integer, integer)'::regprocedure),
  'p_user_id uuid, p_idempotency_key uuid, p_rate_capacity integer, p_rate_refill_per_min integer',
  'CH-1: repair_glass takes no price parameter'
);

-- The wallet bucket: capacity 1 allows one repair, then rate_limited.
update public.wallets set crack_count = 1 where user_id = pg_temp.uid('P6');
set local role service_role;
select is(pg_temp.raises(format($$ select * from public.repair_glass(%L, '00000000-0000-4000-8000-00000000c005', 1, 1) $$, pg_temp.uid('P6'))),
  'ok', 'a repair within the wallet bucket succeeds');
reset role;
update public.wallets set crack_count = 1 where user_id = pg_temp.uid('P6');
set local role service_role;
select is(pg_temp.raises(format($$ select * from public.repair_glass(%L, '00000000-0000-4000-8000-00000000c006', 1, 1) $$, pg_temp.uid('P6'))),
  'PT429 rate_limited', 'an empty wallet bucket raises PT429 rate_limited');
select is(pg_temp.raises($$ select * from public.repair_glass('00000000-0000-4000-8000-0000000018ff', '00000000-0000-4000-8000-00000000c007', 10, 10) $$),
  'PT403 forbidden', 'a user without a wallet gets PT403');
reset role;

-- ---------------------------------------------------------------------------
-- donate (CH-2): 12 tests
-- ---------------------------------------------------------------------------
select pg_temp.snap('treasury', pg_temp.treasury());
set local role service_role;
select results_eq(
  format($$ select wallet_balance_cents, total_donated_cents, aura_bps, replay
            from public.donate(%L, 1, '00000000-0000-4000-8000-00000000d001', 10, 10) $$, pg_temp.uid('P7')),
  $$ values (1999::bigint, 1::bigint, 5, false) $$,
  'CH-2: a 1-cent donation is accepted and the aura follows donated / (donated + balance)'
);
reset role;
select results_eq(
  format($$ select kind, from_account, to_account, amount_cents from public.ledger_entries
            where external_ref = 'donation:%s:00000000-0000-4000-8000-00000000d001' $$, pg_temp.uid('P7')),
  format($$ values ('donation'::text, 'player:%s'::text, 'cncf'::text, 1::bigint) $$, pg_temp.uid('P7')),
  'CH-2: the donation moves money from the player to the cncf account'
);
select results_eq(
  format($$ select amount_cents from public.donations where user_id = %L $$, pg_temp.uid('P7')),
  $$ values (1::bigint) $$,
  'CH-2: the donation writes a donations row'
);

set local role service_role;
select is(pg_temp.raises(format($$ select * from public.donate(%L, 0, '00000000-0000-4000-8000-00000000d002', 10, 10) $$, pg_temp.uid('P7'))),
  'PT422 invalid_amount', 'CH-2: a donation of 0 raises PT422 invalid_amount');
select is(pg_temp.raises(format($$ select * from public.donate(%L, -5, '00000000-0000-4000-8000-00000000d002', 10, 10) $$, pg_temp.uid('P7'))),
  'PT422 invalid_amount', 'a negative donation raises PT422 invalid_amount');
select is(pg_temp.raises(format($$ select * from public.donate(%L, 2000, '00000000-0000-4000-8000-00000000d002', 10, 10) $$, pg_temp.uid('P7'))),
  'PT402 insufficient_funds', 'CH-2: more than the balance raises PT402');
select results_eq(
  format($$ select wallet_balance_cents, total_donated_cents, replay
            from public.donate(%L, 1, '00000000-0000-4000-8000-00000000d001', 10, 10) $$, pg_temp.uid('P7')),
  $$ values (1999::bigint, 1::bigint, true) $$,
  'CH-2: a repeated key is a replay'
);
reset role;
select is((select count(*)::integer from public.donations where user_id = pg_temp.uid('P7')), 1,
  'the replay wrote no second donation');

set local role service_role;
select results_eq(
  format($$ select wallet_balance_cents, total_donated_cents, aura_bps, replay
            from public.donate(%L, 1999, '00000000-0000-4000-8000-00000000d003', 10, 10) $$, pg_temp.uid('P7')),
  $$ values (0::bigint, 2000::bigint, 10000, false) $$,
  'CH-2: donating the whole balance is accepted and gives aura_bps 10000'
);
reset role;
select is(
  (select sum(amount_cents) from public.ledger_entries where kind = 'donation' and user_id = pg_temp.uid('P7')),
  (select total_donated_cents from public.wallets where user_id = pg_temp.uid('P7'))::numeric,
  'the donation ledger rows add up to total_donated_cents'
);
select is(pg_temp.treasury(), pg_temp.was('treasury'), 'CH-2: a donation never touches the treasury');
select is(
  (select pg_get_function_identity_arguments(oid) from pg_proc where oid = 'public.donate(uuid, bigint, uuid, integer, integer)'::regprocedure),
  'p_user_id uuid, p_amount_cents bigint, p_idempotency_key uuid, p_rate_capacity integer, p_rate_refill_per_min integer',
  'donate takes integer cents'
);

-- ---------------------------------------------------------------------------
-- admin_grant_funds: 9 tests
-- ---------------------------------------------------------------------------
set local role service_role;
select is(public.admin_grant_funds(pg_temp.uid('ADMIN'), pg_temp.uid('P8'), 500, '00000000-0000-4000-8000-00000000e001'), 2500::bigint,
  'admin_grant_funds returns the new balance');
select is(public.admin_grant_funds(pg_temp.uid('ADMIN'), pg_temp.uid('P8'), 500, '00000000-0000-4000-8000-00000000e001'), 2500::bigint,
  'a repeated key grants nothing more');
select is(public.admin_grant_funds(pg_temp.uid('ADMIN'), pg_temp.uid('P8'), 1, '00000000-0000-4000-8000-00000000e002'), 2501::bigint,
  'a grant of 1 cent is accepted');
select is(public.admin_grant_funds(pg_temp.uid('ADMIN'), pg_temp.uid('P8'), 10000, '00000000-0000-4000-8000-00000000e003'), 12501::bigint,
  'a grant of admin_grant_max_cents is accepted');
select results_eq(
  format($$ select pg_temp.raises(format('select public.admin_grant_funds(%%L, %%L, %%s, %%L)', %L, %L, x.amount, gen_random_uuid()))
            from (values (0), (10001)) as x (amount) $$, pg_temp.uid('ADMIN'), pg_temp.uid('P8')),
  $$ values ('PT422 invalid_amount'::text), ('PT422 invalid_amount') $$,
  'a grant of 0 or above admin_grant_max_cents raises PT422 invalid_amount'
);
select is(pg_temp.raises(format($$ select public.admin_grant_funds(%L, %L, 10, '00000000-0000-4000-8000-00000000e001') $$,
                                pg_temp.uid('ADMIN'), pg_temp.uid('P7'))),
  'PT409 idempotency_conflict', 'a grant key reused for another player raises PT409');
select is(pg_temp.raises(format($$ select public.admin_grant_funds(%L, '00000000-0000-4000-8000-0000000018ff', 10, gen_random_uuid()) $$,
                                pg_temp.uid('ADMIN'))),
  'PT404 not_found', 'a grant to an unknown player raises PT404');
reset role;
select results_eq(
  format($$ select kind, from_account, amount_cents from public.ledger_entries where external_ref = 'grant:00000000-0000-4000-8000-00000000e001' $$),
  $$ values ('admin_grant'::text, 'mint'::text, 500::bigint) $$,
  'the grant is one admin_grant ledger row from mint'
);
select is(
  (select count(*)::integer from public.admin_actions where admin_id = pg_temp.uid('ADMIN') and action = 'admin_grant'), 3,
  'every grant, and no replay, is logged in admin_actions'
);

-- ---------------------------------------------------------------------------
-- admin_set_player_hidden (section 9.7): 6 tests
-- ---------------------------------------------------------------------------
update public.wallets set last_seen_at = now() where user_id in (pg_temp.uid('P7'), pg_temp.uid('P8'));
create function pg_temp.on_wall(p_user uuid) returns boolean
language sql stable as $$
  select exists (select 1 from public.get_live_players(120, 150) as g, jsonb_array_elements(g.players) as e
                 where (e ->> 'id')::uuid = p_user)
$$;
create function pg_temp.on_ping(p_caller uuid, p_user uuid) returns boolean
language plpgsql as $$
begin
  return exists (select 1 from public.presence_ping(p_caller, 120, 150) as g, jsonb_array_elements(g.players) as e
                 where (e ->> 'id')::uuid = p_user);
end
$$;
select ok(pg_temp.on_wall(pg_temp.uid('P8')), 'a recently seen player is on the wall');

set local role service_role;
select lives_ok(format($$ select public.admin_set_player_hidden(%L, %L, true) $$, pg_temp.uid('ADMIN'), pg_temp.uid('P8')),
  'admin_set_player_hidden hides a player');
reset role;
select ok(not pg_temp.on_wall(pg_temp.uid('P8')) and not pg_temp.on_ping(pg_temp.uid('P7'), pg_temp.uid('P8'))
          and pg_temp.on_ping(pg_temp.uid('P7'), pg_temp.uid('P7')),
  'a hidden player is removed from get_live_players and presence_ping');
set local role service_role;
select lives_ok(format($$ select public.admin_set_player_hidden(%L, %L, false) $$, pg_temp.uid('ADMIN'), pg_temp.uid('P8')),
  'admin_set_player_hidden shows a player again');
select is(pg_temp.raises(format($$ select public.admin_set_player_hidden(%L, '00000000-0000-4000-8000-0000000018ff', true) $$, pg_temp.uid('ADMIN'))),
  'PT404 not_found', 'hiding an unknown player raises PT404');
reset role;
select results_eq(
  format($$ select action, target from public.admin_actions where admin_id = %L and action like 'player_%%' order by id $$, pg_temp.uid('ADMIN')),
  format($$ values ('player_hidden'::text, %L::text), ('player_unhidden', %L) $$, pg_temp.uid('P8'), pg_temp.uid('P8')),
  'hiding and showing are logged in admin_actions'
);

-- ---------------------------------------------------------------------------
-- reset_game: 6 tests
-- ---------------------------------------------------------------------------
select pg_temp.snap('epoch', (select pig_epoch from public.game_state where id = 1));
select pg_temp.snap('treasury', pg_temp.treasury());
set local role service_role;
select is(public.reset_game(pg_temp.uid('ADMIN'), 2::smallint), pg_temp.was('epoch') + 1, 'reset_game returns the new epoch');
reset role;
select results_eq(
  $$ select current_level::integer, pig_epoch, treasury_cents from public.game_state where id = 1 $$,
  $$ select 2, pg_temp.was('epoch') + 1, pg_temp.was('treasury') $$,
  'reset_game increments pig_epoch, sets the level, and leaves the treasury unchanged'
);
select results_eq(
  $$ select event_type, level_id::integer from public.live_feed where event_type = 'game_reset' $$,
  $$ values ('game_reset'::text, 2) $$,
  'reset_game writes a game_reset feed row'
);
select is((select count(*)::integer from public.admin_actions where action = 'game_reset'), 1, 'reset_game is logged in admin_actions');
set local role service_role;
select is(pg_temp.raises(format($$ select public.reset_game(%L, 9::smallint) $$, pg_temp.uid('ADMIN'))), 'PT422 invariant_violation',
  'an unknown level raises PT422');
select lives_ok(format($$ select public.reset_game(%L) $$, pg_temp.uid('ADMIN')), 'reset_game defaults to level 1');
reset role;

-- ---------------------------------------------------------------------------
-- remove_keyword (R1-01): 9 tests
-- ---------------------------------------------------------------------------
-- Stage level 3 with three keywords and some flags, as the runbook would
-- after a few hardenings.
select private._reactivate_rules(3::smallint,
  jsonb_build_object(
    'schema_version', 1,
    'block_keywords', jsonb_build_array('grandma vault ritual', 'alpha beta gamma', 'delta echo foxtrot'),
    'reject_roleplay_archetypes', true, 'reject_authority_claims', true, 'reject_instruction_override', true,
    'reject_delimiter_tokens', true, 'reject_encoded_payloads', false, 'reject_tool_invocation_language', false,
    'reject_deferred_instructions', false, 'reject_mixed_script_obfuscation', true, 'reject_hypothetical_framing', false),
  'admin_rollback');
insert into t_ids (name, id) values
  ('R_old', (select id from public.rule_sets where level_id = 3 and state = 'active'));

create temporary table t_new_rule (id uuid) on commit drop;
grant select, insert on t_new_rule to service_role;
set local role service_role;
insert into t_new_rule select public.remove_keyword(pg_temp.uid('ADMIN'), 3::smallint, 'alpha beta gamma');
reset role;

select results_eq(
  $$ select n.state::text, n.version, n.parent_id, n.source
     from public.rule_sets as n join t_new_rule as t on t.id = n.id $$,
  $$ select 'active'::text, o.version + 1, o.id, 'admin_remove_keyword'::text from public.rule_sets as o where o.id = pg_temp.uid('R_old') $$,
  'R1-01: remove_keyword creates an active version n+1 whose parent is the previous row'
);
select is(
  (select n.rules -> 'block_keywords' from public.rule_sets as n join t_new_rule as t on t.id = n.id),
  '["grandma vault ritual", "delta echo foxtrot"]'::jsonb,
  'R1-01: the new version lacks the keyword and keeps every other keyword in order'
);
select is(
  (select n.rules - 'block_keywords' from public.rule_sets as n join t_new_rule as t on t.id = n.id),
  (select o.rules - 'block_keywords' from public.rule_sets as o where o.id = pg_temp.uid('R_old')),
  'R1-01: every flag is kept'
);
select results_eq(
  $$ select state::text, deactivated_at is not null from public.rule_sets where id = pg_temp.uid('R_old') $$,
  $$ values ('superseded'::text, true) $$,
  'R1-01: the previous row is marked superseded'
);
select is(
  (select count(*)::integer from public.admin_actions
   where action = 'keyword_removed' and target = 'level:3:rule_set:' || (select id from t_new_rule)::text), 1,
  'R1-01: the removal is logged in admin_actions without the keyword text'
);
select ok(
  exists (select 1 from public.live_feed where event_type = 'rules_reset' and level_id = 3
          and rule_version = (select version from public.rule_sets where id = (select id from t_new_rule))),
  'the activation writes a rules_reset feed row'
);
select is((select count(*)::integer from public.rule_sets where level_id = 3 and state = 'active'), 1,
  'the level still has exactly one active rule set');
set local role service_role;
select is(pg_temp.raises(format($$ select public.remove_keyword(%L, 3::smallint, 'alpha beta gamma') $$, pg_temp.uid('ADMIN'))),
  'PT404 not_found', 'removing a keyword the active rules lack raises PT404');
select is(pg_temp.raises(format($$ select public.remove_keyword(%L, 9::smallint, 'alpha beta gamma') $$, pg_temp.uid('ADMIN'))),
  'PT422 invariant_violation', 'an unknown level raises PT422');
reset role;

-- ---------------------------------------------------------------------------
-- purge_raw_prompts and prune_live_feed (CH-7): 8 tests
-- ---------------------------------------------------------------------------
insert into t_ids (name, id) values
  ('OLD_fail', pg_temp.add_attempt(pg_temp.uid('P9'), 'fail',     1,   'pp18 old failed prompt', '31 days')),
  ('OLD_late', pg_temp.add_attempt(pg_temp.uid('P9'), 'late_win', 1,   'pp18 old late win prompt', '31 days')),
  ('OLD_win',  pg_temp.add_attempt(pg_temp.uid('P9'), 'win',      918, 'pp18 old paid win prompt', '31 days')),
  ('NEW_fail', pg_temp.add_attempt(pg_temp.uid('P9'), 'fail',     1,   'pp18 recent failed prompt', '1 day'));
select public.add_breach_to_golden(pg_temp.uid('OLD_win'));

set local role service_role;
select is(public.purge_raw_prompts(30), 2, 'CH-7: purge_raw_prompts reports the two purged non-win attempts');
reset role;
select results_eq(
  $$ select t.name, a.prompt is null, a.reply is null
     from public.attempts a join t_ids t on t.id = a.id where t.name in ('OLD_fail', 'OLD_late', 'OLD_win', 'NEW_fail') order by t.name $$,
  $$ values ('NEW_fail'::text, false, false), ('OLD_fail', true, true), ('OLD_late', true, true), ('OLD_win', false, false) $$,
  'CH-7: prompt and reply are nulled past retention for non-win attempts only'
);
select ok(
  exists (select 1 from public.golden_prompts where attempt_id = pg_temp.uid('OLD_win') and text = 'pp18 old paid win prompt'),
  'CH-7: the paid-win prompt stays available in golden_prompts'
);
select ok(
  (select prompt is not null from public.attempts where id = pg_temp.uid('F1')),
  'a pending attempt is never purged'
);
set local role service_role;
select is(pg_temp.raises($$ select public.purge_raw_prompts(0) $$), 'PT422 invariant_violation', 'a retention of 0 days is refused');
reset role;

insert into public.live_feed (event_type, created_at) values ('game_reset', now() - interval '40 days');
select pg_temp.snap('feed', (select count(*) from public.live_feed));
set local role service_role;
select ok(public.prune_live_feed(30) >= 1, 'prune_live_feed deletes rows older than the window');
reset role;
select is_empty($$ select id from public.live_feed where created_at < now() - interval '30 days' $$, 'no feed row older than 30 days remains');
select ok((select count(*) from public.live_feed) > 0, 'recent feed rows remain');

-- ---------------------------------------------------------------------------
-- Functions and privileges (R1-02, R2-17): 6 tests
-- ---------------------------------------------------------------------------
create temporary table t_functions on commit drop as
  select unnest(array[
    'private._take_rate_token(uuid, text, integer, integer)',
    'private._finalize_attempt_error(uuid, text, bigint)',
    'public.reap_stale_attempts(integer, integer)',
    'public.repair_glass(uuid, uuid, integer, integer)',
    'public.donate(uuid, bigint, uuid, integer, integer)',
    'public.admin_grant_funds(uuid, uuid, bigint, uuid)',
    'public.admin_set_player_hidden(uuid, uuid, boolean)',
    'public.reset_game(uuid, smallint)',
    'public.remove_keyword(uuid, smallint, text)',
    'public.purge_raw_prompts(integer)',
    'public.prune_live_feed(integer)']::regprocedure[]) as fn;

select is_empty(
  $$ select r.role_name || ' ' || f.fn::text
     from (values ('anon'), ('authenticated')) as r (role_name)
     cross join t_functions as f
     where has_function_privilege(r.role_name, f.fn, 'EXECUTE') $$,
  'R2-17: anon and authenticated can execute no 00006 function'
);
select is_empty(
  $$ select f.fn::text from t_functions as f where not has_function_privilege('service_role', f.fn, 'EXECUTE') $$,
  'service_role can execute every 00006 function'
);
select is(
  (select count(*)::integer from t_functions f join pg_proc p on p.oid = f.fn
   where p.proconfig @> array['search_path=""'] and not p.prosecdef),
  11, 'R2-17: every 00006 function sets search_path to the empty string and is SECURITY INVOKER'
);
select is_empty(
  $$ select f.fn::text from t_functions f join pg_proc p on p.oid = f.fn where p.prosrc !~ 'Lock order \(section 5\.1\):' $$,
  'R1-02: every 00006 function names its lock order in a comment at the top of its body'
);

create temporary table t_bodies on commit drop as
  select f.fn::text as fn,
         regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '''([^'']|'''')*''', '''''', 'g') as body
  from t_functions f join pg_proc p on p.oid = f.fn;
select is_empty(
  $$ select fn from t_bodies
     where body ~* '\m(from|join|into|update|table)\s+(game_state|wallets|attempts|ledger_entries|donations|live_feed|profiles|app_config|levels|rule_sets|rate_limits|ai_spend|admin_actions)\M'
        or body ~* '(^|[^.[:alnum:]_])(_post_ledger|_config_bigint|_config_bool|_take_rate_token|_finalize_attempt_error|rule_set_sha256)\s*\('
        or body ~* '::\s*(attempt_outcome|crack_event|rule_set_state|attack_technique)\M' $$,
  'R2-17: every table, project function, and project type in a 00006 body is schema-qualified'
);
select ok((select count(*) from t_bodies where body ~ 'public\.wallets') >= 4,
  'the scan sees the qualified references, so it is looking at the real bodies');

select * from finish();
rollback;
