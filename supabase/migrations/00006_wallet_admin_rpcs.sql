-- Migration 00006: the wallet and admin RPCs (task PP-18)
--
-- Contents (docs/ARCHITECTURE.md sections 5.1, 5.4, 9.2, 9.4, 9.5, 9.7, 12.6):
--   1. private._take_rate_token: one token from a player's token bucket.
--   2. private._finalize_attempt_error: the budgeted error finalization
--      (R2-01, R2-04, R3-06, R3-07).
--   3. reap_stale_attempts: finalizes attempts stranded by a killed function
--      (R1-18, R2-13).
--   4. repair_glass: $1 clears the cracks (CH-1).
--   5. donate: the mock CNCF donation (CH-2).
--   6. admin_grant_funds, admin_set_player_hidden, and reset_game.
--   7. remove_keyword: the targeted recovery for a poisoned keyword (R1-01).
--   8. purge_raw_prompts and prune_live_feed: retention (CH-7).
--   9. A self-check that fails the migration if a privilege is not as
--      intended.
--
-- Money is mocked US dollars in bigint integer cents (CH-1). Every price
-- comes from app_config (repair_price_cents, admin_grant_max_cents,
-- refund_budget_per_hour) or from a row (attempts.price_cents), never from a
-- request; a donation is bounded by the stored balance. Every balance and
-- treasury change goes through private._post_ledger, the only function that
-- moves money, and every movement carries a unique external_ref, so a
-- retried call can never move money twice:
--   refund:<attempt id>              attempt_refund or refund_mint
--   repair:<user id>:<key>           repair_fee
--   donation:<user id>:<key>         donation
--   grant:<key>                      admin_grant
--
-- Every function is SECURITY INVOKER, sets search_path = '', and
-- schema-qualifies every table, type, and function it uses; only pg_catalog
-- built-ins stay unqualified (R2-17). Each one is executable by service_role
-- only; the private helpers are called by service-role functions.
--
-- Errors use the PTnnn SQLSTATE convention (section 5.1). The message starts
-- with a token that src/lib/errors.ts recognizes and never contains a row
-- value:
--   PT402 insufficient_funds   the balance is lower than the price or amount
--                              (hint {"balanceCents": n, "priceCents": n})
--   PT403 forbidden            the player has no wallet (an anonymous session)
--   PT404 not_found            an unknown attempt, player, or keyword
--   PT409 already_finalized    the attempt is no longer pending
--   PT409 nothing_to_repair    repair_glass at 0 cracks (nothing is charged)
--   PT409 idempotency_conflict an admin grant key reused for another player
--   PT422 invalid_amount       a donation or grant amount out of range
--   PT422 invariant_violation  a missing or out-of-range argument
--   PT429 rate_limited         the wallet bucket is empty
--                              (hint {"retryAfterSeconds": n})
--
-- Global lock order (section 5.1, R1-02): profiles (1), rate_limits (2),
-- wallets (3), game_state (4), attempts (5), levels (6), rule_sets (7),
-- ai_spend (11) last. Rows of one table are locked in ascending primary-key
-- order. A comment at the top of each function body lists the order that
-- function uses. Append-only inserts (ledger_entries, donations, live_feed,
-- admin_actions) take no lock another transaction waits on.
--
-- Re-runnable: create or replace function, and REVOKE and GRANT, which are
-- idempotent by nature.

-- ===========================================================================
-- 1. private._take_rate_token
-- ===========================================================================
-- Takes one token from the player's bucket (attempt or wallet), creating a
-- full bucket on first use. The bucket refills continuously at
-- p_refill_per_min tokens a minute up to p_capacity. An empty bucket raises
-- PT429 rate_limited with the seconds until the next token. A raise rolls the
-- caller's transaction back, so a refused call consumes nothing. The caller
-- has checked that the player has a wallet, because rate_limits references
-- profiles.
create or replace function private._take_rate_token(
  p_user_id        uuid,
  p_bucket         text,
  p_capacity       integer,
  p_refill_per_min integer
)
returns void
language plpgsql
set search_path = ''
as $$
-- Lock order (section 5.1): rate_limits (2), the caller's one bucket row.
declare
  v_tokens  numeric;
  v_updated timestamptz;
begin
  if p_user_id is null or p_bucket is null or p_bucket not in ('attempt', 'wallet')
     or p_capacity is null or p_capacity not between 1 and 100
     or p_refill_per_min is null or p_refill_per_min not between 1 and 600 then
    raise exception 'invariant_violation: the rate limit needs a player, a bucket, a capacity of 1..100, and a refill of 1..600 a minute'
      using errcode = 'PT422';
  end if;

  insert into public.rate_limits (user_id, bucket, tokens, updated_at)
  values (p_user_id, p_bucket, p_capacity, now())
  on conflict (user_id, bucket) do nothing;

  select r.tokens, r.updated_at
    into v_tokens, v_updated
  from public.rate_limits as r
  where r.user_id = p_user_id and r.bucket = p_bucket
  for update;

  v_tokens := least(p_capacity::numeric,
                    v_tokens + greatest(0, extract(epoch from now() - v_updated)) * p_refill_per_min / 60.0);

  if v_tokens < 1 then
    raise exception 'rate_limited: the wallet bucket is empty'
      using errcode = 'PT429',
            hint = format('{"retryAfterSeconds": %s}',
                          greatest(1, ceil((1 - v_tokens) * 60.0 / p_refill_per_min))::integer);
  end if;

  update public.rate_limits as r
     set tokens = round(v_tokens - 1, 4), updated_at = now()
   where r.user_id = p_user_id and r.bucket = p_bucket;
end
$$;

revoke all on function private._take_rate_token(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function private._take_rate_token(uuid, text, integer, integer) to service_role;

comment on function private._take_rate_token(uuid, text, integer, integer) is
  'Takes one token from a player''s rate-limit bucket or raises PT429 '
  'rate_limited. Service role only.';

-- ===========================================================================
-- 2. private._finalize_attempt_error: budgeted error finalization
-- ===========================================================================
-- Finalizes a pending attempt as error with p_error_code, exactly once; a
-- second call raises PT409 already_finalized. It is the one error path for
-- record_attempt, start_attempt's stale in-flight row, the same-key reaper
-- of R3-06, a reply that cannot be stored (R3-07), and reap_stale_attempts.
--   - Refund budget (R2-01): the attempt's price_cents is refunded unless
--     the player already received app_config refund_budget_per_hour refunds
--     (default 3) in the last hour. A missing key refunds nothing (fail
--     closed on money). Over the budget the fee is kept and refund_withheld
--     is set.
--   - Source: from the treasury while the attempt's epoch is the current
--     one; through refund_mint after a payout (or a game reset) moved the
--     pig on, so the winner keeps the whole pot and the player is still made
--     whole. The refund amount is the price stored on the attempt, so a
--     price change mid-event never changes a refund.
--   - Cracks are unchanged; the attempt records crack_event none and the
--     current count.
--   - in_flight_attempt_id is cleared when it points at this attempt.
--   - Spend is settled once, against attempts.spend_day (R1-18, R2-04):
--     attempt_reserved_micros -= reserved_micros (never below zero) and
--     attempt_settled_micros += p_actual_micros.
-- No live_feed row is written: the projector shows no errors.
create or replace function private._finalize_attempt_error(
  p_attempt_id    uuid,
  p_error_code    text,
  p_actual_micros bigint
)
returns table (refund_cents bigint, refund_withheld boolean)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
-- Lock order (section 5.1): wallets (3) -> game_state (4) -> attempts (5)
-- -> ai_spend (11). The caller already holds the first three. They are
-- taken again here in the same order: re-locking a row the transaction holds
-- is a no-op, and a caller that holds none still gets the global order. The
-- ai_spend day row is taken last.
declare
  v_user     uuid;
  v_cracks   smallint;
  v_epoch    bigint;
  v_treasury bigint;
  v_attempt  public.attempts%rowtype;
  v_budget   bigint;
  v_recent   bigint;
  v_refund   bigint  := 0;
  v_withheld boolean := false;
begin
  if p_attempt_id is null or p_error_code is null or p_error_code !~ '^[a-z_]{3,40}$'
     or p_actual_micros is null or p_actual_micros not between 0 and 1000000000000 then
    raise exception 'invariant_violation: _finalize_attempt_error needs an attempt, an error code, and an actual spend in range'
      using errcode = 'PT422';
  end if;

  -- user_id never changes, so it is read without a lock.
  select a.user_id into v_user from public.attempts as a where a.id = p_attempt_id;
  if v_user is null then
    raise exception 'not_found: _finalize_attempt_error got an unknown attempt'
      using errcode = 'PT404';
  end if;

  select w.crack_count into v_cracks
  from public.wallets as w
  where w.user_id = v_user
  for update;

  if not found then
    raise exception 'invariant_violation: the attempt''s player has no wallet'
      using errcode = 'PT422';
  end if;

  select g.pig_epoch, g.treasury_cents into v_epoch, v_treasury
  from public.game_state as g
  where g.id = 1
  for update;

  select * into v_attempt
  from public.attempts as a
  where a.id = p_attempt_id
  for update;

  if v_attempt.outcome <> 'pending'::public.attempt_outcome then
    raise exception 'already_finalized: the attempt is no longer pending'
      using errcode = 'PT409';
  end if;

  v_budget := coalesce(private._config_bigint('refund_budget_per_hour'), 0);

  -- Refunds already paid to this player in the rolling hour (index
  -- attempts_user_refunds). The wallet lock serializes every finalization
  -- of this player, so the count cannot race.
  select count(*) into v_recent
  from public.attempts as a
  where a.user_id = v_user
    and a.refund_cents > 0
    and a.finalized_at > now() - interval '1 hour';

  if v_recent < v_budget then
    v_refund := v_attempt.price_cents;
    if v_attempt.pig_epoch = v_epoch and v_treasury >= v_refund then
      perform private._post_ledger('attempt_refund', 'treasury', 'player:' || v_user::text,
                                   v_refund, v_user, p_attempt_id, 'refund:' || p_attempt_id::text);
    else
      perform private._post_ledger('refund_mint', 'mint', 'player:' || v_user::text,
                                   v_refund, v_user, p_attempt_id, 'refund:' || p_attempt_id::text);
    end if;
  else
    v_withheld := true;
  end if;

  update public.attempts as a
     set outcome         = 'error'::public.attempt_outcome,
         error_code      = p_error_code,
         cost_micros     = p_actual_micros,
         refund_cents    = v_refund,
         refund_withheld = v_withheld,
         crack_event     = 'none'::public.crack_event,
         cracks_after    = v_cracks,
         finalized_at    = now()
   where a.id = p_attempt_id;

  update public.wallets as w
     set in_flight_attempt_id = null
   where w.user_id = v_user
     and w.in_flight_attempt_id = p_attempt_id;

  -- Spend last (lock order 11), once, on the reservation's day.
  insert into public.ai_spend (day) values (v_attempt.spend_day)
  on conflict (day) do nothing;

  update public.ai_spend as s
     set attempt_reserved_micros = greatest(0, s.attempt_reserved_micros - v_attempt.reserved_micros),
         attempt_settled_micros  = s.attempt_settled_micros + p_actual_micros,
         updated_at              = now()
   where s.day = v_attempt.spend_day;

  return query select v_refund, v_withheld;
end
$$;

revoke all on function private._finalize_attempt_error(uuid, text, bigint) from public, anon, authenticated;
grant execute on function private._finalize_attempt_error(uuid, text, bigint) to service_role;

comment on function private._finalize_attempt_error(uuid, text, bigint) is
  'Finalizes a pending attempt as error exactly once: refunds price_cents '
  'within app_config refund_budget_per_hour (treasury in the current epoch, '
  'refund_mint after it), otherwise sets refund_withheld; leaves cracks '
  'unchanged; clears the in-flight marker; settles spend on spend_day. '
  'Service role only.';

-- ===========================================================================
-- 3. reap_stale_attempts
-- ===========================================================================
-- Finalizes every attempt still pending p_older_than_seconds after it
-- started (default 45: the attempt route's 30-second maxDuration plus 15
-- seconds, so a killed function locks a player out for at most 45 seconds,
-- R2-13), at most p_limit of them (clamped to 1..500), through
-- private._finalize_attempt_error with code reaped and the actual spend
-- equal to the reservation (R1-18). Returns the number finalized.
create or replace function public.reap_stale_attempts(
  p_older_than_seconds integer default 45,
  p_limit              integer default 50
)
returns integer
language plpgsql
set search_path = ''
as $$
-- Lock order (section 5.1): wallets (3, the players of the stale attempts in
-- ascending user_id) -> game_state (4) -> attempts (5, ascending id) ->
-- ai_spend (11, inside _finalize_attempt_error; the attempts are finalized
-- in ascending spend_day, so day rows are also locked in ascending order).
declare
  v_ids   uuid[];
  v_users uuid[];
  v_count integer := 0;
  r       record;
begin
  if p_older_than_seconds is null or p_older_than_seconds not between 30 and 86400 then
    raise exception 'invariant_violation: reap_stale_attempts needs a threshold of 30..86400 seconds'
      using errcode = 'PT422';
  end if;

  -- Candidates, read without a lock (index attempts_pending).
  select array_agg(c.id order by c.id), array_agg(distinct c.user_id)
    into v_ids, v_users
  from (
    select a.id, a.user_id
    from public.attempts as a
    where a.outcome = 'pending'::public.attempt_outcome
      and a.created_at < now() - make_interval(secs => p_older_than_seconds)
    order by a.created_at, a.id
    limit least(greatest(coalesce(p_limit, 50), 1), 500)
  ) as c;

  if v_ids is null then
    return 0;
  end if;

  perform 1 from public.wallets as w where w.user_id = any (v_users) order by w.user_id for update;
  perform 1 from public.game_state as g where g.id = 1 for update;
  perform 1 from public.attempts as a where a.id = any (v_ids) order by a.id for update;

  -- Re-read under the locks: another finalizer may have won the race.
  for r in
    select a.id, a.reserved_micros
    from public.attempts as a
    where a.id = any (v_ids)
      and a.outcome = 'pending'::public.attempt_outcome
    order by a.spend_day, a.id
  loop
    perform private._finalize_attempt_error(r.id, 'reaped', r.reserved_micros);
    v_count := v_count + 1;
  end loop;

  return v_count;
end
$$;

revoke all on function public.reap_stale_attempts(integer, integer) from public, anon, authenticated;
grant execute on function public.reap_stale_attempts(integer, integer) to service_role;

comment on function public.reap_stale_attempts(integer, integer) is
  'Finalizes pending attempts older than the threshold (default 45 seconds) '
  'as error reaped through private._finalize_attempt_error, in the global '
  'lock order. Returns the count. Service role only.';

-- ===========================================================================
-- 4. repair_glass (CH-1, section 9.2)
-- ===========================================================================
-- Charges app_config repair_price_cents (default 100, $1) from the wallet
-- into the treasury and sets crack_count to 0, in one transaction. The price
-- is never a parameter. At 0 cracks it raises PT409 nothing_to_repair and
-- charges nothing; a balance below the price raises PT402. A repeated
-- idempotency key returns the current state with replay = true and charges
-- nothing (external_ref repair:<user>:<key>).
create or replace function public.repair_glass(
  p_user_id             uuid,
  p_idempotency_key     uuid,
  p_rate_capacity       integer,
  p_rate_refill_per_min integer
)
returns table (cracks smallint, wallet_balance_cents bigint, aura_bps integer, treasury_cents bigint, replay boolean)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
-- Lock order (section 5.1): rate_limits (2, the wallet bucket) -> wallets
-- (3, the caller's row) -> game_state (4, only when charging).
declare
  v_ref     text;
  v_cracks  smallint;
  v_balance bigint;
  v_price   bigint;
begin
  if p_user_id is null or p_idempotency_key is null then
    raise exception 'invariant_violation: repair_glass needs a player and an idempotency key'
      using errcode = 'PT422';
  end if;

  if not exists (select 1 from public.wallets as w where w.user_id = p_user_id) then
    raise exception 'forbidden: repair_glass needs a player with a wallet'
      using errcode = 'PT403';
  end if;

  v_ref := 'repair:' || p_user_id::text || ':' || p_idempotency_key::text;

  perform private._take_rate_token(p_user_id, 'wallet', p_rate_capacity, p_rate_refill_per_min);

  select w.crack_count, w.balance_cents into v_cracks, v_balance
  from public.wallets as w
  where w.user_id = p_user_id
  for update;

  if exists (select 1 from public.ledger_entries as l where l.external_ref = v_ref) then
    return query
      select w.crack_count, w.balance_cents, w.aura_bps, g.treasury_cents, true
      from public.wallets as w cross join public.game_state as g
      where w.user_id = p_user_id and g.id = 1;
    return;
  end if;

  if v_cracks = 0 then
    raise exception 'nothing_to_repair: the glass has no cracks'
      using errcode = 'PT409';
  end if;

  v_price := private._config_bigint('repair_price_cents');
  if v_price is null or v_price < 1 then
    raise exception 'invariant_violation: app_config has no repair_price_cents'
      using errcode = 'PT422';
  end if;

  if v_balance < v_price then
    raise exception 'insufficient_funds: the balance is lower than the repair price'
      using errcode = 'PT402',
            hint = format('{"balanceCents": %s, "priceCents": %s}', v_balance, v_price);
  end if;

  perform 1 from public.game_state as g where g.id = 1 for update;

  perform private._post_ledger('repair_fee', 'player:' || p_user_id::text, 'treasury',
                               v_price, p_user_id, null, v_ref);

  update public.wallets as w
     set crack_count = 0
   where w.user_id = p_user_id;

  return query
    select w.crack_count, w.balance_cents, w.aura_bps, g.treasury_cents, false
    from public.wallets as w cross join public.game_state as g
    where w.user_id = p_user_id and g.id = 1;
end
$$;

revoke all on function public.repair_glass(uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.repair_glass(uuid, uuid, integer, integer) to service_role;

comment on function public.repair_glass(uuid, uuid, integer, integer) is
  'Charges app_config repair_price_cents into the treasury and sets the cracks '
  'to 0 atomically; PT409 nothing_to_repair at 0 cracks with no charge; '
  'idempotent by key. Service role only.';

-- ===========================================================================
-- 5. donate (CH-2, section 9.5)
-- ===========================================================================
-- The mock CNCF donation: debits p_amount_cents (1 cent up to the whole
-- stored balance) to the cncf sink, increments total_donated_cents, and
-- writes a donations row, atomically. The generated aura_bps follows from
-- the new balance and total (donating the whole balance gives 10000). A
-- repeated idempotency key returns the current state with replay = true.
create or replace function public.donate(
  p_user_id             uuid,
  p_amount_cents        bigint,
  p_idempotency_key     uuid,
  p_rate_capacity       integer,
  p_rate_refill_per_min integer
)
returns table (wallet_balance_cents bigint, total_donated_cents bigint, aura_bps integer, replay boolean)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
-- Lock order (section 5.1): rate_limits (2, the wallet bucket) -> wallets
-- (3, the caller's row). No game_state lock: a donation never touches the
-- treasury.
declare
  v_balance bigint;
begin
  if p_user_id is null or p_idempotency_key is null then
    raise exception 'invariant_violation: donate needs a player and an idempotency key'
      using errcode = 'PT422';
  end if;

  if not exists (select 1 from public.wallets as w where w.user_id = p_user_id) then
    raise exception 'forbidden: donate needs a player with a wallet'
      using errcode = 'PT403';
  end if;

  perform private._take_rate_token(p_user_id, 'wallet', p_rate_capacity, p_rate_refill_per_min);

  select w.balance_cents into v_balance
  from public.wallets as w
  where w.user_id = p_user_id
  for update;

  if exists (select 1 from public.donations as d
             where d.user_id = p_user_id and d.idempotency_key = p_idempotency_key) then
    return query
      select w.balance_cents, w.total_donated_cents, w.aura_bps, true
      from public.wallets as w
      where w.user_id = p_user_id;
    return;
  end if;

  if p_amount_cents is null or p_amount_cents < 1 then
    raise exception 'invalid_amount: a donation is at least 1 cent'
      using errcode = 'PT422';
  end if;

  if p_amount_cents > v_balance then
    raise exception 'insufficient_funds: the balance is lower than the donation'
      using errcode = 'PT402',
            hint = format('{"balanceCents": %s, "priceCents": %s}', v_balance, p_amount_cents);
  end if;

  perform private._post_ledger('donation', 'player:' || p_user_id::text, 'cncf', p_amount_cents,
                               p_user_id, null,
                               'donation:' || p_user_id::text || ':' || p_idempotency_key::text);

  update public.wallets as w
     set total_donated_cents = w.total_donated_cents + p_amount_cents
   where w.user_id = p_user_id;

  insert into public.donations (user_id, amount_cents, idempotency_key)
  values (p_user_id, p_amount_cents, p_idempotency_key);

  return query
    select w.balance_cents, w.total_donated_cents, w.aura_bps, false
    from public.wallets as w
    where w.user_id = p_user_id;
end
$$;

revoke all on function public.donate(uuid, bigint, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.donate(uuid, bigint, uuid, integer, integer) to service_role;

comment on function public.donate(uuid, bigint, uuid, integer, integer) is
  'Mock CNCF donation: debits 1 cent up to the stored balance to the cncf sink, '
  'increments total_donated_cents, and writes a donations row; idempotent by '
  'key. Service role only.';

-- ===========================================================================
-- 6. Admin: grants, hiding, and the game reset
-- ===========================================================================

-- Grants demo funds from mint: 1 to app_config admin_grant_max_cents
-- (default 10000, $100) per grant, idempotent by key (external_ref
-- grant:<key>), logged in admin_actions. Returns the new balance; a replay
-- returns the current balance and logs nothing. The admin route checks
-- requireAdmin() before calling it.
create or replace function public.admin_grant_funds(
  p_admin_id        uuid,
  p_user_id         uuid,
  p_amount_cents    bigint,
  p_idempotency_key uuid
)
returns bigint
language plpgsql
set search_path = ''
as $$
-- Lock order (section 5.1): wallets (3, the player's row) only.
declare
  v_max     bigint;
  v_ref     text;
  v_owner   uuid;
  v_balance bigint;
begin
  if p_admin_id is null or p_user_id is null or p_idempotency_key is null then
    raise exception 'invariant_violation: admin_grant_funds needs an admin, a player, and an idempotency key'
      using errcode = 'PT422';
  end if;

  v_max := coalesce(private._config_bigint('admin_grant_max_cents'), 0);
  if p_amount_cents is null or p_amount_cents < 1 or p_amount_cents > v_max then
    raise exception 'invalid_amount: a grant is 1 cent up to admin_grant_max_cents'
      using errcode = 'PT422';
  end if;

  select w.balance_cents into v_balance
  from public.wallets as w
  where w.user_id = p_user_id
  for update;

  if not found then
    raise exception 'not_found: admin_grant_funds got a player without a wallet'
      using errcode = 'PT404';
  end if;

  v_ref := 'grant:' || p_idempotency_key::text;

  select l.user_id into v_owner from public.ledger_entries as l where l.external_ref = v_ref;
  if found then
    if v_owner is distinct from p_user_id then
      raise exception 'idempotency_conflict: the grant key was used for another player'
        using errcode = 'PT409';
    end if;
    return v_balance;
  end if;

  perform private._post_ledger('admin_grant', 'mint', 'player:' || p_user_id::text,
                               p_amount_cents, p_user_id, null, v_ref);

  insert into public.admin_actions (admin_id, action, target)
  values (p_admin_id, 'admin_grant', format('%s:%s', p_user_id, p_amount_cents));

  select w.balance_cents into v_balance from public.wallets as w where w.user_id = p_user_id;
  return v_balance;
end
$$;

revoke all on function public.admin_grant_funds(uuid, uuid, bigint, uuid) from public, anon, authenticated;
grant execute on function public.admin_grant_funds(uuid, uuid, bigint, uuid) to service_role;

comment on function public.admin_grant_funds(uuid, uuid, bigint, uuid) is
  'Admin demo-funds grant from mint, 1 to admin_grant_max_cents, idempotent by '
  'key, logged in admin_actions; returns the new balance. Service role only.';

-- Hides or shows a player on the presence wall (section 9.7) and logs it.
-- get_live_players and presence_ping skip hidden players, and the feed's
-- pseudonymous player ids then resolve to nothing.
create or replace function public.admin_set_player_hidden(
  p_admin_id uuid,
  p_user_id  uuid,
  p_hidden   boolean
)
returns void
language plpgsql
set search_path = ''
as $$
-- Lock order (section 5.1): profiles (1, the player's row) only.
begin
  if p_admin_id is null or p_user_id is null or p_hidden is null then
    raise exception 'invariant_violation: admin_set_player_hidden needs an admin, a player, and a flag'
      using errcode = 'PT422';
  end if;

  update public.profiles as p
     set live_hidden = p_hidden
   where p.id = p_user_id;

  if not found then
    raise exception 'not_found: admin_set_player_hidden got an unknown player'
      using errcode = 'PT404';
  end if;

  insert into public.admin_actions (admin_id, action, target)
  values (p_admin_id, case when p_hidden then 'player_hidden' else 'player_unhidden' end, p_user_id::text);
end
$$;

revoke all on function public.admin_set_player_hidden(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.admin_set_player_hidden(uuid, uuid, boolean) to service_role;

comment on function public.admin_set_player_hidden(uuid, uuid, boolean) is
  'Sets profiles.live_hidden and logs player_hidden or player_unhidden. '
  'Service role only.';

-- Starts a new pig: sets current_level to p_level and increments pig_epoch,
-- so an in-flight win records as late_win. The treasury is untouched. Writes
-- a game_reset feed row and the admin log, and returns the new epoch.
create or replace function public.reset_game(p_admin_id uuid, p_level smallint default 1)
returns bigint
language plpgsql
set search_path = ''
as $$
-- Lock order (section 5.1): game_state (4) only.
declare
  v_epoch bigint;
begin
  if p_admin_id is null or p_level is null
     or not exists (select 1 from public.levels as l where l.id = p_level) then
    raise exception 'invariant_violation: reset_game needs an admin and a known level'
      using errcode = 'PT422';
  end if;

  update public.game_state as g
     set current_level = p_level,
         pig_epoch     = g.pig_epoch + 1
   where g.id = 1
  returning g.pig_epoch into v_epoch;

  if v_epoch is null then
    raise exception 'invariant_violation: there is no game_state row'
      using errcode = 'PT422';
  end if;

  insert into public.live_feed (event_type, level_id)
  values ('game_reset', p_level);

  insert into public.admin_actions (admin_id, action, target)
  values (p_admin_id, 'game_reset', format('level:%s:epoch:%s', p_level, v_epoch));

  return v_epoch;
end
$$;

revoke all on function public.reset_game(uuid, smallint) from public, anon, authenticated;
grant execute on function public.reset_game(uuid, smallint) to service_role;

comment on function public.reset_game(uuid, smallint) is
  'Sets the level, increments pig_epoch, leaves the treasury unchanged, writes '
  'a game_reset feed row and the admin log; returns the new epoch. Service role only.';

-- ===========================================================================
-- 7. remove_keyword (R1-01, section 6.10)
-- ===========================================================================
-- The targeted recovery for a poisoned keyword, run from the SQL runbook:
-- copies the level's active rules without p_keyword into a new active
-- version n + 1 (source admin_remove_keyword, parent = the previous active
-- row), marks the previous row superseded, and logs admin_actions. Every
-- other keyword (in order) and every flag is kept, so later hardening
-- survives, unlike a full rollback. A keyword that the active rules do not
-- hold raises PT404 not_found. The activation trigger writes the
-- rules_reset feed row. The admin log names the level and the new rule set,
-- never the keyword text, which is attacker-derived.
create or replace function public.remove_keyword(
  p_admin_id uuid,
  p_level_id smallint,
  p_keyword  text
)
returns uuid
language plpgsql
set search_path = ''
as $$
-- Lock order (section 5.1): levels (6, FOR NO KEY UPDATE, as in 00003) ->
-- rule_sets (7, the level's active row).
declare
  v_active public.rule_sets%rowtype;
  v_rules  jsonb;
  v_id     uuid;
begin
  if p_admin_id is null or p_level_id is null or p_keyword is null then
    raise exception 'invariant_violation: remove_keyword needs an admin, a level, and a keyword'
      using errcode = 'PT422';
  end if;

  perform 1 from public.levels as l where l.id = p_level_id for no key update;
  if not found then
    raise exception 'invariant_violation: remove_keyword got an unknown level'
      using errcode = 'PT422';
  end if;

  select * into v_active
  from public.rule_sets as rs
  where rs.level_id = p_level_id and rs.state = 'active'::public.rule_set_state
  for no key update;

  if v_active.id is null then
    raise exception 'invariant_violation: the level has no active rule set'
      using errcode = 'PT422';
  end if;

  if not ((v_active.rules -> 'block_keywords') ? p_keyword) then
    raise exception 'not_found: the active rule set of this level has no such keyword'
      using errcode = 'PT404';
  end if;

  v_rules := jsonb_set(
    v_active.rules,
    '{block_keywords}',
    coalesce(
      (select jsonb_agg(k.value order by k.ord)
         from jsonb_array_elements(v_active.rules -> 'block_keywords') with ordinality as k (value, ord)
        where k.value <> to_jsonb(p_keyword)),
      '[]'::jsonb));

  -- The previous row leaves the active state first: the partial unique index
  -- allows one active row per level at every moment.
  update public.rule_sets as rs
     set state = 'superseded'::public.rule_set_state, deactivated_at = now()
   where rs.id = v_active.id;

  insert into public.rule_sets (
    level_id, version, parent_id, state, rules, rules_sha256, source, activated_at
  ) values (
    p_level_id, v_active.version + 1, v_active.id, 'active'::public.rule_set_state,
    v_rules, private.rule_set_sha256(v_rules), 'admin_remove_keyword', now()
  )
  returning id into v_id;

  insert into public.admin_actions (admin_id, action, target)
  values (p_admin_id, 'keyword_removed', format('level:%s:rule_set:%s', p_level_id, v_id));

  return v_id;
end
$$;

revoke all on function public.remove_keyword(uuid, smallint, text) from public, anon, authenticated;
grant execute on function public.remove_keyword(uuid, smallint, text) to service_role;

comment on function public.remove_keyword(uuid, smallint, text) is
  'SQL runbook only. Activates version n + 1 of the level''s rules without the '
  'keyword (source admin_remove_keyword), supersedes the previous row, and logs '
  'keyword_removed. Service role only.';

-- ===========================================================================
-- 8. Retention (CH-7)
-- ===========================================================================

-- Nulls attempts.prompt and attempts.reply for finalized attempts older than
-- p_older_than_days (1..3650) that are not paid wins. Paid-win prompts stay
-- on the attempt and in golden_prompts indefinitely, because every later
-- rule set must keep blocking them (HC-A3). Returns the number purged.
create or replace function public.purge_raw_prompts(p_older_than_days integer)
returns integer
language plpgsql
set search_path = ''
as $$
-- Lock order (section 5.1): attempts (5), the purged rows in ascending id.
-- Only finalized rows are touched, and no other function locks a finalized
-- attempt.
declare
  v_count integer;
begin
  if p_older_than_days is null or p_older_than_days not between 1 and 3650 then
    raise exception 'invariant_violation: purge_raw_prompts needs 1..3650 days'
      using errcode = 'PT422';
  end if;

  with doomed as (
    select a.id
    from public.attempts as a
    where a.prompt is not null
      and a.created_at < now() - make_interval(days => p_older_than_days)
      and a.outcome not in ('pending'::public.attempt_outcome, 'win'::public.attempt_outcome)
    order by a.id
    for update
  )
  update public.attempts as a
     set prompt = null, reply = null
    from doomed as d
   where a.id = d.id;

  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke all on function public.purge_raw_prompts(integer) from public, anon, authenticated;
grant execute on function public.purge_raw_prompts(integer) to service_role;

comment on function public.purge_raw_prompts(integer) is
  'Nulls prompt and reply past retention for finalized attempts that are not '
  'paid wins; returns the count (CH-7). Service role only.';

-- Deletes live_feed rows older than p_keep_days (1..3650) and returns the
-- count. Realtime does not deliver these deletes to clients in a form that
-- leaks anything: the rows are public by design (section 5.5).
create or replace function public.prune_live_feed(p_keep_days integer)
returns integer
language plpgsql
set search_path = ''
as $$
-- Lock order (section 5.1): no row lock another function waits on; it
-- deletes old append-only feed rows.
declare
  v_count integer;
begin
  if p_keep_days is null or p_keep_days not between 1 and 3650 then
    raise exception 'invariant_violation: prune_live_feed needs 1..3650 days'
      using errcode = 'PT422';
  end if;

  delete from public.live_feed as f
   where f.created_at < now() - make_interval(days => p_keep_days);

  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke all on function public.prune_live_feed(integer) from public, anon, authenticated;
grant execute on function public.prune_live_feed(integer) to service_role;

comment on function public.prune_live_feed(integer) is
  'Deletes live_feed rows older than the given days; returns the count. Service role only.';

-- ===========================================================================
-- 9. Self-check: fail loudly if a privilege is not as intended
-- ===========================================================================
do $$
declare
  v_functions text[] := array[
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
    'public.prune_live_feed(integer)'];
  v_problem   text;
begin
  select string_agg(format('%s:%s', r.role_name, f.fn), ', ')
    into v_problem
  from (values ('anon', false), ('authenticated', false), ('service_role', true)) as r (role_name, expected)
  cross join unnest(v_functions) as f (fn)
  where has_function_privilege(r.role_name, f.fn, 'EXECUTE') <> r.expected;

  if v_problem is not null then
    raise exception '00006: function EXECUTE grants are not service_role only: %', v_problem;
  end if;
end
$$;
