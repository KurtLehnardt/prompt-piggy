-- Migration 00003: the rule-set RPCs (task PP-07)
--
-- Contents (docs/ARCHITECTURE.md sections 5.1, 5.4, 6.4, 6.5, 6.7, 6.8, 12.6):
--   1. insert_rule_proposal: a proposed rule set from a paid win (CH-6b).
--   2. promote_rule_set: the gated, monotonic promotion (HC4, HC-A3).
--   3. reject_rule_set: auto-reject and the human-review flag (section 6.8).
--   4. rollback_rule_set: reactivate an earlier version (R1-11a).
--   5. reset_level_rules: reactivate the version-0 seed.
--
-- Every function is plpgsql, SECURITY INVOKER, sets search_path = '', and
-- schema-qualifies every table, type, and function it uses; only pg_catalog
-- built-ins stay unqualified (R2-17). Each one is executable by service_role
-- only: the server routes and the hardening pipeline call it with the secret
-- key, and rollback and reset are run by hand from the SQL runbook. anon and
-- authenticated can execute none of them.
--
-- Errors use PostgREST's PTnnn SQLSTATE convention (section 5.1). The message
-- starts with a token that src/lib/errors.ts recognizes, followed by a short
-- explanation, and never contains rule content or any other row value:
--   PT404 rule_set_not_found       the rule set does not exist
--   PT409 stale_parent             the parent is not the level's active rule set
--   PT409 invalid_state            the rule set is not in the state this call needs
--   PT409 gate_not_passed          no passing rule_gate_runs row exists
--   PT422 invariant_violation      a missing or out-of-range argument
--   PT422 invalid_rules            the rules fail rule_set_payload_ok
--   PT422 invalid_technique        a missing technique, or unknown (R2-S3)
--   PT422 not_a_win                the source attempt is not a paid win (CH-6b)
--   PT422 weakens_parent           the candidate drops a parent flag or keyword
--   PT422 invalid_rollback_target  the rollback target cannot be reactivated
--
-- Locks follow the global order of section 5.1: the levels row (order 6)
-- before any rule_sets row (order 7), and rule_sets rows in ascending id
-- order. Every function that changes which row is active locks the levels
-- row first, which serializes them per level, so lineages are per level
-- (CH-7) and a change at one level never waits on another. The row locks are
-- FOR NO KEY UPDATE: they conflict with each other and with FOR UPDATE, so
-- they serialize exactly like FOR UPDATE, but they do not block the
-- FOR KEY SHARE locks that foreign-key checks take, so an insert that only
-- references the level or the rule set (an attempt, a gate run, a proposal)
-- never waits on a promotion. No function here changes a key column.
--
-- Re-runnable: create or replace function, and REVOKE and GRANT, which are
-- idempotent by nature.

-- ===========================================================================
-- 1. insert_rule_proposal
-- ===========================================================================
-- Inserts a proposed rule set for a level and returns its id. The rules are
-- the merged, sanitized candidate (PP-23); the hash is computed here. Checks,
-- in order: the arguments, the technique (unknown is refused, R2-S3), the
-- rules, the parent (it must be the level's active row, PT409 stale_parent
-- otherwise), and the source attempt, which must be a paid win (CH-6b,
-- defense in depth behind the hardening_jobs trigger CHECK).
--
-- The win check reads public.attempts, which 00004 creates. plpgsql parses a
-- statement only when it first runs, so the reference is bound late and this
-- function can be created before that table exists. Until the table exists no
-- attempt can be a win, so every call fails closed with not_a_win. PP-12's
-- pgTAP suite exercises the check against real attempts.
create or replace function public.insert_rule_proposal(
  p_level_id          smallint,
  p_parent_id         uuid,
  p_rules             jsonb,
  p_technique         public.attack_technique,
  p_source_attempt_id uuid
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_active_id uuid;
  v_outcome   text;
  v_id        uuid;
begin
  if p_level_id is null or p_parent_id is null or p_rules is null then
    raise exception 'invariant_violation: insert_rule_proposal needs a level, a parent, and rules'
      using errcode = 'PT422';
  end if;

  if not exists (select 1 from public.levels as l where l.id = p_level_id) then
    raise exception 'invariant_violation: insert_rule_proposal got an unknown level'
      using errcode = 'PT422';
  end if;

  if p_technique is null or p_technique = 'unknown'::public.attack_technique then
    raise exception 'invalid_technique: a proposal needs one of the eleven engine techniques'
      using errcode = 'PT422';
  end if;

  if not public.rule_set_payload_ok(p_rules) then
    raise exception 'invalid_rules: the proposed rules fail rule_set_payload_ok'
      using errcode = 'PT422';
  end if;

  select rs.id into v_active_id
  from public.rule_sets as rs
  where rs.level_id = p_level_id and rs.state = 'active'::public.rule_set_state;

  if v_active_id is distinct from p_parent_id then
    raise exception 'stale_parent: the parent is not the active rule set of this level'
      using errcode = 'PT409';
  end if;

  -- CH-6b: only a verified paid win may add rule content.
  if p_source_attempt_id is not null and to_regclass('public.attempts') is not null then
    select a.outcome::text into v_outcome
    from public.attempts as a
    where a.id = p_source_attempt_id;
  end if;

  if v_outcome is distinct from 'win' then
    raise exception 'not_a_win: the source attempt is not a paid win'
      using errcode = 'PT422';
  end if;

  insert into public.rule_sets (
    level_id, version, parent_id, state, rules, rules_sha256, source, source_attempt_id, technique
  ) values (
    p_level_id, null, p_parent_id, 'proposed'::public.rule_set_state, p_rules,
    private.rule_set_sha256(p_rules), 'hardening', p_source_attempt_id, p_technique
  )
  returning id into v_id;

  return v_id;
end
$$;

revoke all on function public.insert_rule_proposal(smallint, uuid, jsonb, public.attack_technique, uuid) from public, anon, authenticated;
grant execute on function public.insert_rule_proposal(smallint, uuid, jsonb, public.attack_technique, uuid) to service_role;

comment on function public.insert_rule_proposal(smallint, uuid, jsonb, public.attack_technique, uuid) is
  'Inserts a proposed rule set from a paid win and returns its id. PT409 '
  'stale_parent unless the parent is the active row; PT422 not_a_win unless the '
  'source attempt''s outcome is win (CH-6b); refuses the technique unknown.';

-- ===========================================================================
-- 2. promote_rule_set
-- ===========================================================================
-- Activates a proposed rule set as version parent + 1 and supersedes its
-- parent. Requires, in order: the candidate is proposed (PT409
-- invalid_state), its parent is the level's active row (PT409 stale_parent),
-- a passing gate run exists (PT409 gate_not_passed), and the candidate keeps
-- every true flag and every keyword of the parent (PT422 weakens_parent,
-- section 6.4: a promotion can only add defenses). Returns the new version.
create or replace function public.promote_rule_set(p_rule_set_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_level_id  smallint;
  v_active_id uuid;
  v_cand      public.rule_sets%rowtype;
  v_parent    public.rule_sets%rowtype;
  v_version   integer;
begin
  if p_rule_set_id is null then
    raise exception 'invariant_violation: promote_rule_set needs a rule set id'
      using errcode = 'PT422';
  end if;

  -- The level never changes for a row, so it is read without a lock.
  select rs.level_id into v_level_id from public.rule_sets as rs where rs.id = p_rule_set_id;
  if v_level_id is null then
    raise exception 'rule_set_not_found: promote_rule_set got an unknown rule set'
      using errcode = 'PT404';
  end if;

  -- Lock order 6: the levels row serializes every activation at this level.
  perform 1 from public.levels as l where l.id = v_level_id for no key update;

  -- Lock order 7: the candidate and the active row, in ascending id order.
  select rs.id into v_active_id
  from public.rule_sets as rs
  where rs.level_id = v_level_id and rs.state = 'active'::public.rule_set_state;

  perform 1
  from public.rule_sets as rs
  where rs.id in (p_rule_set_id, v_active_id)
  order by rs.id
  for no key update;

  select * into v_cand from public.rule_sets as rs where rs.id = p_rule_set_id;

  if v_cand.state is distinct from 'proposed'::public.rule_set_state then
    raise exception 'invalid_state: promote_rule_set needs a proposed rule set'
      using errcode = 'PT409';
  end if;

  if v_active_id is null or v_cand.parent_id is distinct from v_active_id then
    raise exception 'stale_parent: the parent is not the active rule set of this level'
      using errcode = 'PT409';
  end if;

  if not exists (
    select 1 from public.rule_gate_runs as g
    where g.rule_set_id = p_rule_set_id and g.passed
  ) then
    raise exception 'gate_not_passed: promote_rule_set needs a passing gate run'
      using errcode = 'PT409';
  end if;

  select * into v_parent from public.rule_sets as rs where rs.id = v_active_id;

  -- Monotonicity re-check (section 5.4): every flag that is true in the
  -- parent stays true, and every parent keyword stays.
  if exists (
       select 1 from jsonb_each(v_parent.rules) as p
       where p.value = 'true'::jsonb
         and (v_cand.rules -> p.key) is distinct from 'true'::jsonb)
     or exists (
       select 1 from jsonb_array_elements_text(v_parent.rules -> 'block_keywords') as k
       where not ((v_cand.rules -> 'block_keywords') ? k)) then
    raise exception 'weakens_parent: the candidate drops a parent flag or keyword'
      using errcode = 'PT422';
  end if;

  v_version := v_parent.version + 1;

  -- The parent leaves the active state first, because the partial unique
  -- index allows one active row per level at every moment.
  update public.rule_sets
     set state = 'superseded'::public.rule_set_state, deactivated_at = now()
   where id = v_parent.id;

  update public.rule_sets
     set state = 'active'::public.rule_set_state, version = v_version, activated_at = now()
   where id = v_cand.id;

  return v_version;
end
$$;

revoke all on function public.promote_rule_set(uuid) from public, anon, authenticated;
grant execute on function public.promote_rule_set(uuid) to service_role;

comment on function public.promote_rule_set(uuid) is
  'Activates a proposed rule set whose parent is the active row and which has '
  'a passing gate run, as version parent + 1, after re-checking monotonicity; '
  'supersedes the parent and returns the new version.';

-- ===========================================================================
-- 3. reject_rule_set
-- ===========================================================================
-- Rejects a proposed rule set with the first failure code (section 6.8) and
-- flags it for human review when p_needs_review is true. A retry on a row that
-- is already rejected changes nothing, so the call is idempotent. Any other
-- state raises PT409 invalid_state. An admin can never force-promote a
-- rejected row: promote_rule_set needs a proposed one.
create or replace function public.reject_rule_set(
  p_rule_set_id    uuid,
  p_rejection_code text,
  p_needs_review   boolean
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_state public.rule_set_state;
begin
  if p_rule_set_id is null or p_needs_review is null
     or p_rejection_code is null or p_rejection_code !~ '^[a-z_]{3,40}$' then
    raise exception 'invariant_violation: reject_rule_set needs a rule set id, a rejection code, and a review flag'
      using errcode = 'PT422';
  end if;

  -- Lock order 7 only: rejecting never changes which row is active.
  select rs.state into v_state
  from public.rule_sets as rs
  where rs.id = p_rule_set_id
  for no key update;

  if not found then
    raise exception 'rule_set_not_found: reject_rule_set got an unknown rule set'
      using errcode = 'PT404';
  end if;

  if v_state = 'rejected'::public.rule_set_state then
    return;
  end if;

  if v_state <> 'proposed'::public.rule_set_state then
    raise exception 'invalid_state: reject_rule_set needs a proposed rule set'
      using errcode = 'PT409';
  end if;

  update public.rule_sets
     set state          = 'rejected'::public.rule_set_state,
         rejection_code = p_rejection_code,
         review_status  = case when p_needs_review then 'needs_review'::public.review_status else review_status end
   where id = p_rule_set_id;
end
$$;

revoke all on function public.reject_rule_set(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.reject_rule_set(uuid, text, boolean) to service_role;

comment on function public.reject_rule_set(uuid, text, boolean) is
  'Rejects a proposed rule set with a failure code and sets review_status '
  'needs_review only when p_needs_review is true. Idempotent on a rejected row.';

-- ===========================================================================
-- 4. Shared helper: reactivate earlier rules as a new version
-- ===========================================================================
-- Copies p_rules into a new active row of the level (version = active + 1,
-- parent = the active row) and marks the previous active row rolled_back.
-- The caller holds the levels row lock and has validated the target. Rollback
-- and reset are human actions run from the SQL runbook (section 12.6), so
-- they skip the gate and the monotonicity check by design. On 00004 and
-- later, inserting an active row fires the rule_sets activation trigger,
-- which records a rules_reset feed row.
create or replace function private._reactivate_rules(
  p_level_id smallint,
  p_rules    jsonb,
  p_source   text
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_active public.rule_sets%rowtype;
  v_id     uuid;
begin
  select * into v_active
  from public.rule_sets as rs
  where rs.level_id = p_level_id and rs.state = 'active'::public.rule_set_state
  for no key update;

  if v_active.id is null then
    raise exception 'invariant_violation: the level has no active rule set'
      using errcode = 'PT422';
  end if;

  update public.rule_sets
     set state = 'rolled_back'::public.rule_set_state, deactivated_at = now()
   where id = v_active.id;

  insert into public.rule_sets (
    level_id, version, parent_id, state, rules, rules_sha256, source, activated_at
  ) values (
    p_level_id, v_active.version + 1, v_active.id, 'active'::public.rule_set_state,
    p_rules, private.rule_set_sha256(p_rules), p_source, now()
  )
  returning id into v_id;

  return v_id;
end
$$;

-- Called only by rollback_rule_set and reset_level_rules, which run as
-- service_role (SECURITY INVOKER).
revoke all on function private._reactivate_rules(smallint, jsonb, text) from public, anon, authenticated;
grant execute on function private._reactivate_rules(smallint, jsonb, text) to service_role;

-- ===========================================================================
-- 5. rollback_rule_set
-- ===========================================================================
-- Reactivates an earlier version of the same level. The target must belong
-- to p_level_id, have a version, and be superseded or rolled_back; anything
-- else raises PT422 invalid_rollback_target, so no rejected or proposed row
-- can ever become active (R1-11a). Returns the new row's id.
create or replace function public.rollback_rule_set(
  p_level_id           smallint,
  p_target_rule_set_id uuid
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_target public.rule_sets%rowtype;
begin
  if p_level_id is null or p_target_rule_set_id is null then
    raise exception 'invariant_violation: rollback_rule_set needs a level and a target'
      using errcode = 'PT422';
  end if;

  -- Lock order 6: the levels row.
  perform 1 from public.levels as l where l.id = p_level_id for no key update;
  if not found then
    raise exception 'invariant_violation: rollback_rule_set got an unknown level'
      using errcode = 'PT422';
  end if;

  -- Rows that are not active never change state again, so the target needs
  -- no lock; _reactivate_rules locks the active row.
  select * into v_target from public.rule_sets as rs where rs.id = p_target_rule_set_id;

  if v_target.id is null
     or v_target.level_id is distinct from p_level_id
     or v_target.version is null
     or v_target.state not in ('superseded'::public.rule_set_state, 'rolled_back'::public.rule_set_state) then
    raise exception 'invalid_rollback_target: the target must be a superseded or rolled-back version of this level'
      using errcode = 'PT422';
  end if;

  return private._reactivate_rules(p_level_id, v_target.rules, 'admin_rollback');
end
$$;

revoke all on function public.rollback_rule_set(smallint, uuid) from public, anon, authenticated;
grant execute on function public.rollback_rule_set(smallint, uuid) to service_role;

comment on function public.rollback_rule_set(smallint, uuid) is
  'SQL runbook only. Copies a superseded or rolled-back version of the level '
  'into a new active version (source admin_rollback) and marks the previous '
  'active row rolled_back. PT422 invalid_rollback_target otherwise.';

-- ===========================================================================
-- 6. reset_level_rules
-- ===========================================================================
-- The same as a rollback, with the level's version-0 seed rules as the
-- target (source admin_reset). The seed row is used whatever its state, and
-- the rules are copied, so the history stays linear. Returns the new row's id.
create or replace function public.reset_level_rules(p_level_id smallint)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_seed_rules jsonb;
begin
  if p_level_id is null then
    raise exception 'invariant_violation: reset_level_rules needs a level'
      using errcode = 'PT422';
  end if;

  -- Lock order 6: the levels row.
  perform 1 from public.levels as l where l.id = p_level_id for no key update;
  if not found then
    raise exception 'invariant_violation: reset_level_rules got an unknown level'
      using errcode = 'PT422';
  end if;

  select rs.rules into v_seed_rules
  from public.rule_sets as rs
  where rs.level_id = p_level_id and rs.version = 0 and rs.source = 'seed';

  if v_seed_rules is null then
    raise exception 'invariant_violation: the level has no version-0 seed rule set'
      using errcode = 'PT422';
  end if;

  return private._reactivate_rules(p_level_id, v_seed_rules, 'admin_reset');
end
$$;

revoke all on function public.reset_level_rules(smallint) from public, anon, authenticated;
grant execute on function public.reset_level_rules(smallint) to service_role;

comment on function public.reset_level_rules(smallint) is
  'SQL runbook only. Copies the level''s version-0 seed rules into a new active '
  'version (source admin_reset) and marks the previous active row rolled_back.';
