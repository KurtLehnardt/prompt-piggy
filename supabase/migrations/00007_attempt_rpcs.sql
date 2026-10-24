-- Migration 00007: the atomic attempt RPCs (task PP-22)
--
-- Contents (docs/ARCHITECTURE.md sections 5.1, 5.4, 6.2, 9.1, 9.2, 9.4, 11):
--   1. private._attempt_replay: the start_attempt row of an existing attempt,
--      used for idempotent replays (R2-05).
--   2. start_attempt: the $1 fee before any model call, with the pinned
--      level, epoch, rule set, and level secret (CH-1, R2-12, R2-20, R2-29).
--   3. record_attempt: the finalization of an attempt: the whole-pot payout,
--      the treasury reset, the level advance, the fingerprint block, the
--      hardening job, the breach row, and persistent cracks (CH-1, CH-6b,
--      R1-03, HC-A5); errors go through private._finalize_attempt_error
--      (R2-04).
--   4. attempt_result: the stored result of the caller's own finalized
--      attempt (R2-05, R2-14).
--   5. A self-check that fails the migration if a privilege is not as
--      intended.
--
-- Money is mocked US dollars in bigint integer cents (CH-1). The price comes
-- from app_config attempt_price_cents and is stored on the attempt; the
-- payout is the stored treasury; the seed comes from app_config
-- treasury_seed_cents. No amount is ever a parameter (the skylite 00038
-- lesson). Every balance and treasury change goes through
-- private._post_ledger, and every movement carries a unique external_ref:
--   fee:<attempt id>          attempt_fee          (start_attempt)
--   payout:<attempt id>       payout               (record_attempt, paid win)
--   seed:epoch:<new epoch>    mint_treasury_seed   (record_attempt, paid win, seed > 0)
--   refund:<attempt id>       attempt_refund or refund_mint (private._finalize_attempt_error)
--
-- HC3 and HC-A5: p_prompt and p_reply are stored only. No user text decides
-- a transition: the outcome is an enum and the flags are booleans computed by
-- server code. The crack count is never part of start_attempt's result, so
-- it can never reach the AI layer; only record_attempt and repair_glass
-- assign wallets.crack_count.
--
-- Every function is SECURITY INVOKER, sets search_path = '', and
-- schema-qualifies every table, type, and function it uses; only pg_catalog
-- built-ins stay unqualified (R2-17). Each one is executable by service_role
-- only.
--
-- Errors use the PTnnn SQLSTATE convention (section 5.1). The message starts
-- with the token that src/lib/errors.ts recognizes, and the hints follow the
-- PP-04 JSON contract:
--   PT402 insufficient_funds   {"balanceCents": n, "priceCents": n}; nothing is charged
--   PT403 forbidden            the player has no wallet (an anonymous session)
--   PT404 not_found            record_attempt got an unknown attempt
--   PT409 attempt_in_flight    {"sameKey": bool, "retryAfterSeconds": n}, n >= 1
--   PT409 pig_changed          {"pigEpoch": n, "level": n}; nothing is charged
--   PT409 already_finalized    record_attempt on an attempt that is not pending
--   PT422 invariant_violation  a missing, out-of-range, or inconsistent argument
--   PT429 rate_limited         {"retryAfterSeconds": n}
--   PT429 daily_cap            the player's attempts for the UTC day are used up
--   PT503 kill_switch          kill_switch on or attempts_enabled off
--   PT503 level_not_configured level 4 or 5 without a level_secrets row; nothing is charged
--   PT503 spend_cap            the reservation would pass the attempts' share
--                              or the daily cap; the whole transaction,
--                              fee included, rolls back (errors.ts maps it to
--                              spend_cap_reached)
--
-- Global lock order (section 5.1, R1-02), the same in every row-locking RPC
-- of 00006 and 00007: profiles (1), rate_limits (2), wallets (3),
-- game_state (4), attempts (5), levels (6), rule_sets (7),
-- blocked_fingerprints (8), hardening_jobs (9), leases (10), ai_spend (11)
-- last. Rows of one table are locked in ascending primary-key order. A
-- comment at the top of each function body lists the order it uses.
-- Append-only inserts (ledger_entries, live_feed, golden_prompts) take no
-- lock that another transaction waits on in a cycle. Reads of rule_sets,
-- level_secrets, blocked_fingerprints, and app_config take no lock.
--
-- Re-runnable: create or replace function, and REVOKE and GRANT, which are
-- idempotent by nature.

-- ===========================================================================
-- 1. private._attempt_replay
-- ===========================================================================
-- The start_attempt row of an existing attempt, with replay = true: its
-- pinned level, epoch, and rule set, the price it paid, and the current
-- wallet and treasury. level_secret is null on a replay, because a replay
-- never runs the model; the route reads the stored outcome with
-- attempt_result. Reads only, no lock.
create or replace function private._attempt_replay(p_attempt_id uuid)
returns table (attempt_id uuid, level_id smallint, pig_epoch bigint, rule_set_id uuid, rules jsonb,
               rule_version integer, level_secret jsonb, fingerprint_blocked boolean, price_cents bigint,
               wallet_balance_cents bigint, treasury_cents bigint, replay boolean)
language sql
stable
set search_path = ''
as $$
  -- Lock order (section 5.1): no lock; a plain read.
  select a.id, a.level_id, a.pig_epoch, a.rule_set_id, rs.rules, rs.version, null::jsonb,
         exists (select 1 from public.blocked_fingerprints as bf where bf.fingerprint = a.prompt_fingerprint),
         a.price_cents, w.balance_cents, g.treasury_cents, true
  from public.attempts as a
  join public.rule_sets as rs on rs.id = a.rule_set_id
  join public.wallets as w on w.user_id = a.user_id
  cross join public.game_state as g
  where a.id = p_attempt_id and g.id = 1;
$$;

revoke all on function private._attempt_replay(uuid) from public, anon, authenticated;
grant execute on function private._attempt_replay(uuid) to service_role;

comment on function private._attempt_replay(uuid) is
  'The start_attempt result row of an existing attempt with replay = true and '
  'no level secret. Service role only.';

-- ===========================================================================
-- 2. start_attempt
-- ===========================================================================
-- Opens an attempt and takes its fee, atomically, before any model call
-- (CH-1). Steps (section 5.4):
--   0. Bounds on every parameter (PT422). p_stale_seconds is 30..300; the
--      route passes 45 (R2-13).
--   1. Fast path without a lock: the same key on a finalized attempt returns
--      it with replay = true (R2-05); on a pending attempt younger than
--      p_stale_seconds it raises attempt_in_flight with sameKey true. A
--      pending attempt is never resumed (R1-05). A stale pending attempt with
--      the same key goes straight to the locked recovery of step 4 (R3-06),
--      skipping the kill switch and the rate limits, because recovering it
--      charges nothing.
--   2. kill_switch on or attempts_enabled off -> PT503 kill_switch.
--   3. The attempt token bucket and the daily count (rate_limits, locked in
--      ascending key order: attempt, attempt_daily). Both are only checked
--      here and consumed after the fee, so a refused or replayed call
--      consumes nothing.
--   4. The wallet lock. The same-key lookup repeats under it (R2-05), so two
--      requests with one key serialize here and the second replays or raises
--      attempt_in_flight, never a unique violation. A stale same-key attempt
--      is reaped through private._finalize_attempt_error ('reaped', within
--      the refund budget) and returned with replay = true (R3-06). Another
--      pending attempt of the player raises attempt_in_flight with sameKey
--      false while it is fresh and is reaped the same way once it is stale.
--      A balance below the price raises PT402.
--   5. The game_state lock. A stale p_expected_epoch raises pig_changed with
--      the current epoch and level (R2-20); level 4 or 5 without a
--      level_secrets row raises level_not_configured (R2-12). Both charge
--      nothing. Then the fee: the attempt id is generated first, so the fee's
--      ledger row carries it (R2-29).
--   6. fingerprint_blocked: the prompt's fingerprint is on the exact-replay
--      blocklist (CH-6b). A blocked attempt reserves no AI spend.
--   7. The pinned rule set and, at levels 4 and 5, the level secret payload
--      (plain reads).
--   8. The attempt row and the wallet's in-flight marker.
--   9. The spend reservation, last (R1-02): over the attempts' share or the
--      daily cap -> PT503 spend_cap, and the whole transaction rolls back.
-- The result carries no crack count (HC3).
create or replace function public.start_attempt(
  p_user_id             uuid,
  p_idempotency_key     uuid,
  p_expected_epoch      bigint,
  p_prompt              text,
  p_prompt_sha256       text,
  p_prompt_fingerprint  text,
  p_reserve_micros      bigint,
  p_daily_cap_micros    bigint,
  p_attempt_share_bps   integer,
  p_rate_capacity       integer,
  p_rate_refill_per_min integer,
  p_daily_attempt_cap   integer,
  p_stale_seconds       integer
)
returns table (attempt_id uuid, level_id smallint, pig_epoch bigint, rule_set_id uuid, rules jsonb,
               rule_version integer, level_secret jsonb, fingerprint_blocked boolean, price_cents bigint,
               wallet_balance_cents bigint, treasury_cents bigint, replay boolean)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
-- Lock order (section 5.1): rate_limits (2, the attempt bucket, then the
-- attempt_daily row) -> wallets (3, the caller's row) -> game_state (4) ->
-- attempts (5, only a stale pending row being reaped) -> ai_spend (11,
-- inside private._finalize_attempt_error for a reaped row, on its
-- spend_day, and then the reservation on current_date, so day rows are
-- locked in ascending order). The same-key recovery path skips
-- rate_limits. The new attempt row is inserted, not locked.
declare
  v_stale       interval;
  v_prev_id     uuid;
  v_prev_state  public.attempt_outcome;
  v_prev_at     timestamptz;
  v_recover     boolean := false;
  v_tokens      numeric;
  v_refilled_at timestamptz;
  v_daily       numeric;
  v_window      date;
  v_balance     bigint;
  v_flight_id   uuid;
  v_flight_st   public.attempt_outcome;
  v_flight_at   timestamptz;
  v_flight_res  bigint;
  v_price       bigint;
  v_epoch       bigint;
  v_level       smallint;
  v_rule_set    uuid;
  v_rules       jsonb;
  v_version     integer;
  v_secret      jsonb;
  v_id          uuid;
  v_blocked     boolean;
  v_reserved    bigint;
begin
  -- 0. Bounds.
  if p_user_id is null or p_idempotency_key is null
     or p_expected_epoch is null or p_expected_epoch < 1
     or p_prompt is null or char_length(p_prompt) not between 1 and 4000
     or p_prompt_sha256 is null or p_prompt_sha256 !~ '^[0-9a-f]{64}$'
     or p_prompt_fingerprint is null or p_prompt_fingerprint !~ '^[0-9a-f]{64}$'
     or p_reserve_micros is null or p_reserve_micros not between 1 and 1000000000000
     or p_daily_cap_micros is null or p_daily_cap_micros not between 1 and 1000000000000
     or p_attempt_share_bps is null or p_attempt_share_bps not between 1 and 10000
     or p_rate_capacity is null or p_rate_capacity not between 1 and 100
     or p_rate_refill_per_min is null or p_rate_refill_per_min not between 1 and 600
     or p_daily_attempt_cap is null or p_daily_attempt_cap not between 1 and 10000
     or p_stale_seconds is null or p_stale_seconds not between 30 and 300 then
    raise exception 'invariant_violation: start_attempt got a missing or out-of-range argument'
      using errcode = 'PT422';
  end if;

  v_stale := make_interval(secs => p_stale_seconds);

  if not exists (select 1 from public.wallets as w where w.user_id = p_user_id) then
    raise exception 'forbidden: start_attempt needs a player with a wallet'
      using errcode = 'PT403';
  end if;

  -- 1. Fast path, no lock (the unique key indexes the lookup).
  select a.id, a.outcome, a.created_at
    into v_prev_id, v_prev_state, v_prev_at
  from public.attempts as a
  where a.user_id = p_user_id and a.idempotency_key = p_idempotency_key;

  if v_prev_id is not null then
    if v_prev_state <> 'pending'::public.attempt_outcome then
      return query select * from private._attempt_replay(v_prev_id);
      return;
    end if;
    if v_prev_at > now() - v_stale then
      raise exception 'attempt_in_flight: this attempt is still running'
        using errcode = 'PT409',
              hint = format('{"sameKey": true, "retryAfterSeconds": %s}',
                            greatest(1, ceil(extract(epoch from (v_prev_at + v_stale) - now())))::integer);
    end if;
    v_recover := true;
  end if;

  if not v_recover then
    -- 2. Kill switch (fail closed when a key is missing).
    if private._config_bool('kill_switch', true) or not private._config_bool('attempts_enabled', false) then
      raise exception 'kill_switch: attempts are paused'
        using errcode = 'PT503';
    end if;

    -- 3. Rate limits: checked now, consumed after the fee.
    insert into public.rate_limits (user_id, bucket, tokens, updated_at)
    values (p_user_id, 'attempt', p_rate_capacity, now())
    on conflict (user_id, bucket) do nothing;

    select r.tokens, r.updated_at
      into v_tokens, v_refilled_at
    from public.rate_limits as r
    where r.user_id = p_user_id and r.bucket = 'attempt'
    for update;

    v_tokens := least(p_rate_capacity::numeric,
                      v_tokens + greatest(0, extract(epoch from now() - v_refilled_at)) * p_rate_refill_per_min / 60.0);

    if v_tokens < 1 then
      raise exception 'rate_limited: the attempt bucket is empty'
        using errcode = 'PT429',
              hint = format('{"retryAfterSeconds": %s}',
                            greatest(1, ceil((1 - v_tokens) * 60.0 / p_rate_refill_per_min))::integer);
    end if;

    insert into public.rate_limits (user_id, bucket, tokens, window_day, updated_at)
    values (p_user_id, 'attempt_daily', 0, current_date, now())
    on conflict (user_id, bucket) do nothing;

    select r.tokens, r.window_day
      into v_daily, v_window
    from public.rate_limits as r
    where r.user_id = p_user_id and r.bucket = 'attempt_daily'
    for update;

    if v_window is distinct from current_date then
      v_daily := 0;
    end if;

    if v_daily >= p_daily_attempt_cap then
      raise exception 'daily_cap: the attempts for today are used up'
        using errcode = 'PT429';
    end if;
  end if;

  -- 4. The wallet lock, and the same-key re-check under it (R2-05).
  select w.balance_cents, w.in_flight_attempt_id
    into v_balance, v_flight_id
  from public.wallets as w
  where w.user_id = p_user_id
  for update;

  if not found then
    raise exception 'forbidden: start_attempt needs a player with a wallet'
      using errcode = 'PT403';
  end if;

  -- Every finalizer takes this wallet lock first, so the state read here
  -- cannot change until this transaction ends.
  select a.id, a.outcome, a.created_at
    into v_prev_id, v_prev_state, v_prev_at
  from public.attempts as a
  where a.user_id = p_user_id and a.idempotency_key = p_idempotency_key;

  if v_prev_id is not null then
    if v_prev_state <> 'pending'::public.attempt_outcome then
      return query select * from private._attempt_replay(v_prev_id);
      return;
    end if;
    if v_prev_at > now() - v_stale then
      raise exception 'attempt_in_flight: this attempt is still running'
        using errcode = 'PT409',
              hint = format('{"sameKey": true, "retryAfterSeconds": %s}',
                            greatest(1, ceil(extract(epoch from (v_prev_at + v_stale) - now())))::integer);
    end if;
    -- A stale attempt with this key (R3-06): settle it through the budgeted
    -- error path, then replay it.
    perform 1 from public.game_state as g where g.id = 1 for update;
    select a.reserved_micros into v_flight_res
    from public.attempts as a
    where a.id = v_prev_id
    for update;
    perform private._finalize_attempt_error(v_prev_id, 'reaped', v_flight_res);
    return query select * from private._attempt_replay(v_prev_id);
    return;
  end if;

  if v_recover then
    raise exception 'invariant_violation: the stale attempt for this key disappeared'
      using errcode = 'PT422';
  end if;

  -- Another attempt of this player still in flight. The marker is the
  -- primary source; a pending row without a marker is caught as well.
  if v_flight_id is null then
    select a.id into v_flight_id
    from public.attempts as a
    where a.user_id = p_user_id and a.outcome = 'pending'::public.attempt_outcome
    order by a.created_at, a.id
    limit 1;
  end if;

  if v_flight_id is not null then
    select a.outcome, a.created_at
      into v_flight_st, v_flight_at
    from public.attempts as a
    where a.id = v_flight_id;

    if v_flight_st = 'pending'::public.attempt_outcome then
      if v_flight_at > now() - v_stale then
        raise exception 'attempt_in_flight: another attempt of this player is still running'
          using errcode = 'PT409',
                hint = format('{"sameKey": false, "retryAfterSeconds": %s}',
                              greatest(1, ceil(extract(epoch from (v_flight_at + v_stale) - now())))::integer);
      end if;
      -- Stranded by a killed function: reap it first (refund within the budget).
      perform 1 from public.game_state as g where g.id = 1 for update;
      select a.reserved_micros into v_flight_res
      from public.attempts as a
      where a.id = v_flight_id
      for update;
      perform private._finalize_attempt_error(v_flight_id, 'reaped', v_flight_res);
      select w.balance_cents into v_balance from public.wallets as w where w.user_id = p_user_id;
    end if;
  end if;

  v_price := private._config_bigint('attempt_price_cents');
  if v_price is null or v_price < 1 then
    raise exception 'invariant_violation: app_config has no attempt_price_cents'
      using errcode = 'PT422';
  end if;

  if v_balance < v_price then
    raise exception 'insufficient_funds: the balance is lower than the attempt price'
      using errcode = 'PT402',
            hint = format('{"balanceCents": %s, "priceCents": %s}', v_balance, v_price);
  end if;

  -- 5. The game_state lock: the pinned epoch and level.
  select g.pig_epoch, g.current_level
    into v_epoch, v_level
  from public.game_state as g
  where g.id = 1
  for update;

  if not found then
    raise exception 'invariant_violation: there is no game_state row'
      using errcode = 'PT422';
  end if;

  if v_epoch <> p_expected_epoch then
    raise exception 'pig_changed: the pig moved on since this attack was written'
      using errcode = 'PT409',
            hint = format('{"pigEpoch": %s, "level": %s}', v_epoch, v_level);
  end if;

  -- 7 (read before the fee, so a missing row charges nothing). Plain reads.
  if v_level in (4, 5) then
    select ls.payload into v_secret
    from public.level_secrets as ls
    where ls.level_id = v_level;

    if v_secret is null then
      raise exception 'level_not_configured: this level has no level_secrets row'
        using errcode = 'PT503';
    end if;
  end if;

  select rs.id, rs.rules, rs.version
    into v_rule_set, v_rules, v_version
  from public.rule_sets as rs
  where rs.level_id = v_level and rs.state = 'active'::public.rule_set_state;

  if v_rule_set is null then
    raise exception 'invariant_violation: the level has no active rule set'
      using errcode = 'PT422';
  end if;

  -- The fee, before any model call (CH-1). The id comes first (R2-29).
  v_id := gen_random_uuid();
  perform private._post_ledger('attempt_fee', 'player:' || p_user_id::text, 'treasury',
                               v_price, p_user_id, v_id, 'fee:' || v_id::text);

  update public.game_state as g
     set total_attempts = g.total_attempts + 1
   where g.id = 1;

  -- The rate-limit rows locked in step 3 are consumed now.
  update public.rate_limits as r
     set tokens = round(v_tokens - 1, 4), updated_at = now()
   where r.user_id = p_user_id and r.bucket = 'attempt';

  update public.rate_limits as r
     set tokens = v_daily + 1, window_day = current_date, updated_at = now()
   where r.user_id = p_user_id and r.bucket = 'attempt_daily';

  -- 6. The exact-replay blocklist (plain read).
  v_blocked := exists (
    select 1 from public.blocked_fingerprints as bf where bf.fingerprint = p_prompt_fingerprint);
  v_reserved := case when v_blocked then 0 else p_reserve_micros end;

  -- 8. The attempt and the in-flight marker.
  insert into public.attempts (
    id, user_id, level_id, pig_epoch, rule_set_id, idempotency_key, prompt, prompt_sha256,
    prompt_fingerprint, prompt_chars, price_cents, reserved_micros, spend_day
  ) values (
    v_id, p_user_id, v_level, v_epoch, v_rule_set, p_idempotency_key, p_prompt, p_prompt_sha256,
    p_prompt_fingerprint, char_length(p_prompt), v_price, v_reserved, current_date
  );

  update public.wallets as w
     set in_flight_attempt_id = v_id,
         total_attempts       = w.total_attempts + 1,
         last_seen_at         = now()
   where w.user_id = p_user_id;

  -- 9. The spend reservation, last (R1-02, R1-09).
  insert into public.ai_spend (day) values (current_date)
  on conflict (day) do nothing;

  update public.ai_spend as s
     set attempt_reserved_micros = s.attempt_reserved_micros + v_reserved,
         attempt_calls           = s.attempt_calls + case when v_reserved > 0 then 1 else 0 end,
         updated_at              = now()
   where s.day = current_date
     and s.attempt_reserved_micros + s.attempt_settled_micros + v_reserved
         <= p_daily_cap_micros * p_attempt_share_bps / 10000
     and s.attempt_reserved_micros + s.attempt_settled_micros
         + s.hardening_reserved_micros + s.hardening_settled_micros + v_reserved
         <= p_daily_cap_micros;

  if not found then
    raise exception 'spend_cap: the daily AI budget for attempts is used up'
      using errcode = 'PT503';
  end if;

  return query
    select v_id, v_level, v_epoch, v_rule_set, v_rules, v_version, v_secret, v_blocked, v_price,
           w.balance_cents, g.treasury_cents, false
    from public.wallets as w cross join public.game_state as g
    where w.user_id = p_user_id and g.id = 1;
end
$$;

revoke all on function public.start_attempt(uuid, uuid, bigint, text, text, text, bigint, bigint, integer, integer, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.start_attempt(uuid, uuid, bigint, text, text, text, bigint, bigint, integer, integer, integer, integer, integer)
  to service_role;

comment on function public.start_attempt(uuid, uuid, bigint, text, text, text, bigint, bigint, integer, integer, integer, integer, integer) is
  'Opens an attempt and debits app_config attempt_price_cents from the wallet '
  'to the treasury before any model call, pinning the level, epoch, rule set, '
  'and level secret; idempotent by key with a re-check under the wallet lock; '
  'refusals charge nothing. The result has no crack count (HC3). Service role only.';

-- ===========================================================================
-- 3. record_attempt
-- ===========================================================================
-- Finalizes a pending attempt exactly once. Steps (section 5.4):
--   0. Invariants (PT422): the outcome is not pending or late_win (the
--      database derives late_win); win needs p_tool_called and no canary
--      leak; leak_blocked needs p_canary_leaked; blocked needs no tool call;
--      error needs a system error code, never one an attacker can produce;
--      fail allows an optional detail code from a fixed list; win, blocked,
--      and leak_blocked take no code; p_block_fingerprint needs win;
--      p_user_jobs_per_hour is 1..20; reason and signal codes are short
--      lowercase codes.
--   1-3. The wallet, game_state, and attempt locks; a finalized attempt
--      raises PT409 already_finalized (T12).
--   R3-07. A reply longer than attempts.reply allows (1200 characters)
--      cannot be stored, so the attempt settles as error reply_unstorable
--      under the refund budget instead of failing and waiting for the reaper.
--   4. error: stores the validator and model flags, then
--      private._finalize_attempt_error finalizes it, refunds within the
--      budget, and settles spend once; it returns at once (R2-04). No feed
--      row, and cracks are unchanged.
--   5. A paid win (the pinned epoch is current): the whole treasury to the
--      winner, the treasury reset to treasury_seed_cents, the level advanced
--      by one (5 stays 5), the epoch incremented, the fingerprint blocked,
--      the hardening job queued (within the per-user cap, while
--      hardening_enabled is on; it is never processed here), and the breach
--      row in golden_prompts (add_breach_to_golden). A win for an epoch that
--      moved on is late_win: no money, fingerprint, job, or breach row.
--      fail, blocked, and leak_blocked add one crack up to 3 (crack, crack,
--      shatter, then none). win, late_win, and error leave cracks unchanged,
--      and nothing resets them automatically (CH-1).
--   6. The attempt row and the wallet.
--   7. live_feed: one attempt row, plus level_advanced when a paid win moved
--      the pig to a higher level.
--   8. Spend settled last, on the reservation's day.
create or replace function public.record_attempt(
  p_attempt_id           uuid,
  p_outcome              public.attempt_outcome,
  p_reply                text,
  p_validator_reasons    text[],
  p_validator_signals    text[],
  p_tripwire_probability real,
  p_technique            public.attack_technique,
  p_canary_leaked        boolean,
  p_tool_called          boolean,
  p_cost_micros          bigint,
  p_error_code           text,
  p_block_fingerprint    boolean,
  p_user_jobs_per_hour   integer
)
returns table (outcome public.attempt_outcome, crack_event public.crack_event, cracks_after smallint,
               payout_cents bigint, refund_cents bigint, refund_withheld boolean, wallet_balance_cents bigint,
               aura_bps integer, treasury_cents bigint, current_level smallint, pig_epoch bigint,
               level_from smallint, level_to smallint, hardening_job_id uuid)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
-- Lock order (section 5.1): wallets (3, the attempt's player) -> game_state
-- (4) -> attempts (5, this row) -> blocked_fingerprints (8, insert on
-- conflict do nothing) -> hardening_jobs (9, insert) -> ai_spend (11, the
-- attempt's spend_day) last. The error path hands the same order to
-- private._finalize_attempt_error.
declare
  v_fail_codes constant text[] := array[
    'incomplete', 'content_filter', 'empty_output', 'input_rejected', 'model_behavior', 'max_turns'];
  v_code_re    constant text := '^[a-z][a-z_]{1,39}$';
  v_reasons    text[] := coalesce(p_validator_reasons, '{}');
  v_signals    text[] := coalesce(p_validator_signals, '{}');
  v_user       uuid;
  v_cracks     smallint;
  v_new_cracks smallint;
  v_event      public.crack_event := 'none';
  v_game       public.game_state%rowtype;
  v_attempt    public.attempts%rowtype;
  v_outcome    public.attempt_outcome := p_outcome;
  v_error      text := p_error_code;
  v_paid       boolean := false;
  v_payout     bigint := 0;
  v_seed       bigint;
  v_new_epoch  bigint;
  v_from       smallint;
  v_to         smallint;
  v_job        uuid;
  v_refund     bigint;
  v_withheld   boolean;
begin
  -- 0. Invariants.
  if p_attempt_id is null or p_outcome is null
     or p_outcome in ('pending'::public.attempt_outcome, 'late_win'::public.attempt_outcome)
     or p_canary_leaked is null or p_tool_called is null or p_block_fingerprint is null
     or p_cost_micros is null or p_cost_micros not between 0 and 1000000000000
     or p_user_jobs_per_hour is null or p_user_jobs_per_hour not between 1 and 20
     or (p_tripwire_probability is not null and not (p_tripwire_probability between 0 and 1))
     or cardinality(v_reasons) > 32 or cardinality(v_signals) > 32
     or exists (select 1 from unnest(v_reasons) as r (code) where r.code is null or r.code !~ v_code_re)
     or exists (select 1 from unnest(v_signals) as s (code) where s.code is null or s.code !~ v_code_re)
     or (p_error_code is not null and p_error_code !~ '^[a-z_]{3,40}$')
     or (p_outcome = 'win'::public.attempt_outcome and (not p_tool_called or p_canary_leaked))
     or (p_outcome = 'leak_blocked'::public.attempt_outcome and not p_canary_leaked)
     or (p_outcome = 'blocked'::public.attempt_outcome and p_tool_called)
     or (p_outcome = 'error'::public.attempt_outcome
         and (p_error_code is null or p_error_code = any (v_fail_codes)))
     or (p_outcome = 'fail'::public.attempt_outcome
         and p_error_code is not null and not (p_error_code = any (v_fail_codes)))
     or (p_outcome in ('win'::public.attempt_outcome, 'blocked'::public.attempt_outcome,
                       'leak_blocked'::public.attempt_outcome)
         and p_error_code is not null)
     or (p_block_fingerprint and p_outcome <> 'win'::public.attempt_outcome) then
    raise exception 'invariant_violation: record_attempt got a missing, out-of-range, or inconsistent argument'
      using errcode = 'PT422';
  end if;

  -- 1. The player (user_id never changes, so it is read without a lock),
  --    then the wallet lock.
  select a.user_id into v_user from public.attempts as a where a.id = p_attempt_id;
  if v_user is null then
    raise exception 'not_found: record_attempt got an unknown attempt'
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

  -- 2. The game_state lock.
  select * into v_game from public.game_state as g where g.id = 1 for update;

  -- 3. The attempt lock; exactly once (T12).
  select * into v_attempt from public.attempts as a where a.id = p_attempt_id for update;

  if v_attempt.outcome <> 'pending'::public.attempt_outcome then
    raise exception 'already_finalized: the attempt is no longer pending'
      using errcode = 'PT409';
  end if;

  -- R3-07: a reply that cannot be stored settles as a budgeted error.
  if v_outcome <> 'error'::public.attempt_outcome and p_reply is not null and char_length(p_reply) > 1200 then
    v_outcome := 'error';
    v_error   := 'reply_unstorable';
  end if;

  -- 4. error (R2-04): the budgeted error path, and return at once.
  if v_outcome = 'error'::public.attempt_outcome then
    update public.attempts as a
       set validator_reasons    = v_reasons,
           validator_signals    = v_signals,
           tripwire_probability = p_tripwire_probability,
           technique            = p_technique,
           canary_leaked        = p_canary_leaked,
           tool_called          = p_tool_called
     where a.id = p_attempt_id;

    select f.refund_cents, f.refund_withheld
      into v_refund, v_withheld
    from private._finalize_attempt_error(p_attempt_id, v_error, p_cost_micros) as f;

    return query
      select a.outcome, a.crack_event, a.cracks_after, a.payout_cents, v_refund, v_withheld,
             w.balance_cents, w.aura_bps, g.treasury_cents, g.current_level, g.pig_epoch,
             null::smallint, null::smallint, null::uuid
      from public.attempts as a
      join public.wallets as w on w.user_id = a.user_id
      cross join public.game_state as g
      where a.id = p_attempt_id and g.id = 1;
    return;
  end if;

  -- 5. The transition (with repair_glass, the only code that changes cracks).
  v_new_cracks := v_cracks;

  if v_outcome = 'win'::public.attempt_outcome then
    v_paid := v_attempt.pig_epoch = v_game.pig_epoch
              and not exists (select 1 from public.attempts as x
                              where x.pig_epoch = v_attempt.pig_epoch
                                and x.outcome = 'win'::public.attempt_outcome);
    if not v_paid then
      v_outcome := 'late_win';   -- the pig was already broken: nothing moves
    end if;
  elsif v_outcome in ('fail'::public.attempt_outcome, 'blocked'::public.attempt_outcome,
                      'leak_blocked'::public.attempt_outcome) then
    v_new_cracks := least(3, v_cracks + 1);
    v_event := case
      when v_cracks < 3 and v_new_cracks = 3 then 'shatter'::public.crack_event
      when v_new_cracks > v_cracks then 'crack'::public.crack_event
      else 'none'::public.crack_event
    end;
  end if;

  if v_paid then
    -- The whole pot to the winner, then the treasury reset to the seed.
    v_payout := v_game.treasury_cents;
    if v_payout > 0 then
      perform private._post_ledger('payout', 'treasury', 'player:' || v_user::text,
                                   v_payout, v_user, p_attempt_id, 'payout:' || p_attempt_id::text);
    end if;

    v_from := v_game.current_level;
    v_to   := least(v_from + 1, 5)::smallint;   -- the pig stays at level 5 at the top

    update public.game_state as g
       set current_level        = v_to,
           pig_epoch            = g.pig_epoch + 1,
           total_wins           = g.total_wins + 1,
           total_paid_out_cents = g.total_paid_out_cents + v_payout
     where g.id = 1
    returning g.pig_epoch into v_new_epoch;

    v_seed := coalesce(private._config_bigint('treasury_seed_cents'), 0);
    if v_seed > 0 then
      perform private._post_ledger('mint_treasury_seed', 'mint', 'treasury',
                                   v_seed, null, p_attempt_id, 'seed:epoch:' || v_new_epoch::text);
    end if;
  end if;

  -- 6. The attempt and the wallet.
  update public.attempts as a
     set outcome              = v_outcome,
         reply                = p_reply,
         validator_reasons    = v_reasons,
         validator_signals    = v_signals,
         tripwire_probability = p_tripwire_probability,
         technique            = p_technique,
         canary_leaked        = p_canary_leaked,
         tool_called          = p_tool_called,
         payout_cents         = v_payout,
         crack_event          = v_event,
         cracks_after         = v_new_cracks,
         cost_micros          = p_cost_micros,
         error_code           = case when v_outcome = 'fail'::public.attempt_outcome then v_error end,
         finalized_at         = now()
   where a.id = p_attempt_id;

  update public.wallets as w
     set crack_count          = v_new_cracks,
         total_wins           = w.total_wins + case when v_paid then 1 else 0 end,
         in_flight_attempt_id = case when w.in_flight_attempt_id = p_attempt_id then null
                                     else w.in_flight_attempt_id end
   where w.user_id = v_user;

  if v_paid then
    -- The exact-replay block (CH-6b), lock order 8.
    if p_block_fingerprint then
      insert into public.blocked_fingerprints (fingerprint, level_id, attempt_id)
      values (v_attempt.prompt_fingerprint, v_from, p_attempt_id)
      on conflict (fingerprint) do nothing;
    end if;

    -- The hardening job for the beaten level, lock order 9. It is only
    -- queued here; the pipeline claims it.
    if private._config_bool('hardening_enabled', false)
       and (select count(*) from public.hardening_jobs as j
            where j.user_id = v_user and j.created_at > now() - interval '1 hour') < p_user_jobs_per_hour then
      insert into public.hardening_jobs (attempt_id, user_id, level_id, trigger, prompt_sha256)
      values (p_attempt_id, v_user, v_from, 'win', v_attempt.prompt_sha256)
      on conflict (level_id, prompt_sha256) where status in ('queued', 'processing', 'promoted') do nothing
      returning id into v_job;
    end if;

    -- The breach row (append-only, deduplicated by hash), so every later
    -- rule set must keep blocking this prompt (HC-A3).
    perform public.add_breach_to_golden(p_attempt_id);
  end if;

  -- 7. The public feed: labels and numbers only.
  insert into public.live_feed (event_type, level_id, player_id, outcome, technique, amount_cents)
  values ('attempt', v_attempt.level_id, v_user, v_outcome, p_technique, v_payout);

  if v_paid and v_to > v_from then
    insert into public.live_feed (event_type, level_id)
    values ('level_advanced', v_to);
  end if;

  -- 8. Spend, last, on the reservation's day (R1-18).
  insert into public.ai_spend (day) values (v_attempt.spend_day)
  on conflict (day) do nothing;

  update public.ai_spend as s
     set attempt_reserved_micros = greatest(0, s.attempt_reserved_micros - v_attempt.reserved_micros),
         attempt_settled_micros  = s.attempt_settled_micros + p_cost_micros,
         updated_at              = now()
   where s.day = v_attempt.spend_day;

  return query
    select v_outcome, v_event, v_new_cracks, v_payout, 0::bigint, false,
           w.balance_cents, w.aura_bps, g.treasury_cents, g.current_level, g.pig_epoch,
           case when v_paid then v_from end, case when v_paid then v_to end, v_job
    from public.wallets as w cross join public.game_state as g
    where w.user_id = v_user and g.id = 1;
end
$$;

revoke all on function public.record_attempt(uuid, public.attempt_outcome, text, text[], text[], real, public.attack_technique, boolean, boolean, bigint, text, boolean, integer)
  from public, anon, authenticated;
grant execute on function public.record_attempt(uuid, public.attempt_outcome, text, text[], text[], real, public.attack_technique, boolean, boolean, bigint, text, boolean, integer)
  to service_role;

comment on function public.record_attempt(uuid, public.attempt_outcome, text, text[], text[], real, public.attack_technique, boolean, boolean, bigint, text, boolean, integer) is
  'Finalizes a pending attempt exactly once: a paid win pays the whole treasury, '
  'resets it to the seed, advances the level and epoch, blocks the fingerprint, '
  'queues the hardening job, and records the breach row; a late win moves nothing; '
  'fail, blocked, and leak_blocked add a crack up to 3; error goes through '
  'private._finalize_attempt_error. Service role only.';

-- ===========================================================================
-- 4. attempt_result
-- ===========================================================================
-- The stored result of the caller's own finalized attempt, plus the current
-- wallet and game values. Empty for another player's attempt, a pending
-- attempt, or an unknown id. level_to is set only for a paid win: within an
-- epoch the level never changes, so a paid win at level L moved the pig to
-- least(L + 1, 5). It backs idempotent replays (R2-05) and the
-- already_finalized read-back after a lost response (R2-14).
create or replace function public.attempt_result(p_user_id uuid, p_attempt_id uuid)
returns table (outcome public.attempt_outcome, crack_event public.crack_event, cracks_after smallint,
               payout_cents bigint, refund_cents bigint, refund_withheld boolean, level_id smallint,
               level_to smallint, technique public.attack_technique, reply text, wallet_balance_cents bigint,
               aura_bps integer, treasury_cents bigint, current_level smallint, pig_epoch bigint)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
-- Lock order (section 5.1): no lock; a plain read.
begin
  if p_user_id is null or p_attempt_id is null then
    raise exception 'invariant_violation: attempt_result needs a player and an attempt id'
      using errcode = 'PT422';
  end if;

  return query
    select a.outcome, a.crack_event, a.cracks_after, a.payout_cents, a.refund_cents, a.refund_withheld,
           a.level_id,
           case when a.outcome = 'win'::public.attempt_outcome then least(a.level_id + 1, 5)::smallint end,
           a.technique, a.reply, w.balance_cents, w.aura_bps, g.treasury_cents, g.current_level, g.pig_epoch
    from public.attempts as a
    join public.wallets as w on w.user_id = a.user_id
    cross join public.game_state as g
    where a.id = p_attempt_id
      and a.user_id = p_user_id
      and a.outcome <> 'pending'::public.attempt_outcome
      and g.id = 1;
end
$$;

revoke all on function public.attempt_result(uuid, uuid) from public, anon, authenticated;
grant execute on function public.attempt_result(uuid, uuid) to service_role;

comment on function public.attempt_result(uuid, uuid) is
  'The stored result of the caller''s own finalized attempt plus the current '
  'wallet and game values; empty for another player''s or a pending attempt. '
  'Service role only.';

-- ===========================================================================
-- 5. Self-check: fail loudly if a privilege is not as intended
-- ===========================================================================
do $$
declare
  v_functions text[] := array[
    'private._attempt_replay(uuid)',
    'public.start_attempt(uuid, uuid, bigint, text, text, text, bigint, bigint, integer, integer, integer, integer, integer)',
    'public.record_attempt(uuid, public.attempt_outcome, text, text[], text[], real, public.attack_technique, boolean, boolean, bigint, text, boolean, integer)',
    'public.attempt_result(uuid, uuid)'];
  v_problem   text;
begin
  select string_agg(format('%s:%s', r.role_name, f.fn), ', ')
    into v_problem
  from (values ('anon', false), ('authenticated', false), ('service_role', true)) as r (role_name, expected)
  cross join unnest(v_functions) as f (fn)
  where has_function_privilege(r.role_name, f.fn, 'EXECUTE') <> r.expected;

  if v_problem is not null then
    raise exception '00007: function EXECUTE grants are not service_role only: %', v_problem;
  end if;
end
$$;
