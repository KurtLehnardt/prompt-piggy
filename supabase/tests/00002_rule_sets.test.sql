-- pgTAP tests for supabase/migrations/00002_rule_sets.sql (task PP-07).
--
-- Run with `pnpm db:test` against the local stack after `pnpm db:reset`,
-- which also applies supabase/seed.sql: the level_secrets tests expect the
-- level 4 and 5 placeholders that the seed file loads. Everything runs in one
-- transaction that is rolled back, so nothing here persists.
--
-- Every payload in this file is synthetic test data. No real level 4 or 5
-- value appears here (conventions.level_secrets, R2-12).
--
-- The tests stay valid as later migrations land: 00004 adds foreign keys on
-- rule_sets.source_attempt_id and golden_prompts.attempt_id, so every row
-- inserted here leaves those columns null.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(153);

-- ---------------------------------------------------------------------------
-- Helpers
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

-- n distinct valid keywords of the given length (at least 9): "kw" plus a
-- three-digit number, a space, and letters.
create function pg_temp.keywords(p_count integer, p_length integer default 20)
returns text[]
language sql
immutable
as $$
  select coalesce(array_agg('kw' || lpad(i::text, 3, '0') || ' ' || repeat('x', p_length - 6) order by i), '{}')
  from generate_series(1, p_count) as i;
$$;

-- A valid, obviously synthetic level-secret payload.
create function pg_temp.secret()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'schema_version', 1,
    'placeholder', true,
    'policy', 'Synthetic pgTAP policy text that grants nothing.',
    'fragments', jsonb_build_array('Synthetic pgTAP fragment one.', 'Synthetic pgTAP fragment two.'),
    'tripwire_threshold', 0.9,
    'decisions_predicate_instructions', 'Synthetic pgTAP predicate text, long enough to pass the forty-character minimum.',
    'extra_detector_phrases', jsonb_build_object('roleplay', jsonb_build_array('synthetic roleplay phrase'))
  );
$$;

-- pg_temp functions are created by postgres, and 00001 revoked the default
-- EXECUTE for functions that postgres creates, so the roles used below need
-- an explicit grant.
grant execute on function pg_temp.rules(text[], text[]) to service_role;
grant execute on function pg_temp.secret() to service_role;

-- ---------------------------------------------------------------------------
-- rule_set_payload_ok accepts valid rule sets (HC1, HC-A1): 8 tests
-- ---------------------------------------------------------------------------
select is(public.rule_set_payload_ok(pg_temp.rules()), true, 'accepts a rule set with every flag false and no keywords');
select is(
  public.rule_set_payload_ok(pg_temp.rules(array['reject_roleplay_archetypes'], array['root user override', 'grandma vault ritual'])),
  true, 'accepts the HC1 example shape: flags plus sanitized keywords'
);
select is(public.rule_set_payload_ok(pg_temp.rules('{}', array['abcd efg'])), true, 'accepts an 8-character keyword');
select is(public.rule_set_payload_ok(pg_temp.rules('{}', array[repeat('a', 24) || ' ' || repeat('b', 24)])), false, 'rejects a 49-character keyword');
select is(public.rule_set_payload_ok(pg_temp.rules('{}', array[repeat('a', 23) || ' ' || repeat('b', 24)])), true, 'accepts a 48-character keyword');
select is(public.rule_set_payload_ok(pg_temp.rules('{}', array['grandma''s vault', 'root-user override', 'one two three four'])), true, 'accepts apostrophes, hyphens, and four tokens');
select is(public.rule_set_payload_ok(pg_temp.rules('{}', pg_temp.keywords(32, 48))), true, 'accepts 32 keywords of 48 characters');
select is(
  public.rule_set_payload_ok('{"schema_version": 1.0, "block_keywords": [], "reject_roleplay_archetypes": false, "reject_authority_claims": false, "reject_instruction_override": false, "reject_delimiter_tokens": false, "reject_encoded_payloads": false, "reject_tool_invocation_language": false, "reject_deferred_instructions": false, "reject_mixed_script_obfuscation": false, "reject_hypothetical_framing": false}'),
  true, 'accepts schema_version written as 1.0, as JSON.parse does'
);

-- ---------------------------------------------------------------------------
-- rule_set_payload_ok rejects everything else (HC1, HC-A1): 29 tests
-- ---------------------------------------------------------------------------
-- Keys and types.
select is(public.rule_set_payload_ok(pg_temp.rules() || '{"allow_keywords": []}'), false, 'rejects an unknown key (allow_keywords)');
select is(public.rule_set_payload_ok(pg_temp.rules() || '{"system_prompt_append": "x"}'), false, 'rejects a free-text key (system_prompt_append)');
select is(public.rule_set_payload_ok(pg_temp.rules() || '{"strict_transfer_policy": true}'), false, 'rejects the removed key strict_transfer_policy');
select is(public.rule_set_payload_ok(pg_temp.rules() - 'reject_hypothetical_framing'), false, 'rejects a missing flag');
select is(public.rule_set_payload_ok(pg_temp.rules() - 'block_keywords'), false, 'rejects a missing block_keywords');
select is(public.rule_set_payload_ok(pg_temp.rules() || '{"reject_authority_claims": "true"}'), false, 'rejects a non-boolean flag (the string "true")');
select is(public.rule_set_payload_ok(pg_temp.rules() || '{"reject_authority_claims": 1}'), false, 'rejects a non-boolean flag (the number 1)');
select is(public.rule_set_payload_ok(pg_temp.rules() || '{"reject_authority_claims": null}'), false, 'rejects a null flag');
select is(public.rule_set_payload_ok(pg_temp.rules() || '{"reject_authority_claims": {"on": true}}'), false, 'rejects a nested object as a flag');
select is(public.rule_set_payload_ok(pg_temp.rules() || '{"schema_version": 2}'), false, 'rejects schema_version 2');
select is(public.rule_set_payload_ok(pg_temp.rules() || '{"schema_version": "1"}'), false, 'rejects schema_version as a string');
select is(public.rule_set_payload_ok(pg_temp.rules() || '{"block_keywords": "root user override"}'), false, 'rejects block_keywords that is not an array');
select is(public.rule_set_payload_ok(pg_temp.rules() || '{"block_keywords": [12345678]}'), false, 'rejects a keyword that is not a string');
select is(public.rule_set_payload_ok('[]'), false, 'rejects a JSON array');
select is(public.rule_set_payload_ok('"rules"'), false, 'rejects a JSON string');
select is(public.rule_set_payload_ok(null), false, 'returns false, not null, for SQL null');

-- Keyword caps.
select is(public.rule_set_payload_ok(pg_temp.rules('{}', array['abc def'])), false, 'rejects a 7-character keyword');
select is(public.rule_set_payload_ok(pg_temp.rules('{}', array['administrator'])), false, 'rejects a single-token keyword');
select is(public.rule_set_payload_ok(pg_temp.rules('{}', array['one two three four five'])), false, 'rejects a 5-token keyword');
select is(public.rule_set_payload_ok(pg_temp.rules('{}', array['Root User Override'])), false, 'rejects an uppercase keyword');
select is(public.rule_set_payload_ok(pg_temp.rules('{}', array['root  user override'])), false, 'rejects a double space');
select is(public.rule_set_payload_ok(pg_temp.rules('{}', array[' root user override'])), false, 'rejects a leading space');
select is(public.rule_set_payload_ok(pg_temp.rules('{}', array['root user override '])), false, 'rejects a trailing space');
select is(public.rule_set_payload_ok(pg_temp.rules('{}', array['café override'])), false, 'rejects a non-ASCII keyword');
select is(public.rule_set_payload_ok(pg_temp.rules('{}', array['root_user override'])), false, 'rejects punctuation other than space, apostrophe, or hyphen');
select is(public.rule_set_payload_ok(pg_temp.rules('{}', pg_temp.keywords(33))), false, 'rejects 33 keywords');
select is(public.rule_set_payload_ok(pg_temp.rules('{}', array['root user override', 'root user override'])), false, 'rejects a duplicate keyword');
select is(
  public.rule_set_payload_ok(pg_temp.rules() || jsonb_build_object('block_keywords', to_jsonb(pg_temp.keywords(32, 48))) || jsonb_build_object('padding', repeat('x', 3000))),
  false, 'rejects a payload over 4096 bytes'
);
select ok(
  octet_length((pg_temp.rules() || jsonb_build_object('block_keywords', to_jsonb(pg_temp.keywords(32, 48))) || jsonb_build_object('padding', repeat('x', 3000)))::text) > 4096,
  'the oversized payload above is over 4096 bytes'
);

-- ---------------------------------------------------------------------------
-- Version-0 seeds (section 6.2): 9 tests
-- ---------------------------------------------------------------------------
select is(public.rule_set_payload_ok(pg_temp.rules()), true, 'accepts the level 1 version-0 payload (every flag false)');
select is(public.rule_set_payload_ok(pg_temp.rules(array['reject_roleplay_archetypes'])), true, 'accepts the level 2 version-0 payload');
select is(
  public.rule_set_payload_ok(pg_temp.rules(array['reject_roleplay_archetypes', 'reject_authority_claims', 'reject_instruction_override', 'reject_delimiter_tokens'])),
  true, 'accepts the level 3 version-0 payload'
);
select is(
  public.rule_set_payload_ok(pg_temp.rules(array['reject_roleplay_archetypes', 'reject_authority_claims', 'reject_instruction_override', 'reject_delimiter_tokens',
                                                 'reject_encoded_payloads', 'reject_tool_invocation_language', 'reject_deferred_instructions'])),
  true, 'accepts the level 4 version-0 payload'
);
select is(
  public.rule_set_payload_ok(pg_temp.rules(array['reject_roleplay_archetypes', 'reject_authority_claims', 'reject_instruction_override', 'reject_delimiter_tokens',
                                                 'reject_encoded_payloads', 'reject_tool_invocation_language', 'reject_deferred_instructions',
                                                 'reject_mixed_script_obfuscation', 'reject_hypothetical_framing'])),
  true, 'accepts the level 5 version-0 payload (every flag true)'
);

select results_eq(
  $$
    select level_id, version, state::text, source, parent_id is null, rules, review_status::text, activated_at is not null
    from public.rule_sets
    where version = 0
    order by level_id
  $$,
  $$
    values
      (1::smallint, 0, 'active', 'seed', true, pg_temp.rules(), 'none', true),
      (2::smallint, 0, 'active', 'seed', true, pg_temp.rules(array['reject_roleplay_archetypes']), 'none', true),
      (3::smallint, 0, 'active', 'seed', true,
       pg_temp.rules(array['reject_roleplay_archetypes', 'reject_authority_claims', 'reject_instruction_override', 'reject_delimiter_tokens']), 'none', true),
      (4::smallint, 0, 'active', 'seed', true,
       pg_temp.rules(array['reject_roleplay_archetypes', 'reject_authority_claims', 'reject_instruction_override', 'reject_delimiter_tokens',
                           'reject_encoded_payloads', 'reject_tool_invocation_language', 'reject_deferred_instructions']), 'none', true),
      (5::smallint, 0, 'active', 'seed', true,
       pg_temp.rules(array['reject_roleplay_archetypes', 'reject_authority_claims', 'reject_instruction_override', 'reject_delimiter_tokens',
                           'reject_encoded_payloads', 'reject_tool_invocation_language', 'reject_deferred_instructions',
                           'reject_mixed_script_obfuscation', 'reject_hypothetical_framing']), 'none', true)
  $$,
  'five active version-0 seed rows carry the flags of section 6.2 and no keywords'
);
select is(
  (select count(*)::integer from public.rule_sets where source = 'seed'),
  5, 'exactly five seed rows exist, one per level'
);
select is(
  (select count(*)::integer from public.rule_sets where version = 0 and rules_sha256 = private.rule_set_sha256(rules)),
  5, 'every seed row stores the hash of its rules'
);
select is(
  (select count(*)::integer from public.rule_sets r join public.levels l on l.id = r.level_id where r.version = 0),
  5, 'every seed row references an existing level'
);

-- ---------------------------------------------------------------------------
-- Canonical rule-set hash: 6 tests
-- ---------------------------------------------------------------------------
-- The same two hex values are pinned in src/lib/db/level-secrets-seed-sync.test.ts,
-- computed there with Node's JSON.stringify over sorted keys and sorted
-- keywords, so the SQL and TypeScript canonical forms cannot drift apart.
select is(
  private.rule_set_sha256(pg_temp.rules()),
  '7956bfa522d3750ab535213cf6abbcb4df68c26a51d092a55fa2297f2055d6d2',
  'the hash of the all-false rule set matches the canonical JSON hash computed in Node'
);
select is(
  private.rule_set_sha256(pg_temp.rules(array['reject_roleplay_archetypes', 'reject_authority_claims'], array['root user override', 'grandma vault ritual'])),
  '4bd98daff10190ee9c1f639a073b675a594ccf904a5fc94a7ec44de8caefe110',
  'the hash of a rule set with keywords matches the canonical JSON hash computed in Node'
);
select is(
  private.rule_set_sha256(pg_temp.rules(array['reject_roleplay_archetypes', 'reject_authority_claims'], array['grandma vault ritual', 'root user override'])),
  '4bd98daff10190ee9c1f639a073b675a594ccf904a5fc94a7ec44de8caefe110',
  'keyword order does not change the hash'
);
select is(
  encode(extensions.digest('{"block_keywords":[],"reject_authority_claims":false,"reject_deferred_instructions":false,"reject_delimiter_tokens":false,"reject_encoded_payloads":false,"reject_hypothetical_framing":false,"reject_instruction_override":false,"reject_mixed_script_obfuscation":false,"reject_roleplay_archetypes":false,"reject_tool_invocation_language":false,"schema_version":1}', 'sha256'), 'hex'),
  private.rule_set_sha256(pg_temp.rules()),
  'the hash is the sha256 of compact JSON with sorted keys'
);
select is(private.rule_set_sha256(pg_temp.rules() || '{"schema_version": 2}'), null, 'the hash of an invalid rule set is null');
select is(
  private.rule_set_sha256(pg_temp.rules() || '{"schema_version": 1.0}'),
  '7956bfa522d3750ab535213cf6abbcb4df68c26a51d092a55fa2297f2055d6d2',
  'schema_version 1.0 hashes like 1, as JSON.parse and JSON.stringify make it'
);

-- ---------------------------------------------------------------------------
-- levels: 9 tests
-- ---------------------------------------------------------------------------
select columns_are('public', 'levels', array['id', 'slug', 'name', 'is_active'], 'levels has exactly id, slug, name, and is_active');
select is_empty(
  $$
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'levels'
      and column_name ~ '(fee|payout|price|cents|pot|treasury)'
  $$,
  'levels has no fee or payout column (CH-1)'
);
select results_eq(
  $$ select id, slug, name, is_active from public.levels order by id $$,
  $$ values (1::smallint, 'piglet', 'Piglet', true), (2::smallint, 'porker', 'Porker', true), (3::smallint, 'hog', 'Hog', true),
            (4::smallint, 'boar', 'Boar', true), (5::smallint, 'iron-pig', 'Iron Pig', true) $$,
  'levels holds the five levels'
);
select throws_ok(
  $$ insert into public.levels (id, slug, name) values (6, 'extra', 'Extra') $$,
  '23514', null, 'levels accepts ids 1 to 5 only'
);
select ok((select c.relrowsecurity from pg_class c where c.oid = 'public.levels'::regclass), 'RLS is enabled on levels');
select is(pg_temp.held_table_privileges('anon', 'public.levels'), array['SELECT'], 'anon holds SELECT on levels and nothing else');
select is(pg_temp.held_table_privileges('authenticated', 'public.levels'), array['SELECT'], 'authenticated holds SELECT on levels and nothing else');
select results_eq(
  $$ select polname::text collate "default", polcmd::text collate "default", polpermissive,
            (select array_agg(rolname::text collate "default" order by rolname) from pg_roles where oid = any(polroles))
     from pg_policy where polrelid = 'public.levels'::regclass $$,
  $$ values ('levels: public read', 'r', true, array['anon', 'authenticated']) $$,
  'levels has exactly one policy: a permissive SELECT for anon and authenticated'
);
select ok(
  pg_temp.held_table_privileges('service_role', 'public.levels') @> array['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  'service_role holds SELECT, INSERT, UPDATE, and DELETE on levels'
);

-- ---------------------------------------------------------------------------
-- Enums (R2-S3): 3 tests
-- ---------------------------------------------------------------------------
select enum_has_labels(
  'public', 'attack_technique',
  array['roleplay_persona', 'authority_impersonation', 'instruction_override', 'delimiter_injection',
        'encoded_smuggling', 'tool_or_mcp_takeover', 'deferred_trigger', 'emotional_social_engineering',
        'prompt_extraction', 'multilingual_obfuscation', 'unclassified', 'unknown'],
  'attack_technique has the 12 values of section 5.2, ending with unknown'
);
select enum_has_labels('public', 'rule_set_state', array['proposed', 'active', 'superseded', 'rejected', 'rolled_back'], 'rule_set_state has the five states of section 6.5');
select enum_has_labels('public', 'review_status', array['none', 'needs_review', 'dismissed', 'actioned'], 'review_status has the four review values');

-- ---------------------------------------------------------------------------
-- rule_sets constraints and indexes: 14 tests
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.rule_sets (level_id, state, rules, rules_sha256, source)
     values (1, 'proposed', pg_temp.rules() || '{"strict_transfer_policy": true}', repeat('0', 64), 'hardening') $$,
  '23514', null, 'inserting an invalid payload into rule_sets fails the CHECK'
);
select throws_ok(
  $$ insert into public.rule_sets (level_id, state, rules, rules_sha256, source)
     values (1, 'proposed', pg_temp.rules(array['reject_authority_claims']), repeat('0', 64), 'hardening') $$,
  '23514', null, 'a stored hash that is not the hash of the rules fails the CHECK'
);
select throws_ok(
  $$ insert into public.rule_sets (level_id, version, state, rules, rules_sha256, source)
     values (1, 7, 'active', pg_temp.rules(), private.rule_set_sha256(pg_temp.rules()), 'admin_reset') $$,
  '23505', null, 'the partial unique index allows only one active row per level'
);
select lives_ok(
  $$ insert into public.rule_sets (level_id, state, rules, rules_sha256, source)
     values (1, 'proposed', pg_temp.rules(array['reject_authority_claims']), private.rule_set_sha256(pg_temp.rules(array['reject_authority_claims'])), 'hardening') $$,
  'a proposed row may sit next to the active row of its level'
);
select throws_ok(
  $$ insert into public.rule_sets (level_id, state, rules, rules_sha256, source)
     values (1, 'superseded', pg_temp.rules(), private.rule_set_sha256(pg_temp.rules()), 'hardening') $$,
  '23514', null, 'a superseded row must have a version (rule_sets_version_once_live)'
);
select throws_ok(
  $$ insert into public.rule_sets (level_id, version, state, rules, rules_sha256, source)
     values (2, 0, 'superseded', pg_temp.rules(), private.rule_set_sha256(pg_temp.rules()), 'admin_reset') $$,
  '23514', null, 'only the seed may be version 0'
);
select throws_ok(
  $$ insert into public.rule_sets (level_id, state, rules, rules_sha256, source)
     values (1, 'proposed', pg_temp.rules(), private.rule_set_sha256(pg_temp.rules()), 'player') $$,
  '23514', null, 'an unknown source fails the CHECK'
);
select ok(
  (select i.indisunique and i.indpred is not null
   from pg_index i where i.indexrelid = 'public.rule_sets_one_active_per_level'::regclass),
  'rule_sets_one_active_per_level is a unique partial index'
);
select has_index('public', 'rule_sets', 'rule_sets_parent', array['parent_id'], 'R2-19: rule_sets.parent_id is indexed');
select has_index('public', 'rule_sets', 'rule_sets_source_attempt', array['source_attempt_id'], 'R2-19: rule_sets.source_attempt_id is indexed');
select has_index('public', 'golden_prompts', 'golden_prompts_attempt', array['attempt_id'], 'R2-19: golden_prompts.attempt_id is indexed');
select has_index('public', 'rule_gate_runs', 'rule_gate_runs_rule_set', array['rule_set_id'], 'rule_gate_runs.rule_set_id is indexed');
-- Every foreign-key column of these tables is the leading column of an index,
-- except references to the five-row levels table (section 5.1, R2-19).
select is_empty(
  $$
    select c.conrelid::regclass::text || '.' || a.attname
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.contype = 'f'
      and c.conrelid in ('public.rule_sets'::regclass, 'public.rule_gate_runs'::regclass,
                         'public.golden_prompts'::regclass, 'public.level_secrets'::regclass)
      and c.confrelid <> 'public.levels'::regclass
      and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = a.attnum)
  $$,
  'R2-19: every foreign-key column of the rule tables is indexed (levels references excepted)'
);
select is(
  (select count(*)::integer from pg_index i where i.indrelid = 'public.rule_sets'::regclass and i.indisunique and i.indpred is not null),
  2, 'rule_sets has two partial unique indexes: one active row per level, and unique versions per level'
);

-- ---------------------------------------------------------------------------
-- rule_gate_runs and golden_prompts constraints: 7 tests
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.rule_gate_runs (rule_set_id, passed, drop_codes)
     select id, false, array['made_up'] from public.rule_sets where level_id = 1 and version = 0 $$,
  '23514', null, 'rule_gate_runs rejects an unknown drop code'
);
select throws_ok(
  $$ insert into public.rule_gate_runs (rule_set_id, passed, failure_codes)
     select id, false, array['made_up'] from public.rule_sets where level_id = 1 and version = 0 $$,
  '23514', null, 'rule_gate_runs rejects an unknown failure code'
);
select throws_ok(
  $$ insert into public.rule_gate_runs (rule_set_id, passed, failure_codes)
     select id, true, array['benign_regression'] from public.rule_sets where level_id = 1 and version = 0 $$,
  '23514', null, 'a passing gate run cannot carry a failure code'
);
select lives_ok(
  $$ insert into public.rule_gate_runs (rule_set_id, passed, failure_codes, drop_codes, benign_total)
     select id, false, array['benign_regression'], array['hits_benign'], 150 from public.rule_sets where level_id = 1 and version = 0 $$,
  'a failing gate run with known codes is accepted'
);
select throws_ok(
  $$ insert into public.golden_prompts (kind, level_id, text, text_sha256, source)
     values ('breach', null, 'synthetic breach text', repeat('a', 64), 'breach_auto') $$,
  '23514', null, 'a breach golden prompt needs a level'
);
select throws_ok(
  $$ insert into public.golden_prompts (kind, level_id, text, text_sha256, source)
     values ('breach', 2, 'synthetic breach text', repeat('a', 64), 'admin_sql') $$,
  '23514', null, 'a breach golden prompt comes only from breach_auto'
);
select throws_ok(
  $$ insert into public.golden_prompts (kind, level_id, text, text_sha256, source) values
       ('benign', null, 'synthetic benign text', repeat('b', 64), 'admin_sql'),
       ('benign', null, 'synthetic benign text', repeat('b', 64), 'admin_sql') $$,
  '23505', null, 'golden prompts are deduplicated by kind, level, and hash'
);

-- ---------------------------------------------------------------------------
-- level_secret_payload_ok (R2-12): 30 tests
-- ---------------------------------------------------------------------------
select is(public.level_secret_payload_ok(pg_temp.secret()), true, 'accepts a synthetic payload');
select is(
  (select count(*)::integer from public.level_secrets where level_id in (4, 5) and public.level_secret_payload_ok(payload) and payload -> 'placeholder' = 'true'::jsonb),
  2, 'accepts the placeholder fixture rows that supabase/seed.sql loads for levels 4 and 5'
);
select is(public.level_secret_payload_ok(pg_temp.secret() || '{"tripwire_threshold": 0.5}'), true, 'accepts a threshold of 0.5');
select is(public.level_secret_payload_ok(pg_temp.secret() || '{"tripwire_threshold": 0.99}'), true, 'accepts a threshold of 0.99');
select is(public.level_secret_payload_ok(pg_temp.secret() || jsonb_build_object('fragments', (select jsonb_agg('f' || i) from generate_series(1, 8) i))), true, 'accepts 8 fragments');
select is(public.level_secret_payload_ok(pg_temp.secret() || jsonb_build_object('fragments', jsonb_build_array(repeat('f', 400)))), true, 'accepts a 400-character fragment');
select is(
  public.level_secret_payload_ok(pg_temp.secret() || jsonb_build_object('extra_detector_phrases',
    (select jsonb_object_agg(f, jsonb_build_array('synthetic phrase'))
     from unnest(array['roleplay', 'authority', 'override', 'delimiter', 'decode', 'tool', 'deferred', 'mixed_script', 'hypothetical']) as f))),
  true, 'accepts every one of the nine detector families of PP-04'
);
select is(public.level_secret_payload_ok(pg_temp.secret() || '{"extra_detector_phrases": {}}'), true, 'accepts no extra detector phrases');
select is(
  public.level_secret_payload_ok(pg_temp.secret() || jsonb_build_object('extra_detector_phrases', jsonb_build_object('tool', jsonb_build_array(repeat('a', 30) || ' ' || repeat('b', 33))))),
  true, 'accepts a 64-character detector phrase'
);

select is(public.level_secret_payload_ok(pg_temp.secret() || '{"unknown_key": true}'), false, 'rejects an unknown key');
select is(public.level_secret_payload_ok(pg_temp.secret() - 'policy'), false, 'rejects a missing key');
select is(public.level_secret_payload_ok(pg_temp.secret() || '{"schema_version": 2}'), false, 'rejects schema_version 2');
select is(public.level_secret_payload_ok(pg_temp.secret() || '{"placeholder": "true"}'), false, 'rejects a non-boolean placeholder');
select is(public.level_secret_payload_ok(pg_temp.secret() || '{"tripwire_threshold": 0.49}'), false, 'rejects a threshold below 0.5');
select is(public.level_secret_payload_ok(pg_temp.secret() || '{"tripwire_threshold": 0.991}'), false, 'rejects a threshold above 0.99');
select is(public.level_secret_payload_ok(pg_temp.secret() || '{"tripwire_threshold": 1}'), false, 'rejects a threshold of 1');
select is(public.level_secret_payload_ok(pg_temp.secret() || '{"tripwire_threshold": "0.9"}'), false, 'rejects a threshold that is not a number');
select is(public.level_secret_payload_ok(pg_temp.secret() || '{"fragments": []}'), false, 'rejects an empty fragment list');
select is(public.level_secret_payload_ok(pg_temp.secret() || jsonb_build_object('fragments', (select jsonb_agg('f' || i) from generate_series(1, 9) i))), false, 'rejects more than 8 fragments');
select is(public.level_secret_payload_ok(pg_temp.secret() || jsonb_build_object('fragments', jsonb_build_array(repeat('f', 401)))), false, 'rejects a fragment over 400 characters');
select is(public.level_secret_payload_ok(pg_temp.secret() || '{"fragments": "one fragment"}'), false, 'rejects fragments that is not an array');
select is(public.level_secret_payload_ok(pg_temp.secret() || '{"policy": ""}'), false, 'rejects an empty policy');
select is(public.level_secret_payload_ok(pg_temp.secret() || jsonb_build_object('policy', repeat('p', 601))), false, 'rejects a policy over 600 characters');
select is(public.level_secret_payload_ok(pg_temp.secret() || jsonb_build_object('decisions_predicate_instructions', repeat('d', 39))), false, 'rejects predicate instructions under 40 characters');
select is(public.level_secret_payload_ok(pg_temp.secret() || '{"extra_detector_phrases": {"roleplay": ["Synthetic Phrase"]}}'), false, 'rejects a detector phrase in uppercase');
select is(
  public.level_secret_payload_ok(pg_temp.secret() || jsonb_build_object('extra_detector_phrases', jsonb_build_object('tool', jsonb_build_array(repeat('a', 30) || ' ' || repeat('b', 34))))),
  false, 'rejects a detector phrase over 64 characters'
);
select is(public.level_secret_payload_ok(pg_temp.secret() || '{"extra_detector_phrases": {"jailbreak": ["synthetic phrase"]}}'), false, 'rejects an unknown detector family');
select is(
  public.level_secret_payload_ok(pg_temp.secret() || jsonb_build_object('extra_detector_phrases', jsonb_build_object('tool', (select jsonb_agg('phrase ' || i) from generate_series(1, 65) i)))),
  false, 'rejects more than 64 phrases in one family'
);
select is(public.level_secret_payload_ok(pg_temp.secret() || '{"extra_detector_phrases": {"tool": "synthetic phrase"}}'), false, 'rejects a family whose phrases are not an array');
select is(public.level_secret_payload_ok(pg_temp.secret() || jsonb_build_object('padding', repeat('x', 17000))), false, 'rejects a payload over 16384 bytes');

-- ---------------------------------------------------------------------------
-- level_secrets table (R2-12): 15 tests
-- ---------------------------------------------------------------------------
select ok((select c.relrowsecurity from pg_class c where c.oid = 'public.level_secrets'::regclass), 'RLS is enabled on level_secrets');
select is_empty($$ select polname from pg_policy where polrelid = 'public.level_secrets'::regclass $$, 'level_secrets has no policy');
select is(pg_temp.held_table_privileges('anon', 'public.level_secrets'), null::text[], 'anon holds no privilege on level_secrets');
select is(pg_temp.held_table_privileges('authenticated', 'public.level_secrets'), null::text[], 'authenticated holds no privilege on level_secrets');
select ok(
  not has_any_column_privilege('anon', 'public.level_secrets', 'SELECT')
    and not has_any_column_privilege('authenticated', 'public.level_secrets', 'SELECT'),
  'anon and authenticated hold no column privilege on level_secrets'
);
select is_empty(
  $$
    select distinct v.oid::regclass::text
    from pg_depend d
    join pg_rewrite r on r.oid = d.objid
    join pg_class v on v.oid = r.ev_class
    where d.classid = 'pg_rewrite'::regclass
      and d.refobjid = 'public.level_secrets'::regclass
      and v.oid <> 'public.level_secrets'::regclass
  $$,
  'no view or materialized view selects from level_secrets'
);
select is_empty(
  $$
    select p.oid::regprocedure::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname not in ('pg_catalog', 'information_schema')
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
      and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
      and p.prosrc ~* 'level_secret'
  $$,
  'no function that anon or authenticated may execute mentions level_secrets'
);
select is_empty(
  $$ select pubname from pg_publication_tables where schemaname = 'public' and tablename = 'level_secrets' $$,
  'level_secrets is in no publication, so Realtime never sends it'
);
select is_empty(
  $$
    select m.version
    from supabase_migrations.schema_migrations m, unnest(m.statements) as s
    where s ~* '(insert[[:space:]]+into|copy|merge[[:space:]]+into)[[:space:]]+(public[.])?level_secrets'
  $$,
  'no migration inserts a level_secrets row'
);
select ok(
  exists (
    select 1
    from supabase_migrations.schema_migrations m, unnest(m.statements) as s
    where m.version = '00002' and s ~* 'create[[:space:]]+table[[:space:]]+if[[:space:]]+not[[:space:]]+exists[[:space:]]+public[.]level_secrets'
  ),
  'the migration scan above reads the recorded statements (it sees 00002 create level_secrets)'
);
select throws_ok(
  $$ insert into public.level_secrets (level_id, payload, payload_sha256) values (3, pg_temp.secret(), repeat('c', 64)) $$,
  '23514', null, 'level_secrets accepts only levels 4 and 5 (level 3 refused)'
);
select throws_ok(
  $$ insert into public.level_secrets (level_id, payload, payload_sha256) values (1, pg_temp.secret(), repeat('c', 64)) $$,
  '23514', null, 'level_secrets refuses level 1'
);
select throws_ok(
  $$ update public.level_secrets set payload = pg_temp.secret() || '{"schema_version": 2}' where level_id = 4 $$,
  '23514', null, 'an invalid payload fails the level_secrets CHECK'
);
select throws_ok(
  $$ update public.level_secrets set payload_sha256 = 'not-a-hash' where level_id = 4 $$,
  '23514', null, 'payload_sha256 must be 64 lowercase hex characters'
);
select ok(
  pg_temp.held_table_privileges('service_role', 'public.level_secrets') @> array['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  'service_role holds SELECT, INSERT, UPDATE, and DELETE on level_secrets'
);

-- ---------------------------------------------------------------------------
-- Privileges on the rule tables and functions (R2-17, R2-12): 13 tests
-- ---------------------------------------------------------------------------
select is_empty(
  $$
    select r.role_name || ' ' || t.table_name
    from (values ('anon'), ('authenticated')) as r (role_name)
    cross join (values ('public.rule_sets'), ('public.rule_gate_runs'), ('public.golden_prompts'), ('public.level_secrets')) as t (table_name)
    where has_table_privilege(r.role_name, t.table_name, 'SELECT')
       or has_any_column_privilege(r.role_name, t.table_name, 'SELECT')
  $$,
  'anon and authenticated have no SELECT on rule_sets, rule_gate_runs, golden_prompts, or level_secrets'
);
select is(pg_temp.held_table_privileges('anon', 'public.rule_sets'), null::text[], 'anon holds no privilege on rule_sets');
select is(pg_temp.held_table_privileges('authenticated', 'public.rule_sets'), null::text[], 'authenticated holds no privilege on rule_sets');
select is(pg_temp.held_table_privileges('anon', 'public.rule_gate_runs'), null::text[], 'anon holds no privilege on rule_gate_runs');
select is(pg_temp.held_table_privileges('authenticated', 'public.rule_gate_runs'), null::text[], 'authenticated holds no privilege on rule_gate_runs');
select is(pg_temp.held_table_privileges('anon', 'public.golden_prompts'), null::text[], 'anon holds no privilege on golden_prompts');
select is(pg_temp.held_table_privileges('authenticated', 'public.golden_prompts'), null::text[], 'authenticated holds no privilege on golden_prompts');
select is(
  (select count(*)::integer from pg_class c
   where c.oid in ('public.rule_sets'::regclass, 'public.rule_gate_runs'::regclass, 'public.golden_prompts'::regclass) and c.relrowsecurity),
  3, 'RLS is enabled on rule_sets, rule_gate_runs, and golden_prompts'
);
select is_empty(
  $$ select polname from pg_policy where polrelid in ('public.rule_sets'::regclass, 'public.rule_gate_runs'::regclass, 'public.golden_prompts'::regclass) $$,
  'rule_sets, rule_gate_runs, and golden_prompts have no policy (section 5.3)'
);
select is(
  (select count(*)::integer
   from pg_proc p
   where p.oid in ('public.rule_set_payload_ok(jsonb)'::regprocedure,
                   'public.level_secret_payload_ok(jsonb)'::regprocedure,
                   'private.rule_set_sha256(jsonb)'::regprocedure)
     and p.proconfig @> array['search_path=""']
     and not p.prosecdef
     and p.provolatile = 'i'),
  3, 'R2-17: the three functions of 00002 set search_path to the empty string, are SECURITY INVOKER, and are immutable'
);
select is_empty(
  $$
    select r.role_name || ' ' || f.fn
    from (values ('anon'), ('authenticated')) as r (role_name)
    cross join (values ('public.rule_set_payload_ok(jsonb)'), ('public.level_secret_payload_ok(jsonb)'), ('private.rule_set_sha256(jsonb)')) as f (fn)
    where has_function_privilege(r.role_name, f.fn, 'EXECUTE')
  $$,
  'anon and authenticated cannot execute any function of 00002'
);
select ok(
  has_function_privilege('service_role', 'public.rule_set_payload_ok(jsonb)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.level_secret_payload_ok(jsonb)', 'EXECUTE')
    and has_function_privilege('service_role', 'private.rule_set_sha256(jsonb)', 'EXECUTE'),
  'service_role can execute the functions its writes go through'
);
select is_empty(
  $$ select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'S'
       and c.relname ~ '^(levels|rule_sets|rule_gate_runs|golden_prompts|level_secrets)' $$,
  'the rule tables own no sequence'
);

-- ---------------------------------------------------------------------------
-- Behaviour as each role: 10 tests
-- ---------------------------------------------------------------------------
set local role anon;
select is((select count(*)::integer from public.levels), 5, 'anon can select levels');
select throws_ok($$ select 1 from public.rule_sets limit 1 $$, '42501', null, 'anon cannot select rule_sets');
select throws_ok($$ select 1 from public.level_secrets limit 1 $$, '42501', null, 'anon cannot select level_secrets');
select throws_ok($$ insert into public.levels (id, slug, name) values (5, 'iron-pig', 'Iron Pig') $$, '42501', null, 'anon cannot write levels');
reset role;

set local role authenticated;
select is((select count(*)::integer from public.levels), 5, 'authenticated can select levels');
select throws_ok($$ select 1 from public.golden_prompts limit 1 $$, '42501', null, 'authenticated cannot select golden_prompts');
select throws_ok($$ select 1 from public.level_secrets limit 1 $$, '42501', null, 'authenticated cannot select level_secrets');
reset role;

set local role service_role;
select lives_ok(
  $$ update public.level_secrets set payload = pg_temp.secret(), payload_sha256 = repeat('d', 64) where level_id = 5 $$,
  'service_role writes level_secrets through level_secret_payload_ok'
);
select lives_ok(
  $$ insert into public.rule_sets (level_id, state, rules, rules_sha256, source)
     values (3, 'proposed', pg_temp.rules(array['reject_encoded_payloads']), private.rule_set_sha256(pg_temp.rules(array['reject_encoded_payloads'])), 'hardening') $$,
  'service_role writes rule_sets through rule_set_payload_ok and rule_set_sha256'
);
select throws_ok(
  $$ insert into public.rule_sets (level_id, state, rules, rules_sha256, source)
     values (3, 'proposed', pg_temp.rules() || '{"schema_version": 2}', repeat('0', 64), 'hardening') $$,
  '23514', null, 'an invalid payload fails the CHECK for service_role too'
);
reset role;

select * from finish();
rollback;
