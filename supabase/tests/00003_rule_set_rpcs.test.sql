-- pgTAP tests for supabase/migrations/00003_rule_set_rpcs.sql (task PP-07).
--
-- Run with `pnpm db:test` against the local stack after `pnpm db:reset`.
-- Everything runs in one transaction that is rolled back, so nothing here
-- persists. Every RPC is called as service_role, the only role that may
-- execute it, so the tests also prove that its grants are sufficient.
--
-- Proposed rows are inserted directly as postgres, because insert_rule_proposal
-- succeeds only for a paid win, and attempts arrive in 00004. PP-12's pgTAP
-- suite exercises insert_rule_proposal's success path against real attempts.
-- Rows inserted here leave source_attempt_id null, so they stay valid once
-- 00004 adds its foreign key.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(67);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- A valid rule set: the given flags true, the others false.
create function pg_temp.rules(p_on text[] default '{}', p_keywords text[] default '{}')
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('schema_version', 1, 'block_keywords', to_jsonb(p_keywords))
      || (select jsonb_object_agg(f, f = any(p_on))
          from unnest(array[
            'reject_roleplay_archetypes', 'reject_authority_claims', 'reject_instruction_override',
            'reject_delimiter_tokens', 'reject_encoded_payloads', 'reject_tool_invocation_language',
            'reject_deferred_instructions', 'reject_mixed_script_obfuscation', 'reject_hypothetical_framing'
          ]) as f);
$$;

-- The active rule set of a level.
create function pg_temp.active(p_level smallint)
returns public.rule_sets
language sql
stable
as $$
  select * from public.rule_sets where level_id = p_level and state = 'active';
$$;

-- Inserts a proposed rule set as postgres and returns its id.
create function pg_temp.propose(p_level smallint, p_parent uuid, p_rules jsonb)
returns uuid
language sql
as $$
  insert into public.rule_sets (level_id, parent_id, state, rules, rules_sha256, source, technique)
  values (p_level, p_parent, 'proposed', p_rules, private.rule_set_sha256(p_rules), 'hardening', 'roleplay_persona')
  returning id;
$$;

-- Records a gate run for a rule set.
create function pg_temp.gate(p_rule_set uuid, p_passed boolean)
returns void
language sql
as $$
  insert into public.rule_gate_runs (rule_set_id, passed, failure_codes, finished_at)
  values (p_rule_set, p_passed, case when p_passed then '{}'::text[] else array['benign_regression'] end, now());
$$;

-- Runs a statement and returns 'SQLSTATE token', where the token is the first
-- word of the error message, or 'ok' when it does not raise.
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

-- pg_temp functions are created by postgres, and 00001 revoked the default
-- EXECUTE for functions that postgres creates.
grant execute on function pg_temp.rules(text[], text[]) to service_role;
grant execute on function pg_temp.active(smallint) to service_role;
grant execute on function pg_temp.raises(text) to service_role, anon, authenticated;

-- The active rows of every level before any test runs.
create temporary table before_active on commit drop as
  select level_id, id, version from public.rule_sets where state = 'active';
grant select on before_active to service_role;

-- Proposals used below. Level 2's seed has reject_roleplay_archetypes on.
create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant select, insert on ids to service_role;

insert into ids values
  ('l2_v0',        (pg_temp.active(2::smallint)).id),
  ('l1_v0',        (pg_temp.active(1::smallint)).id),
  ('good',         pg_temp.propose(2::smallint, (pg_temp.active(2::smallint)).id,
                     pg_temp.rules(array['reject_roleplay_archetypes', 'reject_authority_claims'], array['root user override']))),
  ('no_gate',      pg_temp.propose(2::smallint, (pg_temp.active(2::smallint)).id, pg_temp.rules(array['reject_roleplay_archetypes']))),
  ('failed_gate',  pg_temp.propose(2::smallint, (pg_temp.active(2::smallint)).id, pg_temp.rules(array['reject_roleplay_archetypes']))),
  ('drops_flag',   pg_temp.propose(2::smallint, (pg_temp.active(2::smallint)).id, pg_temp.rules(array['reject_authority_claims']))),
  ('to_reject',    pg_temp.propose(2::smallint, (pg_temp.active(2::smallint)).id, pg_temp.rules(array['reject_roleplay_archetypes']))),
  ('to_reject_2',  pg_temp.propose(2::smallint, (pg_temp.active(2::smallint)).id, pg_temp.rules(array['reject_roleplay_archetypes']))),
  ('l1_proposed',  pg_temp.propose(1::smallint, (pg_temp.active(1::smallint)).id, pg_temp.rules(array['reject_delimiter_tokens'])));

select pg_temp.gate((select id from ids where name = 'good'), true);
select pg_temp.gate((select id from ids where name = 'failed_gate'), false);
select pg_temp.gate((select id from ids where name = 'drops_flag'), true);

-- ---------------------------------------------------------------------------
-- insert_rule_proposal (CH-6b, R2-S3): 9 tests
-- ---------------------------------------------------------------------------
set local role service_role;

select is(
  pg_temp.raises(format($$ select public.insert_rule_proposal(2::smallint, %L, %L, 'unknown', gen_random_uuid()) $$,
    (select id from ids where name = 'l2_v0'), pg_temp.rules(array['reject_roleplay_archetypes']))),
  'PT422 invalid_technique', 'R2-S3: insert_rule_proposal refuses the technique unknown'
);
select is(
  pg_temp.raises(format($$ select public.insert_rule_proposal(2::smallint, %L, %L, null, gen_random_uuid()) $$,
    (select id from ids where name = 'l2_v0'), pg_temp.rules(array['reject_roleplay_archetypes']))),
  'PT422 invalid_technique', 'insert_rule_proposal refuses a missing technique'
);
select is(
  pg_temp.raises(format($$ select public.insert_rule_proposal(2::smallint, %L, %L, 'roleplay_persona', gen_random_uuid()) $$,
    (select id from ids where name = 'l2_v0'), pg_temp.rules(array['reject_roleplay_archetypes']))),
  'PT422 not_a_win', 'CH-6b: insert_rule_proposal raises not_a_win for an attempt that is not a paid win'
);
select is(
  pg_temp.raises(format($$ select public.insert_rule_proposal(2::smallint, %L, %L, 'roleplay_persona', null) $$,
    (select id from ids where name = 'l2_v0'), pg_temp.rules(array['reject_roleplay_archetypes']))),
  'PT422 not_a_win', 'CH-6b: insert_rule_proposal raises not_a_win without a source attempt'
);
select is(
  pg_temp.raises(format($$ select public.insert_rule_proposal(2::smallint, %L, %L, 'roleplay_persona', gen_random_uuid()) $$,
    (select id from ids where name = 'l1_v0'), pg_temp.rules(array['reject_roleplay_archetypes']))),
  'PT409 stale_parent', 'insert_rule_proposal raises stale_parent when the parent is not the level''s active row'
);
select is(
  pg_temp.raises(format($$ select public.insert_rule_proposal(2::smallint, %L, %L, 'roleplay_persona', gen_random_uuid()) $$,
    (select id from ids where name = 'l2_v0'), pg_temp.rules() || '{"strict_transfer_policy": true}')),
  'PT422 invalid_rules', 'insert_rule_proposal raises invalid_rules for rules that fail the schema'
);
select is(
  pg_temp.raises(format($$ select public.insert_rule_proposal(9::smallint, %L, %L, 'roleplay_persona', gen_random_uuid()) $$,
    (select id from ids where name = 'l2_v0'), pg_temp.rules())),
  'PT422 invariant_violation', 'insert_rule_proposal raises invariant_violation for an unknown level'
);
select is(
  pg_temp.raises($$ select public.insert_rule_proposal(2::smallint, null, null, 'roleplay_persona', gen_random_uuid()) $$),
  'PT422 invariant_violation', 'insert_rule_proposal raises invariant_violation for missing arguments'
);
reset role;
select is(
  (select count(*)::integer from public.rule_sets where state = 'proposed'),
  (select count(*)::integer from ids where name not in ('l1_v0', 'l2_v0')),
  'the refused proposals inserted nothing'
);

-- ---------------------------------------------------------------------------
-- promote_rule_set (HC4): 16 tests
-- ---------------------------------------------------------------------------
set local role service_role;

select is(
  pg_temp.raises($$ select public.promote_rule_set(gen_random_uuid()) $$),
  'PT404 rule_set_not_found', 'promote_rule_set raises rule_set_not_found for an unknown id'
);
select is(
  pg_temp.raises(format($$ select public.promote_rule_set(%L) $$, (select id from ids where name = 'no_gate'))),
  'PT409 gate_not_passed', 'promote_rule_set raises without a gate run'
);
select is(
  pg_temp.raises(format($$ select public.promote_rule_set(%L) $$, (select id from ids where name = 'failed_gate'))),
  'PT409 gate_not_passed', 'promote_rule_set raises when the only gate run failed'
);
select is(
  pg_temp.raises(format($$ select public.promote_rule_set(%L) $$, (select id from ids where name = 'drops_flag'))),
  'PT422 weakens_parent', 'promote_rule_set raises PT422 for a candidate missing a parent flag'
);
select is(
  pg_temp.raises(format($$ select public.promote_rule_set(%L) $$, (select id from ids where name = 'l2_v0'))),
  'PT409 invalid_state', 'promote_rule_set raises for a candidate that is not proposed (the active seed)'
);

select is(
  public.promote_rule_set((select id from ids where name = 'good')),
  1, 'promote_rule_set activates the candidate as version parent + 1 and returns it'
);
select results_eq(
  format($$ select state::text, version, activated_at is not null from public.rule_sets where id = %L $$, (select id from ids where name = 'good')),
  $$ values ('active', 1, true) $$,
  'the promoted candidate is active at version 1'
);
select results_eq(
  format($$ select state::text, version, deactivated_at is not null from public.rule_sets where id = %L $$, (select id from ids where name = 'l2_v0')),
  $$ values ('superseded', 0, true) $$,
  'the parent is superseded'
);
select is(
  (select count(*)::integer from public.rule_sets where level_id = 2 and state = 'active'),
  1, 'level 2 still has exactly one active row'
);
select is(
  pg_temp.raises(format($$ select public.promote_rule_set(%L) $$, (select id from ids where name = 'good'))),
  'PT409 invalid_state', 'promoting the same rule set again raises: it is no longer proposed'
);
select is(
  pg_temp.raises(format($$ select public.promote_rule_set(%L) $$, (select id from ids where name = 'to_reject'))),
  'PT409 stale_parent', 'a candidate whose parent was superseded raises PT409 stale_parent'
);

-- A candidate on the new parent that drops the parent's keyword.
reset role;
insert into ids values
  ('drops_keyword', pg_temp.propose(2::smallint, (select id from ids where name = 'good'),
                      pg_temp.rules(array['reject_roleplay_archetypes', 'reject_authority_claims'], array['grandma vault ritual']))),
  ('v2',            pg_temp.propose(2::smallint, (select id from ids where name = 'good'),
                      pg_temp.rules(array['reject_roleplay_archetypes', 'reject_authority_claims', 'reject_delimiter_tokens'],
                                    array['grandma vault ritual', 'root user override'])));
select pg_temp.gate((select id from ids where name = 'drops_keyword'), true);
select pg_temp.gate((select id from ids where name = 'v2'), true);
set local role service_role;

select is(
  pg_temp.raises(format($$ select public.promote_rule_set(%L) $$, (select id from ids where name = 'drops_keyword'))),
  'PT422 weakens_parent', 'promote_rule_set raises PT422 for a candidate missing a parent keyword'
);
select is(public.promote_rule_set((select id from ids where name = 'v2')), 2, 'a second promotion returns version 2');
select is(
  pg_temp.raises($$ select public.promote_rule_set(null) $$),
  'PT422 invariant_violation', 'promote_rule_set raises invariant_violation without an id'
);
reset role;

select results_eq(
  $$ select level_id, id, version from public.rule_sets where state = 'active' and level_id <> 2 order by level_id $$,
  $$ select level_id, id, version from before_active where level_id <> 2 order by level_id $$,
  'CH-7: promotions at level 2 leave every other level''s active row unchanged'
);
select is(
  (select count(*)::integer from public.rule_sets where level_id = 1 and state = 'proposed'),
  1, 'CH-7: the level 1 proposal is untouched by promotions at level 2'
);

-- ---------------------------------------------------------------------------
-- reject_rule_set (section 6.8): 9 tests
-- ---------------------------------------------------------------------------
set local role service_role;
select lives_ok(
  format($$ select public.reject_rule_set(%L, 'benign_regression', true) $$, (select id from ids where name = 'to_reject')),
  'reject_rule_set rejects a proposed rule set'
);
select lives_ok(
  format($$ select public.reject_rule_set(%L, 'triggering_not_blocked', false) $$, (select id from ids where name = 'to_reject_2')),
  'reject_rule_set rejects without a review flag'
);
reset role;
select results_eq(
  format($$ select state::text, rejection_code, review_status::text, version is null from public.rule_sets where id = %L $$, (select id from ids where name = 'to_reject')),
  $$ values ('rejected', 'benign_regression', 'needs_review', true) $$,
  'p_needs_review true: rejected with the code and review_status needs_review'
);
select results_eq(
  format($$ select state::text, rejection_code, review_status::text from public.rule_sets where id = %L $$, (select id from ids where name = 'to_reject_2')),
  $$ values ('rejected', 'triggering_not_blocked', 'none') $$,
  'p_needs_review false: rejected with the code and review_status unchanged'
);
set local role service_role;
select lives_ok(
  format($$ select public.reject_rule_set(%L, 'behavior_shift', false) $$, (select id from ids where name = 'to_reject')),
  'rejecting an already rejected rule set is a no-op'
);
select is(
  (select rejection_code from public.rule_sets where id = (select id from ids where name = 'to_reject')),
  'benign_regression', 'the retry kept the first rejection code'
);
select is(
  pg_temp.raises(format($$ select public.reject_rule_set(%L, 'benign_regression', true) $$, (select id from ids where name = 'v2'))),
  'PT409 invalid_state', 'reject_rule_set raises for the active row'
);
select is(
  pg_temp.raises(format($$ select public.reject_rule_set(%L, 'Bad Code', true) $$, (select id from ids where name = 'no_gate'))),
  'PT422 invariant_violation', 'reject_rule_set raises for a malformed rejection code'
);
select is(
  pg_temp.raises($$ select public.reject_rule_set(gen_random_uuid(), 'benign_regression', true) $$),
  'PT404 rule_set_not_found', 'reject_rule_set raises for an unknown id'
);
select is(
  pg_temp.raises(format($$ select public.promote_rule_set(%L) $$, (select id from ids where name = 'to_reject'))),
  'PT409 invalid_state', 'a rejected rule set can never be promoted'
);
reset role;

-- ---------------------------------------------------------------------------
-- rollback_rule_set (R1-11a): 14 tests
-- ---------------------------------------------------------------------------
-- Level 2 now holds: v0 (superseded), v1 'good' (superseded), v2 (active).
set local role service_role;
select is(
  pg_temp.raises(format($$ select public.rollback_rule_set(2::smallint, %L) $$, (select id from ids where name = 'l1_v0'))),
  'PT422 invalid_rollback_target', 'rollback_rule_set refuses a target from another level'
);
select is(
  pg_temp.raises(format($$ select public.rollback_rule_set(2::smallint, %L) $$, (select id from ids where name = 'to_reject'))),
  'PT422 invalid_rollback_target', 'rollback_rule_set refuses a rejected target'
);
select is(
  pg_temp.raises(format($$ select public.rollback_rule_set(2::smallint, %L) $$, (select id from ids where name = 'no_gate'))),
  'PT422 invalid_rollback_target', 'rollback_rule_set refuses a proposed target, which has no version'
);
select is(
  pg_temp.raises(format($$ select public.rollback_rule_set(2::smallint, %L) $$, (select id from ids where name = 'v2'))),
  'PT422 invalid_rollback_target', 'rollback_rule_set refuses the active row itself'
);
select is(
  pg_temp.raises($$ select public.rollback_rule_set(2::smallint, gen_random_uuid()) $$),
  'PT422 invalid_rollback_target', 'rollback_rule_set refuses an unknown target'
);
select is(
  pg_temp.raises(format($$ select public.rollback_rule_set(9::smallint, %L) $$, (select id from ids where name = 'good'))),
  'PT422 invariant_violation', 'rollback_rule_set refuses an unknown level'
);
reset role;
-- Every versionless row is proposed or rejected (rule_sets_version_once_live),
-- so the two refusals above cover a target with no version.
select is_empty(
  $$ select id from public.rule_sets where version is null and state not in ('proposed', 'rejected') $$,
  'only proposed and rejected rows lack a version'
);

set local role service_role;
insert into ids values ('rollback_1', public.rollback_rule_set(2::smallint, (select id from ids where name = 'good')));
reset role;
select results_eq(
  format($$ select state::text, version, source, parent_id, rules, rules_sha256, activated_at is not null, technique is null, source_attempt_id is null
            from public.rule_sets where id = %L $$, (select id from ids where name = 'rollback_1')),
  format($$ select 'active'::text, 3, 'admin_rollback'::text, %L::uuid, rules, rules_sha256, true, true, true from public.rule_sets where id = %L $$,
    (select id from ids where name = 'v2'), (select id from ids where name = 'good')),
  'a superseded target becomes a new active row: version 3, source admin_rollback, parent = the previous active row, the target''s rules'
);
select results_eq(
  format($$ select state::text, deactivated_at is not null from public.rule_sets where id = %L $$, (select id from ids where name = 'v2')),
  $$ values ('rolled_back', true) $$,
  'the previous active row is marked rolled_back'
);
select results_eq(
  format($$ select state::text from public.rule_sets where id = %L $$, (select id from ids where name = 'good')),
  $$ values ('superseded') $$,
  'the rollback target itself is copied, not changed'
);

set local role service_role;
insert into ids values ('rollback_2', public.rollback_rule_set(2::smallint, (select id from ids where name = 'v2')));
reset role;
select results_eq(
  format($$ select state::text, version, source, rules from public.rule_sets where id = %L $$, (select id from ids where name = 'rollback_2')),
  format($$ select 'active'::text, 4, 'admin_rollback'::text, rules from public.rule_sets where id = %L $$, (select id from ids where name = 'v2')),
  'a rolled_back target can be reactivated too (version 4)'
);
select is(
  (select count(*)::integer from public.rule_sets where level_id = 2 and state = 'active'),
  1, 'level 2 has exactly one active row after the rollbacks'
);
select results_eq(
  $$ select level_id, id, version from public.rule_sets where state = 'active' and level_id <> 2 order by level_id $$,
  $$ select level_id, id, version from before_active where level_id <> 2 order by level_id $$,
  'CH-7: rollbacks at level 2 leave every other level''s active row unchanged'
);
select is(
  pg_temp.raises(format($$ select public.promote_rule_set(%L) $$, (select id from ids where name = 'drops_keyword'))),
  'PT409 stale_parent', 'a proposal whose parent was rolled back is stale'
);

-- ---------------------------------------------------------------------------
-- reset_level_rules: 6 tests
-- ---------------------------------------------------------------------------
set local role service_role;
insert into ids values ('reset_2', public.reset_level_rules(2::smallint));
reset role;
select results_eq(
  format($$ select state::text, version, source, parent_id, rules from public.rule_sets where id = %L $$, (select id from ids where name = 'reset_2')),
  format($$ select 'active'::text, 5, 'admin_reset'::text, %L::uuid, rules from public.rule_sets where level_id = 2 and version = 0 $$,
    (select id from ids where name = 'rollback_2')),
  'reset_level_rules creates a new active row with the seed rules: version 5, source admin_reset'
);
select results_eq(
  format($$ select state::text from public.rule_sets where id = %L $$, (select id from ids where name = 'rollback_2')),
  $$ values ('rolled_back') $$,
  'reset_level_rules marks the previous active row rolled_back'
);
select results_eq(
  $$ select state::text, source from public.rule_sets where level_id = 2 and version = 0 $$,
  $$ values ('superseded', 'seed') $$,
  'the seed row is copied, not changed'
);

set local role service_role;
insert into ids values ('reset_3', public.reset_level_rules(3::smallint));
select is(
  pg_temp.raises($$ select public.reset_level_rules(9::smallint) $$),
  'PT422 invariant_violation', 'reset_level_rules refuses an unknown level'
);
reset role;
select results_eq(
  format($$ select level_id, state::text, version, source, rules from public.rule_sets where id = %L $$, (select id from ids where name = 'reset_3')),
  $$ select level_id, 'active'::text, 1, 'admin_reset'::text, rules from public.rule_sets where level_id = 3 and version = 0 $$,
  'resetting a level still at its seed creates version 1 with the seed rules'
);
select results_eq(
  $$ select level_id, id, version from public.rule_sets where state = 'active' and level_id not in (2, 3) order by level_id $$,
  $$ select level_id, id, version from before_active where level_id not in (2, 3) order by level_id $$,
  'CH-7: resets leave every other level''s active row unchanged'
);

-- ---------------------------------------------------------------------------
-- Privileges, search_path, and schema qualification (R2-17): 12 tests
-- ---------------------------------------------------------------------------
create temporary table rpc_functions (fn regprocedure primary key) on commit drop;
insert into rpc_functions values
  ('public.insert_rule_proposal(smallint, uuid, jsonb, public.attack_technique, uuid)'::regprocedure),
  ('public.promote_rule_set(uuid)'::regprocedure),
  ('public.reject_rule_set(uuid, text, boolean)'::regprocedure),
  ('public.rollback_rule_set(smallint, uuid)'::regprocedure),
  ('public.reset_level_rules(smallint)'::regprocedure),
  ('private._reactivate_rules(smallint, jsonb, text)'::regprocedure);

create temporary table rule_functions (fn regprocedure primary key) on commit drop;
insert into rule_functions
  select fn from rpc_functions
  union all
  values ('public.rule_set_payload_ok(jsonb)'::regprocedure),
         ('public.level_secret_payload_ok(jsonb)'::regprocedure),
         ('private.rule_set_sha256(jsonb)'::regprocedure);

select is_empty(
  $$ select r.role_name || ' ' || f.fn::text
     from (values ('anon'), ('authenticated')) as r (role_name), rpc_functions f
     where has_function_privilege(r.role_name, f.fn, 'EXECUTE') $$,
  'R2-17: anon and authenticated cannot execute any function of 00003'
);
select is_empty(
  $$ select f.fn::text
     from rpc_functions f, pg_proc p, aclexplode(p.proacl) as a
     where p.oid = f.fn and a.grantee = 0 $$,
  'no function of 00003 grants anything to PUBLIC'
);
select is_empty(
  $$ select f.fn::text from rpc_functions f where not has_function_privilege('service_role', f.fn, 'EXECUTE') $$,
  'service_role can execute every function of 00003'
);
select is(
  (select count(*)::integer from rule_functions f join pg_proc p on p.oid = f.fn
   where p.proconfig @> array['search_path=""'] and not p.prosecdef),
  9, 'R2-17: every function of 00002 and 00003 sets search_path to the empty string and is SECURITY INVOKER'
);
select is(
  (select count(*)::integer from rule_functions f join pg_proc p on p.oid = f.fn join pg_language l on l.oid = p.prolang where l.lanname = 'plpgsql'),
  9, 'every function of 00002 and 00003 is plpgsql'
);

-- Schema qualification: with comments and string literals removed, no
-- function body names one of this project's tables, types, or functions
-- without its schema. The behavioural proof is the rest of this file: every
-- function ran above with search_path set to the empty string, where an
-- unqualified name would fail.
create temporary table rule_function_bodies on commit drop as
  select f.fn::text as fn,
         regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '''([^'']|'''')*''', '''''', 'g') as body
  from rule_functions f join pg_proc p on p.oid = f.fn;

select is_empty(
  $$ select fn from rule_function_bodies
     where body ~* '\m(from|join|into|update|table)\s+(levels|rule_sets|rule_gate_runs|golden_prompts|level_secrets|attempts|app_config|profiles)\M' $$,
  'R2-17: every table reference is schema-qualified'
);
select is_empty(
  $$ select fn from rule_function_bodies
     where body ~* '::\s*(rule_set_state|review_status|attack_technique)\M'
        or body ~* '(^|[^.[:alnum:]_])(rule_set_state|attack_technique)\M'
        or body ~* '(^|[^.[:alnum:]_])rule_sets%rowtype' $$,
  'R2-17: every type reference is schema-qualified'
);
select is_empty(
  $$ select fn from rule_function_bodies
     where body ~* '(^|[^.[:alnum:]_])(rule_set_payload_ok|level_secret_payload_ok|rule_set_sha256|_reactivate_rules|digest|handle_updated_at)\s*\(' $$,
  'R2-17: every call to a project or extension function is schema-qualified'
);
select ok(
  (select count(*) from rule_function_bodies where body ~ 'public\.rule_sets') >= 5,
  'the scan sees the qualified references, so it is looking at the real bodies'
);

set local role anon;
select is(
  pg_temp.raises(format($$ select public.promote_rule_set(%L) $$, (select gen_random_uuid()))),
  '42501 permission denied for function promote_rule_set', 'anon gets permission denied for promote_rule_set'
);
reset role;
set local role authenticated;
select is(
  pg_temp.raises($$ select public.reset_level_rules(1::smallint) $$),
  '42501 permission denied for function reset_level_rules', 'authenticated gets permission denied for reset_level_rules'
);
select is(
  pg_temp.raises($$ select public.insert_rule_proposal(1::smallint, gen_random_uuid(), '{}'::jsonb, 'roleplay_persona', gen_random_uuid()) $$),
  '42501 permission denied for function insert_rule_proposal', 'authenticated gets permission denied for insert_rule_proposal'
);
reset role;

select * from finish();
rollback;
