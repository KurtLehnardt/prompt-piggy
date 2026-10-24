-- Migration 00002: the sanitized-rules schema (task PP-07)
--
-- Contents (docs/ARCHITECTURE.md sections 5.1, 5.2, 5.3, 6.1 to 6.5, 6.7, 6.8):
--   1. public.levels (publicly readable) and its five rows.
--   2. The enums public.rule_set_state, public.review_status, and
--      public.attack_technique (12 values, including unknown, R2-S3).
--   3. public.rule_set_payload_ok(jsonb): the SQL mirror of the zod
--      RuleSetSchema, with every cap (HC1, HC-A1), and
--      private.rule_set_sha256(jsonb): the hash of a rule set's canonical JSON.
--   4. public.rule_sets: versioned rule sets, one lineage per level (CH-7).
--   5. public.rule_gate_runs: one row per stage-A gate run (HC4, HC-A3).
--   6. public.golden_prompts: the benign and breach corpora kept in the database.
--   7. public.level_secret_payload_ok(jsonb) and public.level_secrets: the
--      service-role-only level 4 and 5 secret material (R2-12). This
--      migration creates no row in that table, and neither does any other
--      migration; rows come from scripts/ops/seed-level-secrets.mjs, or, on a
--      local database only, from supabase/seed.sql.
--   8. The version-0 rule set of every level (section 6.2).
--   9. A self-check that fails the migration if a privilege is not as intended.
--
-- Access model (section 5.3): levels is readable by anon and authenticated.
-- rule_sets, rule_gate_runs, golden_prompts, and level_secrets have RLS
-- enabled, no policy, and no grant to anon or authenticated, so only the
-- service role reaches them. The CI advisor gate allowlists exactly these
-- tables for the rls_enabled_no_policy finding. Every table grants its DML to
-- service_role explicitly (PR #3 review, H1): 00001 revoked every default
-- privilege, and Supabase revokes the platform defaults on 2026-10-30. None of
-- these tables has a sequence, because every key is a uuid or a smallint.
--
-- Every function sets search_path = '' and schema-qualifies every table,
-- type, and function it uses; only pg_catalog built-ins stay unqualified
-- (R2-17). Every function is SECURITY INVOKER.
--
-- Re-runnable: if not exists, create or replace, guarded type creation, and
-- on conflict do nothing, so applying this file twice changes nothing.

-- ===========================================================================
-- 1. levels: the five difficulty levels (publicly readable)
-- ===========================================================================
-- Money never lives here: every attempt costs the same at every level, and
-- prices are app_config rows (section 5.1, CH-1). Rows are written by
-- migrations only; references to this five-row table are not indexed
-- (section 5.1, R2-19) because it is never deleted from.
create table if not exists public.levels (
  id        smallint primary key,
  slug      text not null,
  name      text not null,
  is_active boolean not null default true,
  constraint levels_id_range    check (id between 1 and 5),
  constraint levels_slug_format check (slug ~ '^[a-z-]{3,24}$'),
  constraint levels_name_length check (char_length(name) between 1 and 40),
  constraint levels_slug_key    unique (slug)
);

comment on table public.levels is
  'The five difficulty levels. Readable by anon and authenticated. No fee or '
  'payout column: prices are app_config rows (CH-1). Written by migrations only.';

alter table public.levels enable row level security;

drop policy if exists "levels: public read" on public.levels;
create policy "levels: public read" on public.levels
  for select
  to anon, authenticated
  using (true);

revoke all on table public.levels from public, anon, authenticated;
grant select on table public.levels to anon, authenticated;
grant select, insert, update, delete on table public.levels to service_role;

insert into public.levels (id, slug, name, is_active) values
  (1, 'piglet',   'Piglet',   true),
  (2, 'porker',   'Porker',   true),
  (3, 'hog',      'Hog',      true),
  (4, 'boar',     'Boar',     true),
  (5, 'iron-pig', 'Iron Pig', true)
on conflict (id) do nothing;

-- ===========================================================================
-- 2. Enums
-- ===========================================================================
-- CREATE TYPE has no IF NOT EXISTS, so each one is guarded.
do $$
begin
  if to_regtype('public.rule_set_state') is null then
    create type public.rule_set_state as enum ('proposed', 'active', 'superseded', 'rejected', 'rolled_back');
  end if;

  if to_regtype('public.review_status') is null then
    create type public.review_status as enum ('none', 'needs_review', 'dismissed', 'actioned');
  end if;

  -- The 11 engine classes plus unknown, in the order of ATTACK_TECHNIQUES in
  -- src/lib/config/techniques.ts. unknown means the Decisions call was
  -- unavailable (R2-S3): it is never a model choice or an engine label, and
  -- insert_rule_proposal refuses it.
  if to_regtype('public.attack_technique') is null then
    create type public.attack_technique as enum (
      'roleplay_persona', 'authority_impersonation', 'instruction_override', 'delimiter_injection',
      'encoded_smuggling', 'tool_or_mcp_takeover', 'deferred_trigger', 'emotional_social_engineering',
      'prompt_extraction', 'multilingual_obfuscation', 'unclassified',
      'unknown'
    );
  end if;
end
$$;

-- ===========================================================================
-- 3. Rule-set payload check and hash
-- ===========================================================================

-- Structural mirror of the zod RuleSetSchema (section 6.1; caps in section
-- 6.3). zod stays authoritative in TypeScript; this CHECK is defense in depth
-- (HC1, HC-A1). A rule set has exactly two kinds of fields: the nine
-- deterministic detector flags, each a JSON boolean, and block_keywords, a
-- sanitized string array that the validator matches as data only. There is no
-- free-text field.
--
-- It returns true or false and never raises. The checks run in order inside
-- plpgsql, so the byte cap is applied before anything is expanded, and an
-- array function is reached only after the value is known to be an array.
create or replace function public.rule_set_payload_ok(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_keys text[];
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return false;
  end if;

  -- cap:bytes. The jsonb text form is at least as long as canonical JSON, so
  -- this is never looser than the zod cap of 4,096 bytes of canonical JSON.
  if octet_length(p::text) > 4096 then
    return false;
  end if;

  -- Exactly these eleven keys: an unknown key, including the removed
  -- strict_transfer_policy, is rejected (HC1).
  select array_agg(k order by k collate "C") into v_keys from jsonb_object_keys(p) as k;
  if v_keys is distinct from array[
    'block_keywords',
    'reject_authority_claims',
    'reject_deferred_instructions',
    'reject_delimiter_tokens',
    'reject_encoded_payloads',
    'reject_hypothetical_framing',
    'reject_instruction_override',
    'reject_mixed_script_obfuscation',
    'reject_roleplay_archetypes',
    'reject_tool_invocation_language',
    'schema_version'
  ]::text[] then
    return false;
  end if;

  if p -> 'schema_version' is distinct from '1'::jsonb then
    return false;
  end if;

  -- Each of the nine flags is a JSON boolean.
  if exists (
    select 1
    from unnest(array[
      'reject_authority_claims', 'reject_deferred_instructions', 'reject_delimiter_tokens',
      'reject_encoded_payloads', 'reject_hypothetical_framing', 'reject_instruction_override',
      'reject_mixed_script_obfuscation', 'reject_roleplay_archetypes', 'reject_tool_invocation_language'
    ]) as f
    where jsonb_typeof(p -> f) is distinct from 'boolean'
  ) then
    return false;
  end if;

  -- cap:entries. At most 32 keywords per rule set. Each guard is its own
  -- statement, so no array function can run on a value that is not an array,
  -- even if the planner folds a constant argument early.
  if jsonb_typeof(p -> 'block_keywords') is distinct from 'array' then
    return false;
  end if;
  if jsonb_array_length(p -> 'block_keywords') > 32 then
    return false;
  end if;

  -- cap:length and cap:charset: 8 to 48 characters, and 2 to 4 tokens of
  -- ASCII lowercase letters and digits separated by single spaces,
  -- apostrophes, or hyphens. The same pattern as KEYWORD_RE in section 6.1.
  if exists (
    select 1
    from jsonb_array_elements(p -> 'block_keywords') as e
    where jsonb_typeof(e) <> 'string'
       or char_length(e #>> '{}') not between 8 and 48
       or (e #>> '{}') !~ '^[a-z0-9]+([ ''-][a-z0-9]+){1,3}$'
  ) then
    return false;
  end if;

  -- Unique keywords.
  if (
    select count(*) <> count(distinct e)
    from jsonb_array_elements_text(p -> 'block_keywords') as e
  ) then
    return false;
  end if;

  return true;
end
$$;

-- service_role writes rule_sets, and a CHECK constraint runs its function with
-- the privileges of the writing role.
revoke all on function public.rule_set_payload_ok(jsonb) from public, anon, authenticated;
grant execute on function public.rule_set_payload_ok(jsonb) to service_role;

comment on function public.rule_set_payload_ok(jsonb) is
  'True when the value is a valid version-1 rule set: exactly the nine boolean '
  'detector flags, block_keywords (at most 32 unique entries, 8 to 48 characters, '
  '2 to 4 lowercase ASCII tokens), and schema_version 1, in at most 4096 bytes. '
  'Never raises. Mirrors the zod RuleSetSchema (section 6.1).';

-- The sha256 (lowercase hex) of a rule set's canonical JSON, or null when the
-- value is not a valid rule set. Canonical JSON has no whitespace, its keys in
-- ascending code-point order, block_keywords sorted in ascending code-point
-- order, schema_version written as 1, and each flag as true or false. For a
-- valid rule set (ASCII keys, ASCII keywords without quotes or backslashes,
-- booleans, and the integer 1) this is byte-identical to JSON.stringify of
-- the same object with sorted keys and sorted keywords, so a hash computed in
-- TypeScript over the same canonical form matches it.
create or replace function private.rule_set_sha256(p jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_keywords  text;
  v_canonical text;
begin
  if not public.rule_set_payload_ok(p) then
    return null;
  end if;

  select coalesce('[' || string_agg(to_jsonb(e)::text, ',' order by e collate "C") || ']', '[]')
    into v_keywords
  from jsonb_array_elements_text(p -> 'block_keywords') as e;

  select '{' || string_agg(
           to_jsonb(k)::text || ':' || case k
             when 'block_keywords' then v_keywords
             when 'schema_version' then '1'          -- validated above; written as JSON.stringify writes 1 (or 1.0)
             else (p -> k)::text                      -- a flag: true or false
           end,
           ',' order by k collate "C") || '}'
    into v_canonical
  from jsonb_object_keys(p) as k;

  return encode(extensions.digest(v_canonical, 'sha256'), 'hex');
end
$$;

-- Used by a CHECK constraint on rule_sets and by the 00003 RPCs, all of which
-- run as service_role.
revoke all on function private.rule_set_sha256(jsonb) from public, anon, authenticated;
grant execute on function private.rule_set_sha256(jsonb) to service_role;

comment on function private.rule_set_sha256(jsonb) is
  'sha256 hex of the canonical JSON of a valid rule set (sorted keys, sorted '
  'block_keywords, no whitespace); null for an invalid one.';

-- ===========================================================================
-- 4. rule_sets: versioned rule sets, one lineage per level
-- ===========================================================================
-- States (section 6.5): proposed -> active (promote_rule_set) or rejected
-- (reject_rule_set); active -> superseded (a newer version or a keyword
-- removal) or rolled_back (rollback_rule_set, reset_level_rules). A version
-- number is assigned only on activation. All writes go through the 00003
-- functions and the later service-role RPCs; nothing an end user holds can
-- read or write this table.
create table if not exists public.rule_sets (
  id                uuid primary key default gen_random_uuid(),
  level_id          smallint not null references public.levels (id),
  version           integer,                          -- assigned on activation only
  parent_id         uuid references public.rule_sets (id),
  state             public.rule_set_state not null default 'proposed',
  rules             jsonb not null,
  rules_sha256      text not null,
  source            text not null,
  source_attempt_id uuid,                             -- foreign key added in 00004; a paid win only (CH-6b)
  technique         public.attack_technique,          -- the engine's label: display metadata only
  review_status     public.review_status not null default 'none',
  rejection_code    text,
  created_at        timestamptz not null default now(),
  activated_at      timestamptz,
  deactivated_at    timestamptz,
  constraint rule_sets_rules_valid          check (public.rule_set_payload_ok(rules)),
  constraint rule_sets_rules_sha256_format  check (rules_sha256 ~ '^[0-9a-f]{64}$'),
  -- The stored hash is always the hash of the stored rules.
  constraint rule_sets_rules_sha256_matches check (rules_sha256 is not distinct from private.rule_set_sha256(rules)),
  constraint rule_sets_version_nonnegative  check (version >= 0),
  constraint rule_sets_source_known         check (source in ('seed', 'hardening', 'admin_rollback', 'admin_reset', 'admin_remove_keyword')),
  constraint rule_sets_rejection_code_format check (rejection_code ~ '^[a-z_]{3,40}$'),
  constraint rule_sets_version_once_live    check (state in ('proposed', 'rejected') or version is not null),
  constraint rule_sets_not_own_parent       check (parent_id is distinct from id),
  -- The version-0 row of each level is the seed, and only the seed.
  constraint rule_sets_seed_is_version_zero check ((source = 'seed') = (version is not distinct from 0) and (source <> 'seed' or parent_id is null))
);

comment on table public.rule_sets is
  'Sanitized, typed rule sets (HC1): nine detector flags and block_keywords, '
  'versioned per level. Service role only: RLS enabled, no policy, no grant to '
  'anon or authenticated. Written only through the rule-set RPCs.';
comment on column public.rule_sets.technique is
  'The Hardening Engine''s attack-technique label. Display metadata only: it never selects a flag or a keyword (CH-6b).';

create unique index if not exists rule_sets_one_active_per_level on public.rule_sets (level_id) where state = 'active';
create unique index if not exists rule_sets_level_version       on public.rule_sets (level_id, version) where version is not null;
create index if not exists rule_sets_review_queue  on public.rule_sets (created_at desc) where review_status = 'needs_review';
create index if not exists rule_sets_level_created on public.rule_sets (level_id, created_at desc);
-- Every foreign-key column is indexed (skill reference schema-foreign-key-indexes, R2-19).
create index if not exists rule_sets_parent         on public.rule_sets (parent_id);
create index if not exists rule_sets_source_attempt on public.rule_sets (source_attempt_id);   -- foreign key added in 00004

alter table public.rule_sets enable row level security;     -- no policy: service role only

revoke all on table public.rule_sets from public, anon, authenticated;
grant select, insert, update, delete on table public.rule_sets to service_role;

-- ===========================================================================
-- 5. rule_gate_runs: one row per stage-A gate run (HC4, HC-A3, section 6.7)
-- ===========================================================================
-- Append-only by convention: the pipeline (PP-23) inserts one row per run,
-- whether it passes or fails, and promote_rule_set requires a passing one.
create table if not exists public.rule_gate_runs (
  id                      uuid primary key default gen_random_uuid(),
  rule_set_id             uuid not null references public.rule_sets (id) on delete cascade,
  passed                  boolean not null,
  benign_total            integer not null default 0,
  benign_new_blocks       integer not null default 0,
  loophole_total          integer not null default 0,
  loophole_new_blocks     integer not null default 0,
  benign_signal_shift_bps integer not null default 0,
  breach_total            integer not null default 0,
  breach_regressions      integer not null default 0,
  triggering_blocked      boolean,
  traffic_total           integer not null default 0,
  traffic_new_blocks      integer not null default 0,
  dropped_keywords        integer not null default 0,   -- removed before gating, with reason codes below
  dropped_flags           integer not null default 0,
  drop_codes              text[] not null default '{}',
  failure_codes           text[] not null default '{}',
  max_validator_ms        numeric(8, 3),                -- recorded, never a gate condition (R1-12)
  started_at              timestamptz not null default now(),
  finished_at             timestamptz,
  constraint rule_gate_runs_drop_codes_known check (drop_codes <@ array[
    'not_in_breach', 'stoplisted', 'stop_phrase', 'no_content_token', 'charset', 'duplicate',
    'already_in_parent', 'traffic_frequent', 'hits_benign', 'hits_loophole', 'over_proposal_cap'
  ]::text[]),
  constraint rule_gate_runs_failure_codes_known check (failure_codes <@ array[
    'schema_invalid', 'cap_exceeded', 'benign_regression', 'loophole_regression', 'behavior_shift',
    'breach_regression', 'triggering_not_blocked', 'traffic_regression'
  ]::text[]),
  -- A passing run has no failure code.
  constraint rule_gate_runs_passed_has_no_failure check (not passed or cardinality(failure_codes) = 0),
  constraint rule_gate_runs_counts_nonnegative check (
    benign_total >= 0 and benign_new_blocks >= 0 and loophole_total >= 0 and loophole_new_blocks >= 0
    and breach_total >= 0 and breach_regressions >= 0 and traffic_total >= 0 and traffic_new_blocks >= 0
    and dropped_keywords >= 0 and dropped_flags >= 0
  ),
  constraint rule_gate_runs_shift_bps_range check (benign_signal_shift_bps between 0 and 10000)
);

comment on table public.rule_gate_runs is
  'One row per deterministic stage-A gate run (HC4, HC-A3): counts, drop codes, '
  'and failure codes. Service role only: RLS enabled, no policy, no grant to '
  'anon or authenticated.';

create index if not exists rule_gate_runs_rule_set on public.rule_gate_runs (rule_set_id);

alter table public.rule_gate_runs enable row level security;     -- no policy: service role only

revoke all on table public.rule_gate_runs from public, anon, authenticated;
grant select, insert, update, delete on table public.rule_gate_runs to service_role;

-- ===========================================================================
-- 6. golden_prompts: the database half of the golden dataset (section 6.6)
-- ===========================================================================
-- Benign rows are added through the SQL runbook; breach rows come only from a
-- paid win through add_breach_to_golden (PP-18, CH-6b). Breach text is
-- attacker-derived and is only ever replayed through the validator, never
-- placed in an LLM prompt.
create table if not exists public.golden_prompts (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,
  level_id    smallint references public.levels (id),   -- null = every level (benign only)
  text        text not null,
  text_sha256 text not null,
  source      text not null,
  attempt_id  uuid,                                       -- foreign key added in 00004
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint golden_prompts_kind_known         check (kind in ('benign', 'breach')),
  constraint golden_prompts_text_length        check (char_length(text) between 1 and 4000),
  constraint golden_prompts_text_sha256_format check (text_sha256 ~ '^[0-9a-f]{64}$'),
  constraint golden_prompts_source_known       check (source in ('breach_auto', 'admin_sql')),
  constraint golden_breach_has_level           check (kind = 'benign' or level_id is not null),
  constraint golden_breach_is_auto             check (kind = 'benign' or source = 'breach_auto')
);

comment on table public.golden_prompts is
  'Benign prompts added through the SQL runbook and past breaches added by '
  'add_breach_to_golden. Replayed through the validator only. Service role '
  'only: RLS enabled, no policy, no grant to anon or authenticated.';

create unique index if not exists golden_prompts_dedupe on public.golden_prompts (kind, coalesce(level_id, 0), text_sha256);
create index if not exists golden_prompts_level_kind on public.golden_prompts (level_id, kind) where is_active;
create index if not exists golden_prompts_attempt    on public.golden_prompts (attempt_id);   -- R2-19; foreign key added in 00004

alter table public.golden_prompts enable row level security;     -- no policy: service role only

revoke all on table public.golden_prompts from public, anon, authenticated;
grant select, insert, update, delete on table public.golden_prompts to service_role;

-- ===========================================================================
-- 7. level_secrets: level 4 and 5 secret material (R2-12, section 6.2)
-- ===========================================================================

-- Structural mirror of LevelSecretPayloadSchema in
-- src/lib/config/level-secrets.ts. zod stays authoritative; this CHECK is
-- defense in depth. Exactly the keys schema_version (1), placeholder
-- (boolean), policy (1 to 600 characters), fragments (1 to 8 strings of 1 to
-- 400 characters), tripwire_threshold (a number from 0.5 to 0.99),
-- decisions_predicate_instructions (40 to 1500 characters), and
-- extra_detector_phrases (an object whose keys are detector families from
-- src/lib/config/detector-families.ts and whose values are arrays of at most
-- 64 phrases of 3 to 64 characters, 1 to 6 lowercase ASCII tokens), in at most
-- 16,384 bytes of jsonb text. Lengths here count characters (code points);
-- zod counts UTF-16 code units, which is never fewer.
--
-- It returns true or false and never raises, and it never echoes a value.
create or replace function public.level_secret_payload_ok(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_keys text[];
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return false;
  end if;

  if octet_length(p::text) > 16384 then
    return false;
  end if;

  select array_agg(k order by k collate "C") into v_keys from jsonb_object_keys(p) as k;
  if v_keys is distinct from array[
    'decisions_predicate_instructions',
    'extra_detector_phrases',
    'fragments',
    'placeholder',
    'policy',
    'schema_version',
    'tripwire_threshold'
  ]::text[] then
    return false;
  end if;

  if p -> 'schema_version' is distinct from '1'::jsonb then
    return false;
  end if;

  if jsonb_typeof(p -> 'placeholder') is distinct from 'boolean' then
    return false;
  end if;

  if jsonb_typeof(p -> 'policy') is distinct from 'string'
     or char_length(p ->> 'policy') not between 1 and 600 then
    return false;
  end if;

  -- Each guard is its own statement, so no array or numeric function runs on
  -- a value of the wrong type.
  if jsonb_typeof(p -> 'fragments') is distinct from 'array' then
    return false;
  end if;
  if jsonb_array_length(p -> 'fragments') not between 1 and 8 then
    return false;
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p -> 'fragments') as e
    where jsonb_typeof(e) <> 'string'
       or char_length(e #>> '{}') not between 1 and 400
  ) then
    return false;
  end if;

  -- Fail closed at both levels: the threshold is never below 0.5 (section 6.2).
  if jsonb_typeof(p -> 'tripwire_threshold') is distinct from 'number' then
    return false;
  end if;
  if (p ->> 'tripwire_threshold')::numeric not between 0.5 and 0.99 then
    return false;
  end if;

  if jsonb_typeof(p -> 'decisions_predicate_instructions') is distinct from 'string'
     or char_length(p ->> 'decisions_predicate_instructions') not between 40 and 1500 then
    return false;
  end if;

  -- Every key is a detector family (the nine of DETECTOR_FAMILIES); each one
  -- is optional.
  if jsonb_typeof(p -> 'extra_detector_phrases') is distinct from 'object' then
    return false;
  end if;
  if exists (
    select 1
    from jsonb_each(p -> 'extra_detector_phrases') as f (family, phrases)
    where f.family not in (
            'roleplay', 'authority', 'override', 'delimiter', 'decode',
            'tool', 'deferred', 'mixed_script', 'hypothetical')
       or jsonb_typeof(f.phrases) <> 'array'
  ) then
    return false;
  end if;
  if exists (
    select 1
    from jsonb_each(p -> 'extra_detector_phrases') as f (family, phrases)
    where jsonb_array_length(f.phrases) > 64
  ) then
    return false;
  end if;

  -- Phrases are matched as token sequences like keywords, never compiled into
  -- a RegExp, and never placed in a prompt (HC-A1).
  if exists (
    select 1
    from jsonb_each(p -> 'extra_detector_phrases') as f (family, phrases),
         jsonb_array_elements(f.phrases) as e
    where jsonb_typeof(e) <> 'string'
       or char_length(e #>> '{}') not between 3 and 64
       or (e #>> '{}') !~ '^[a-z0-9]+([ ''-][a-z0-9]+){0,5}$'
  ) then
    return false;
  end if;

  return true;
end
$$;

-- The operator seed script writes level_secrets as service_role.
revoke all on function public.level_secret_payload_ok(jsonb) from public, anon, authenticated;
grant execute on function public.level_secret_payload_ok(jsonb) to service_role;

comment on function public.level_secret_payload_ok(jsonb) is
  'True when the value has the shape of LevelSecretPayloadSchema (section 6.2). '
  'Never raises and never echoes a value.';

-- The secret material itself. Service role only: RLS is enabled with no
-- policy, anon and authenticated hold no privilege, no view selects from it,
-- no function that anon or authenticated may execute reads it, and it is not
-- in the realtime publication. The pgTAP suite checks all of that.
create table if not exists public.level_secrets (
  level_id       smallint primary key references public.levels (id),
  payload        jsonb not null,
  payload_sha256 text not null,
  updated_at     timestamptz not null default now(),
  constraint level_secrets_secret_levels_only check (level_id in (4, 5)),
  constraint level_secrets_payload_valid      check (public.level_secret_payload_ok(payload)),
  constraint level_secrets_sha256_format      check (payload_sha256 ~ '^[0-9a-f]{64}$')
);

comment on table public.level_secrets is
  'Level 4 and 5 secret material (R2-12). Service role only: RLS enabled, no '
  'policy, no grant to anon or authenticated. Seeded by the operator with '
  'scripts/ops/seed-level-secrets.mjs; local databases get placeholders from '
  'supabase/seed.sql. Never seeded by a migration.';
comment on column public.level_secrets.payload_sha256 is
  'sha256 hex of the payload''s canonical JSON (keys sorted recursively, no '
  'whitespace), computed by scripts/ops/seed-level-secrets.mjs.';

create or replace trigger level_secrets_updated_at
  before update on public.level_secrets
  for each row execute function private.handle_updated_at();

alter table public.level_secrets enable row level security;     -- no policy: service role only

revoke all on table public.level_secrets from public, anon, authenticated;
grant select, insert, update, delete on table public.level_secrets to service_role;

-- ===========================================================================
-- 8. Version-0 rule sets (section 6.2, "On in version 0 for")
-- ===========================================================================
-- One active version-0 row per level, with no keywords. Flags switch on
-- cumulatively: L2 adds roleplay; L3 adds authority, instruction override,
-- and delimiter tokens; L4 adds encoded payloads, tool invocation language,
-- and deferred instructions; L5 adds mixed-script obfuscation and
-- hypothetical framing. reset_level_rules copies these rows. on conflict do
-- nothing keeps them, and any later version, when the file is re-run.
insert into public.rule_sets (level_id, version, parent_id, state, rules, rules_sha256, source, activated_at)
select s.level_id, 0, null, 'active', s.rules, private.rule_set_sha256(s.rules), 'seed', now()
from (
  values
    (1::smallint, '{"schema_version": 1, "block_keywords": [],
      "reject_roleplay_archetypes": false, "reject_authority_claims": false,
      "reject_instruction_override": false, "reject_delimiter_tokens": false,
      "reject_encoded_payloads": false, "reject_tool_invocation_language": false,
      "reject_deferred_instructions": false, "reject_mixed_script_obfuscation": false,
      "reject_hypothetical_framing": false}'::jsonb),
    (2::smallint, '{"schema_version": 1, "block_keywords": [],
      "reject_roleplay_archetypes": true, "reject_authority_claims": false,
      "reject_instruction_override": false, "reject_delimiter_tokens": false,
      "reject_encoded_payloads": false, "reject_tool_invocation_language": false,
      "reject_deferred_instructions": false, "reject_mixed_script_obfuscation": false,
      "reject_hypothetical_framing": false}'::jsonb),
    (3::smallint, '{"schema_version": 1, "block_keywords": [],
      "reject_roleplay_archetypes": true, "reject_authority_claims": true,
      "reject_instruction_override": true, "reject_delimiter_tokens": true,
      "reject_encoded_payloads": false, "reject_tool_invocation_language": false,
      "reject_deferred_instructions": false, "reject_mixed_script_obfuscation": false,
      "reject_hypothetical_framing": false}'::jsonb),
    (4::smallint, '{"schema_version": 1, "block_keywords": [],
      "reject_roleplay_archetypes": true, "reject_authority_claims": true,
      "reject_instruction_override": true, "reject_delimiter_tokens": true,
      "reject_encoded_payloads": true, "reject_tool_invocation_language": true,
      "reject_deferred_instructions": true, "reject_mixed_script_obfuscation": false,
      "reject_hypothetical_framing": false}'::jsonb),
    (5::smallint, '{"schema_version": 1, "block_keywords": [],
      "reject_roleplay_archetypes": true, "reject_authority_claims": true,
      "reject_instruction_override": true, "reject_delimiter_tokens": true,
      "reject_encoded_payloads": true, "reject_tool_invocation_language": true,
      "reject_deferred_instructions": true, "reject_mixed_script_obfuscation": true,
      "reject_hypothetical_framing": true}'::jsonb)
) as s (level_id, rules)
on conflict do nothing;

-- ===========================================================================
-- 9. Self-check: fail loudly if a privilege is not as intended
-- ===========================================================================
-- REVOKE only warns when the current role is not the grantor, so the end
-- state is verified here as well as in supabase/tests/00002_rule_sets.test.sql.
do $$
declare
  v_privileges text[] := array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  v_problem text;
begin
  if current_setting('server_version_num')::integer >= 170000 then
    v_privileges := array_append(v_privileges, 'MAINTAIN');
  end if;

  -- anon and authenticated: SELECT on levels and nothing else.
  select string_agg(format('%s:%s.%s', r.role_name, t.table_name, p.privilege), ', ')
    into v_problem
  from (values ('anon'), ('authenticated')) as r (role_name)
  cross join (values
    ('public.levels'), ('public.rule_sets'), ('public.rule_gate_runs'),
    ('public.golden_prompts'), ('public.level_secrets')
  ) as t (table_name)
  cross join unnest(v_privileges) as p (privilege)
  where has_table_privilege(r.role_name, t.table_name, p.privilege)
    and not (t.table_name = 'public.levels' and p.privilege = 'SELECT');

  if v_problem is not null then
    raise exception '00002: anon or authenticated hold unintended table privileges: %', v_problem;
  end if;

  -- service_role: explicit DML on every table (PR #3 review, H1).
  select string_agg(format('%s.%s', t.table_name, p.privilege), ', ')
    into v_problem
  from (values
    ('public.levels'), ('public.rule_sets'), ('public.rule_gate_runs'),
    ('public.golden_prompts'), ('public.level_secrets')
  ) as t (table_name)
  cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p (privilege)
  where not has_table_privilege('service_role', t.table_name, p.privilege);

  if v_problem is not null then
    raise exception '00002: service_role lacks its explicit table grants: %', v_problem;
  end if;

  if has_function_privilege('anon', 'public.rule_set_payload_ok(jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.rule_set_payload_ok(jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.level_secret_payload_ok(jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.level_secret_payload_ok(jsonb)', 'EXECUTE') then
    raise exception '00002: a payload check is executable by anon or authenticated';
  end if;

  if (select count(*) from public.rule_sets where version = 0 and source = 'seed' and level_id between 1 and 5) <> 5 then
    raise exception '00002: expected one version-0 seed rule set per level';
  end if;
end
$$;
