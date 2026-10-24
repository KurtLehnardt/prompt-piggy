-- Migration 00005: the hardening RPCs (task PP-18)
--
-- Contents (docs/ARCHITECTURE.md sections 5.1, 5.4, 6.10, 8.6):
--   1. private._config_bool and private._config_bigint: typed reads of
--      app_config that fail closed when a key is missing.
--   2. public.leases (service role only) and claim_lease: the once-a-minute
--      sweep lease (section 8.6).
--   3. claim_hardening_job and finish_hardening_job: the hardening queue.
--   4. add_breach_to_golden: a paid win's prompt becomes a breach row of the
--      golden dataset (CH-6b, HC-A3).
--   5. reserve_ai_spend and settle_ai_spend: the daily AI spend ledger in
--      micro-dollars (R1-08, R1-09).
--   6. get_traffic_corpus: recent non-win prompts of other players for the
--      keyword rarity filter (section 6.10, R2-15).
--   7. A self-check that fails the migration if a privilege is not as
--      intended.
--
-- Every function is SECURITY INVOKER, sets search_path = '', and
-- schema-qualifies every table, type, and function it uses; only pg_catalog
-- built-ins stay unqualified (R2-17). Each one is executable by service_role
-- only: the hardening pipeline and the attempt route call them with the
-- secret key. anon and authenticated can execute none of them.
--
-- Errors use the PTnnn SQLSTATE convention (section 5.1). The message starts
-- with a token that src/lib/errors.ts recognizes and never contains a row
-- value:
--   PT404 not_found            the hardening job does not exist
--   PT409 invalid_state        finish_hardening_job on a job that is not
--                              processing, or to a status that is not terminal
--   PT422 invariant_violation  a missing or out-of-range argument
--   PT422 not_a_win            add_breach_to_golden on anything but a paid win
--
-- Global lock order (section 5.1, R1-02). Each function below takes at most
-- one class of row lock, and a comment at the top of each body names it:
-- hardening_jobs (9) in claim_hardening_job and finish_hardening_job, leases
-- (10) in claim_lease, and ai_spend (11) in reserve_ai_spend and
-- settle_ai_spend. add_breach_to_golden only appends to golden_prompts, and
-- get_traffic_corpus only reads.
--
-- Privileges: leases has RLS enabled, no policy, and no grant to anon or
-- authenticated; service_role gets its DML explicitly (PR #3 review, H1).
-- It has no sequence.
--
-- Re-runnable: create table if not exists, create or replace function, and
-- REVOKE and GRANT, which are idempotent by nature.

-- ===========================================================================
-- 1. Typed app_config reads
-- ===========================================================================
-- Returns the boolean value of an app_config key, or p_missing when the key
-- is absent or not a boolean. Callers pass the fail-closed value: true for
-- kill_switch, false for an enabling switch.
create or replace function private._config_bool(p_key text, p_missing boolean)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select case jsonb_typeof(c.value) when 'boolean' then c.value = 'true'::jsonb end
       from public.app_config as c
      where c.key = p_key),
    p_missing);
$$;

-- Returns the integer value of an app_config key, or null when the key is
-- absent. app_config_value_ok guarantees that every numeric value is a plain
-- integer, so the cast cannot fail.
create or replace function private._config_bigint(p_key text)
returns bigint
language sql
stable
set search_path = ''
as $$
  select (select c.value::text::bigint
            from public.app_config as c
           where c.key = p_key and jsonb_typeof(c.value) = 'number');
$$;

revoke all on function private._config_bool(text, boolean) from public, anon, authenticated;
revoke all on function private._config_bigint(text) from public, anon, authenticated;
grant execute on function private._config_bool(text, boolean) to service_role;
grant execute on function private._config_bigint(text) to service_role;

comment on function private._config_bool(text, boolean) is
  'The boolean app_config value of a key, or p_missing when it is absent. Service role only.';
comment on function private._config_bigint(text) is
  'The integer app_config value of a key, or null when it is absent. Service role only.';

-- ===========================================================================
-- 2. leases and claim_lease
-- ===========================================================================
-- One row per named lease. held_until is the end of the current holder's
-- term; a lease whose term has passed is free.
create table if not exists public.leases (
  key        text primary key,
  held_until timestamptz not null,
  constraint leases_key_format check (key ~ '^[a-z][a-z0-9_:-]{1,63}$')
);

comment on table public.leases is
  'Named time-based leases (for example the once-a-minute sweep, section 8.6). '
  'Service role only: RLS enabled, no policy, no grant to anon or authenticated.';

alter table public.leases enable row level security;   -- no policy: service role only

revoke all on table public.leases from public, anon, authenticated;
grant select, insert, update, delete on table public.leases to service_role;

-- Atomically claims a lease for p_ttl_seconds (clamped to 1..86400).
--
-- Returns true -> the caller holds the lease and may run the guarded work.
-- Returns NULL -> another caller holds it and its term has not passed.
--
-- NOTE THE RETURN TYPE HONESTLY (the claim_stripe_webhook_event contract of
-- skylite 00033): when the ON CONFLICT ... WHERE clause matches no row, the
-- statement returns ZERO ROWS, and a zero-row SQL function declared RETURNS
-- boolean yields NULL, not false. Callers must therefore test `= true` /
-- `IS TRUE` (over PostgREST, `data === true`). A `=== false` / `= false`
-- test would be NULL, that is never true, and would run the sweep on every
-- call. The NULL is documented rather than coalesced, so the contract is the
-- same as the pattern it copies.
--
-- The single INSERT ... ON CONFLICT DO UPDATE takes a row lock on conflict,
-- so two concurrent claims of one key serialise and exactly one sees a
-- returned row.
create or replace function public.claim_lease(p_key text, p_ttl_seconds integer)
returns boolean
language sql
volatile
set search_path = ''
as $$
  -- Lock order (section 5.1): leases (10), one row, and nothing else.
  insert into public.leases as l (key, held_until)
  values (p_key, now() + make_interval(secs => least(greatest(coalesce(p_ttl_seconds, 60), 1), 86400)))
  on conflict (key) do update
    set held_until = excluded.held_until
    where l.held_until <= now()
  returning true;
$$;

revoke all on function public.claim_lease(text, integer) from public, anon, authenticated;
grant execute on function public.claim_lease(text, integer) to service_role;

comment on function public.claim_lease(text, integer) is
  'Claims a named lease for p_ttl_seconds. Returns true ONLY to the caller that '
  'got it, and NULL (not false: a zero-row SQL function yields NULL) while '
  'another holder''s term runs. Callers must test `= true`. Service role only.';

-- ===========================================================================
-- 3. The hardening queue
-- ===========================================================================

-- Claims one hardening job and returns it as processing, or returns no row.
--   - No row while app_config kill_switch is true or hardening_enabled is
--     false (R1-08), so neither the kick route nor the sweep can start work.
--   - A claimable job is queued, or processing with a claim older than 10
--     minutes (a worker that died, the skylite reaper lesson). Claiming sets
--     status processing and claimed_at, and increments claim_count.
--   - A level that already has a live processing job (claimed within the
--     last 10 minutes) is skipped, so one level hardens one breach at a time.
--   - p_job_id claims that job only; null claims the oldest claimable job.
-- An empty result means nothing to do.
create or replace function public.claim_hardening_job(p_job_id uuid default null)
returns setof public.hardening_jobs
language plpgsql
set search_path = ''
as $$
-- Lock order (section 5.1): hardening_jobs (9), one row, FOR UPDATE SKIP
-- LOCKED, and nothing else. Before it, a transaction-scoped advisory lock
-- that no other function takes serializes concurrent claims, so the next
-- claimer sees the committed processing row and skips that level; it waits
-- on nothing and nothing waits on it while holding a row lock, so it cannot
-- join a deadlock cycle.
declare
  v_id  uuid;
  v_job public.hardening_jobs%rowtype;
begin
  if private._config_bool('kill_switch', true) or not private._config_bool('hardening_enabled', false) then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('prompt-piggy:claim_hardening_job', 0));

  select j.id into v_id
  from public.hardening_jobs as j
  where (p_job_id is null or j.id = p_job_id)
    and (j.status = 'queued'
         or (j.status = 'processing' and j.claimed_at < now() - interval '10 minutes'))
    and not exists (
      select 1
      from public.hardening_jobs as o
      where o.level_id = j.level_id
        and o.id <> j.id
        and o.status = 'processing'
        and o.claimed_at >= now() - interval '10 minutes')
  order by j.created_at, j.id
  limit 1
  for update of j skip locked;

  if v_id is null then
    return;
  end if;

  update public.hardening_jobs as j
     set status      = 'processing',
         claim_count = j.claim_count + 1,
         claimed_at  = now()
   where j.id = v_id
  returning j.* into v_job;

  return next v_job;
end
$$;

revoke all on function public.claim_hardening_job(uuid) from public, anon, authenticated;
grant execute on function public.claim_hardening_job(uuid) to service_role;

comment on function public.claim_hardening_job(uuid) is
  'Claims the given or the oldest claimable hardening job (queued, or processing '
  'for more than 10 minutes) at a level with no live processing job, with FOR '
  'UPDATE SKIP LOCKED. Empty while the kill switch is on or hardening is '
  'disabled (R1-08). Service role only.';

-- Moves a processing job to a terminal status: promoted (which needs the
-- promoted rule set), rejected, skipped, or failed, with an optional detail
-- code. Any other transition raises PT409 invalid_state, so a job finishes
-- exactly once and a stale worker cannot overwrite a re-claimed job's result
-- after it was finished.
create or replace function public.finish_hardening_job(
  p_job_id      uuid,
  p_status      text,
  p_rule_set_id uuid,
  p_error_code  text
)
returns void
language plpgsql
set search_path = ''
as $$
-- Lock order (section 5.1): hardening_jobs (9), one row, and nothing else.
declare
  v_status text;
begin
  if p_job_id is null or p_status is null then
    raise exception 'invariant_violation: finish_hardening_job needs a job id and a status'
      using errcode = 'PT422';
  end if;

  if p_error_code is not null and p_error_code !~ '^[a-z_]{3,40}$' then
    raise exception 'invariant_violation: finish_hardening_job got a malformed error code'
      using errcode = 'PT422';
  end if;

  select j.status into v_status
  from public.hardening_jobs as j
  where j.id = p_job_id
  for update;

  if not found then
    raise exception 'not_found: finish_hardening_job got an unknown job'
      using errcode = 'PT404';
  end if;

  if v_status <> 'processing' or p_status not in ('promoted', 'rejected', 'skipped', 'failed') then
    raise exception 'invalid_state: only a processing job may move to a terminal status'
      using errcode = 'PT409';
  end if;

  if p_status = 'promoted' and p_rule_set_id is null then
    raise exception 'invariant_violation: a promoted job needs its rule set'
      using errcode = 'PT422';
  end if;

  update public.hardening_jobs as j
     set status      = p_status,
         rule_set_id = coalesce(p_rule_set_id, j.rule_set_id),
         error_code  = p_error_code,
         finished_at = now()
   where j.id = p_job_id;
end
$$;

revoke all on function public.finish_hardening_job(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.finish_hardening_job(uuid, text, uuid, text) to service_role;

comment on function public.finish_hardening_job(uuid, text, uuid, text) is
  'Moves a processing hardening job to promoted, rejected, skipped, or failed. '
  'Any other transition raises PT409 invalid_state. Service role only.';

-- ===========================================================================
-- 4. add_breach_to_golden
-- ===========================================================================
-- Copies a paid win's prompt into golden_prompts as a breach of the
-- attempt's level, so every later rule set must keep blocking it (HC-A3).
-- Deduplicated by the sha256 of the text: a repeat returns the existing
-- row's id and inserts nothing. Anything but a paid win (fail, blocked,
-- leak_blocked, late_win, error, pending, or an unknown id) raises PT422
-- not_a_win (CH-6b). The text is only ever replayed through the validator,
-- never placed in an LLM prompt.
create or replace function public.add_breach_to_golden(p_attempt_id uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
-- Lock order (section 5.1): no row lock. It reads the attempt and appends
-- to golden_prompts, which section 5.1 allows at any point.
declare
  v_outcome public.attempt_outcome;
  v_level   smallint;
  v_prompt  text;
  v_hash    text;
  v_id      uuid;
begin
  if p_attempt_id is null then
    raise exception 'invariant_violation: add_breach_to_golden needs an attempt id'
      using errcode = 'PT422';
  end if;

  select a.outcome, a.level_id, a.prompt
    into v_outcome, v_level, v_prompt
  from public.attempts as a
  where a.id = p_attempt_id;

  if v_outcome is distinct from 'win'::public.attempt_outcome then
    raise exception 'not_a_win: only a paid win becomes a breach'
      using errcode = 'PT422';
  end if;

  if v_prompt is null then
    raise exception 'invariant_violation: the win no longer has its prompt'
      using errcode = 'PT422';
  end if;

  v_hash := encode(extensions.digest(v_prompt, 'sha256'), 'hex');

  -- The only unique keys are the random id and golden_prompts_dedupe
  -- (kind, level, hash), so a conflict here is always a duplicate breach.
  insert into public.golden_prompts (kind, level_id, text, text_sha256, source, attempt_id)
  values ('breach', v_level, v_prompt, v_hash, 'breach_auto', p_attempt_id)
  on conflict do nothing
  returning id into v_id;

  if v_id is null then
    select g.id into v_id
    from public.golden_prompts as g
    where g.kind = 'breach'
      and coalesce(g.level_id, 0) = v_level
      and g.text_sha256 = v_hash;
  end if;

  return v_id;
end
$$;

revoke all on function public.add_breach_to_golden(uuid) from public, anon, authenticated;
grant execute on function public.add_breach_to_golden(uuid) to service_role;

comment on function public.add_breach_to_golden(uuid) is
  'Copies a paid win''s prompt into golden_prompts as a breach of its level, '
  'idempotent by text hash, and returns the row id. PT422 not_a_win for any '
  'other attempt (CH-6b). Service role only.';

-- ===========================================================================
-- 5. AI spend: reserve and settle (micro-dollars)
-- ===========================================================================

-- Reserves p_micros of the day's spend for one call of p_kind (attempt or
-- hardening) and returns true, or returns false when the reservation would
-- take the day's total (both kinds, reserved plus settled) past
-- p_cap_micros. Always false while the kill switch is on (R1-08).
-- Attempts are held to their share of the cap inside start_attempt (R1-09);
-- here a hardening call may use whatever the attempts have not used of the
-- cap. The day is the caller's, so settle_ai_spend can name the same row.
create or replace function public.reserve_ai_spend(
  p_day        date,
  p_micros     bigint,
  p_cap_micros bigint,
  p_kind       text
)
returns boolean
language plpgsql
set search_path = ''
as $$
-- Lock order (section 5.1): ai_spend (11), one day row, and nothing else.
begin
  if p_day is null or p_kind is null or p_kind not in ('attempt', 'hardening')
     or p_micros is null or p_micros not between 0 and 1000000000000
     or p_cap_micros is null or p_cap_micros not between 0 and 1000000000000 then
    raise exception 'invariant_violation: reserve_ai_spend needs a day, a kind, and amounts in range'
      using errcode = 'PT422';
  end if;

  if private._config_bool('kill_switch', true) then
    return false;
  end if;

  insert into public.ai_spend (day) values (p_day)
  on conflict (day) do nothing;

  update public.ai_spend as s
     set attempt_reserved_micros   = s.attempt_reserved_micros   + case when p_kind = 'attempt'   then p_micros else 0 end,
         hardening_reserved_micros = s.hardening_reserved_micros + case when p_kind = 'hardening' then p_micros else 0 end,
         attempt_calls             = s.attempt_calls             + case when p_kind = 'attempt'   then 1 else 0 end,
         hardening_calls           = s.hardening_calls           + case when p_kind = 'hardening' then 1 else 0 end,
         updated_at                = now()
   where s.day = p_day
     and s.attempt_reserved_micros + s.attempt_settled_micros
         + s.hardening_reserved_micros + s.hardening_settled_micros + p_micros <= p_cap_micros;

  return found;
end
$$;

revoke all on function public.reserve_ai_spend(date, bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.reserve_ai_spend(date, bigint, bigint, text) to service_role;

comment on function public.reserve_ai_spend(date, bigint, bigint, text) is
  'Reserves micro-dollars of the given day''s AI spend for an attempt or a '
  'hardening call; false when the day''s total would pass the cap or the kill '
  'switch is on. Service role only.';

-- Settles a reservation of p_kind on the reservation's own day: releases
-- p_reserved and records p_actual. A release larger than what is reserved
-- stops at zero instead of failing, so a settle can never strand a finished
-- job; with consistent callers the release is exact.
create or replace function public.settle_ai_spend(
  p_day      date,
  p_kind     text,
  p_reserved bigint,
  p_actual   bigint
)
returns void
language plpgsql
set search_path = ''
as $$
-- Lock order (section 5.1): ai_spend (11), one day row, and nothing else.
begin
  if p_day is null or p_kind is null or p_kind not in ('attempt', 'hardening')
     or p_reserved is null or p_reserved not between 0 and 1000000000000
     or p_actual is null or p_actual not between 0 and 1000000000000 then
    raise exception 'invariant_violation: settle_ai_spend needs a day, a kind, and amounts in range'
      using errcode = 'PT422';
  end if;

  insert into public.ai_spend (day) values (p_day)
  on conflict (day) do nothing;

  update public.ai_spend as s
     set attempt_reserved_micros   = case when p_kind = 'attempt'
                                          then greatest(0, s.attempt_reserved_micros - p_reserved)
                                          else s.attempt_reserved_micros end,
         attempt_settled_micros    = s.attempt_settled_micros + case when p_kind = 'attempt' then p_actual else 0 end,
         hardening_reserved_micros = case when p_kind = 'hardening'
                                          then greatest(0, s.hardening_reserved_micros - p_reserved)
                                          else s.hardening_reserved_micros end,
         hardening_settled_micros  = s.hardening_settled_micros + case when p_kind = 'hardening' then p_actual else 0 end,
         updated_at                = now()
   where s.day = p_day;
end
$$;

revoke all on function public.settle_ai_spend(date, text, bigint, bigint) from public, anon, authenticated;
grant execute on function public.settle_ai_spend(date, text, bigint, bigint) to service_role;

comment on function public.settle_ai_spend(date, text, bigint, bigint) is
  'Releases a reservation and records the actual spend on the reservation''s '
  'day for an attempt or a hardening call. Service role only.';

-- ===========================================================================
-- 6. get_traffic_corpus
-- ===========================================================================
-- The newest finalized non-win attempts that still hold their prompt, by
-- players other than p_exclude_user (the winner), newest first, at most
-- p_limit rows (clamped to 1..1000). The author id lets the traffic filter
-- count distinct players (R2-15). The filter only drops keywords (section
-- 6.10); the prompts never reach an LLM. The predicate matches the partial
-- index attempts_traffic.
create or replace function public.get_traffic_corpus(p_exclude_user uuid, p_limit integer default 500)
returns table (prompt text, user_id uuid)
language plpgsql
stable
set search_path = ''
as $$
-- Lock order (section 5.1): no lock; a plain read.
begin
  if p_exclude_user is null then
    raise exception 'invariant_violation: get_traffic_corpus needs the user to exclude'
      using errcode = 'PT422';
  end if;

  return query
    select a.prompt, a.user_id
    from public.attempts as a
    where a.outcome not in ('pending'::public.attempt_outcome, 'win'::public.attempt_outcome)
      and a.prompt is not null
      and a.user_id <> p_exclude_user
    order by a.finalized_at desc, a.id
    limit least(greatest(coalesce(p_limit, 500), 1), 1000);
end
$$;

revoke all on function public.get_traffic_corpus(uuid, integer) from public, anon, authenticated;
grant execute on function public.get_traffic_corpus(uuid, integer) to service_role;

comment on function public.get_traffic_corpus(uuid, integer) is
  'Newest finalized non-win prompts of players other than the given one, with '
  'their author ids, limit clamped to 1..1000 (R2-15). Service role only.';

-- ===========================================================================
-- 7. Self-check: fail loudly if a privilege is not as intended
-- ===========================================================================
do $$
declare
  v_privileges text[] := array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  v_functions  text[] := array[
    'private._config_bool(text, boolean)',
    'private._config_bigint(text)',
    'public.claim_lease(text, integer)',
    'public.claim_hardening_job(uuid)',
    'public.finish_hardening_job(uuid, text, uuid, text)',
    'public.add_breach_to_golden(uuid)',
    'public.reserve_ai_spend(date, bigint, bigint, text)',
    'public.settle_ai_spend(date, text, bigint, bigint)',
    'public.get_traffic_corpus(uuid, integer)'];
  v_problem    text;
begin
  if current_setting('server_version_num')::integer >= 170000 then
    v_privileges := array_append(v_privileges, 'MAINTAIN');
  end if;

  select string_agg(format('%s:%s', r.role_name, p.privilege), ', ')
    into v_problem
  from (values ('anon'), ('authenticated')) as r (role_name)
  cross join unnest(v_privileges) as p (privilege)
  where has_table_privilege(r.role_name, 'public.leases', p.privilege);

  if v_problem is not null then
    raise exception '00005: anon or authenticated hold privileges on leases: %', v_problem;
  end if;

  select string_agg(p.privilege, ', ')
    into v_problem
  from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p (privilege)
  where not has_table_privilege('service_role', 'public.leases', p.privilege);

  if v_problem is not null then
    raise exception '00005: service_role lacks its explicit grants on leases: %', v_problem;
  end if;

  select string_agg(format('%s:%s', r.role_name, f.fn), ', ')
    into v_problem
  from (values ('anon', false), ('authenticated', false), ('service_role', true)) as r (role_name, expected)
  cross join unnest(v_functions) as f (fn)
  where has_function_privilege(r.role_name, f.fn, 'EXECUTE') <> r.expected;

  if v_problem is not null then
    raise exception '00005: function EXECUTE grants are not service_role only: %', v_problem;
  end if;
end
$$;
