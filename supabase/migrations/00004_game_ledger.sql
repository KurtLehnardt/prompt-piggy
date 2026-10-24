-- Migration 00004: the game and ledger schema (task PP-12)
--
-- Contents (docs/ARCHITECTURE.md sections 5.1 to 5.5, 9.2, 9.4, 9.5, 9.7, 11):
--   1. The enums public.attempt_outcome and public.crack_event.
--   2. Tables: game_state (the one shared pig and the global treasury),
--      wallets (per-player money, aura, and persistent cracks), attempts,
--      ledger_entries (the append-only journal), donations, live_feed,
--      blocked_fingerprints, ai_spend, rate_limits, hardening_jobs, and
--      admin_actions, with RLS, grants, and an index on every foreign key.
--   3. The foreign keys from rule_sets and golden_prompts (00002) back to
--      attempts.
--   4. private._post_ledger: the only function that changes balance_cents or
--      treasury_cents (CH-1).
--   5. The sign-up path: private._sanitize_display_name,
--      private._sanitize_avatar_url, and the trigger private.handle_new_user,
--      which takes the one-time Google snapshot (R2-06), skips anonymous
--      users (R2-16), and grants the starting balance once (CH-1).
--   6. Triggers: the append-only ledger and the rule-set activation feed.
--   7. Read functions: get_level_status and get_public_config (anon and
--      authenticated), and the wall functions get_live_players and
--      presence_ping (service_role only, R2-07, R2-S1, R3-02).
--   8. The game_state seed.
--   9. The realtime publication of exactly game_state and live_feed (5.5).
--  10. A self-check that fails the migration if a privilege is not as intended.
--
-- Access model (section 5.3). There are no INSERT, UPDATE, or DELETE policies
-- and no write privilege for anon or authenticated anywhere. anon may SELECT
-- game_state and live_feed. authenticated may SELECT game_state, live_feed,
-- and its own rows of wallets, attempts (a column grant that hides rule-set
-- ids, fingerprints, validator internals, tripwire scores, and costs),
-- ledger_entries, and donations. blocked_fingerprints, ai_spend, rate_limits,
-- hardening_jobs, and admin_actions have RLS enabled and no policy, so only
-- the service role reaches them (the CI advisor gate allowlists exactly
-- these for rls_enabled_no_policy). Every table grants its DML to
-- service_role explicitly, and every identity sequence grants USAGE and
-- SELECT to service_role explicitly (PR #3 review, H1): 00001 revoked every
-- default privilege, and Supabase revokes the platform defaults on
-- 2026-10-30.
--
-- Money is mocked US dollars in bigint integer cents (CH-1). Amounts come
-- from app_config and from rows, never from a request.
--
-- Every function sets search_path = '' and schema-qualifies every table,
-- type, and function it uses; only pg_catalog built-ins stay unqualified
-- (R2-17). Internal helpers and trigger functions live in schema private.
-- Only private.handle_new_user, get_level_status, and get_public_config are
-- SECURITY DEFINER (section 5.4); everything else is SECURITY INVOKER.
--
-- Errors use the PTnnn SQLSTATE convention, and the message starts with a
-- token that src/lib/errors.ts recognizes:
--   PT402 insufficient_funds   a player debit exceeds the balance
--                              (hint {"balanceCents": n, "priceCents": n})
--   PT403 forbidden            UPDATE, DELETE, or TRUNCATE on ledger_entries;
--                              presence_ping for a user without a wallet
--   PT422 invariant_violation  a missing or inconsistent argument
--
-- Lock order (section 5.1): rows are locked as profiles (1), wallets (3),
-- game_state (4). _post_ledger always applies the wallet side of a movement
-- before the treasury side, and its callers already hold both locks.
--
-- Re-runnable: if not exists, create or replace, guarded type, constraint,
-- trigger, and publication changes, and on conflict do nothing, so applying
-- this file twice changes nothing.

-- ===========================================================================
-- 1. Enums
-- ===========================================================================
do $$
begin
  -- pending exists only inside the database, until record_attempt or the
  -- error path finalizes the attempt.
  if to_regtype('public.attempt_outcome') is null then
    create type public.attempt_outcome as enum (
      'pending', 'win', 'late_win', 'fail', 'blocked', 'leak_blocked', 'error'
    );
  end if;

  if to_regtype('public.crack_event') is null then
    create type public.crack_event as enum ('none', 'crack', 'shatter', 'repaired');
  end if;
end
$$;

-- ===========================================================================
-- 2. Tables
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- game_state: the singleton pig and the global treasury (public by design)
-- ---------------------------------------------------------------------------
-- It holds no per-user column, so it is safe in the realtime publication
-- (T15). Writers: start_attempt, record_attempt, repair_glass,
-- reap_stale_attempts, and reset_game; the treasury moves only through
-- private._post_ledger.
create table if not exists public.game_state (
  id                   smallint primary key default 1,
  current_level        smallint not null default 1 references public.levels (id),
  pig_epoch            bigint   not null default 1,   -- +1 on every paid win and game reset
  treasury_cents       bigint   not null default 0,
  total_attempts       bigint   not null default 0,
  total_wins           bigint   not null default 0,
  total_paid_out_cents bigint   not null default 0,
  updated_at           timestamptz not null default now(),
  constraint game_state_singleton          check (id = 1),
  constraint game_state_pig_epoch_positive check (pig_epoch >= 1),
  constraint game_state_treasury_nonneg    check (treasury_cents >= 0),
  constraint game_state_totals_nonneg      check (total_attempts >= 0 and total_wins >= 0 and total_paid_out_cents >= 0)
);

comment on table public.game_state is
  'The one shared pig and the global treasury (integer cents). A singleton '
  '(id = 1). Public by design and in the realtime publication: no per-user '
  'column. Readable by anon and authenticated; written only by service-role '
  'RPCs, and the treasury only through private._post_ledger.';

create or replace trigger game_state_updated_at
  before update on public.game_state
  for each row execute function private.handle_updated_at();

alter table public.game_state enable row level security;

drop policy if exists "game_state: public read" on public.game_state;
create policy "game_state: public read" on public.game_state
  for select
  to anon, authenticated
  using (true);

revoke all on table public.game_state from public, anon, authenticated;
grant select on table public.game_state to anon, authenticated;
grant select, insert, update, delete on table public.game_state to service_role;

-- ---------------------------------------------------------------------------
-- wallets: private per-user money, aura, and crack state
-- ---------------------------------------------------------------------------
-- aura_bps is a generated column, so the server computes it and no client
-- value is ever accepted (CH-2): aura = donated / (donated + balance), floor
-- division into basis points, 0 when both are 0. crack_count persists across
-- sessions and devices and only record_attempt and repair_glass change it
-- (CH-1, HC-A5). in_flight_attempt_id has no foreign key on purpose: it is a
-- marker that start_attempt and the finalizers set and clear under the
-- wallet lock, and attempts already references wallets' owner.
create table if not exists public.wallets (
  user_id              uuid primary key references public.profiles (id) on delete cascade,
  balance_cents        bigint   not null default 0,
  total_donated_cents  bigint   not null default 0,
  aura_bps             integer  generated always as (
                         case when total_donated_cents + balance_cents = 0 then 0
                              else (total_donated_cents * 10000 / (total_donated_cents + balance_cents))::integer
                         end) stored,
  crack_count          smallint not null default 0,
  total_attempts       integer  not null default 0,
  total_wins           integer  not null default 0,
  in_flight_attempt_id uuid,
  last_seen_at         timestamptz,   -- set only by presence_ping and start_attempt (section 9.7)
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint wallets_balance_nonneg      check (balance_cents >= 0),
  constraint wallets_donated_nonneg      check (total_donated_cents >= 0),
  constraint wallets_crack_count_range   check (crack_count between 0 and 3),
  constraint wallets_totals_nonneg       check (total_attempts >= 0 and total_wins >= 0)
);

comment on table public.wallets is
  'Per-player mocked money (integer cents), donation total, server-computed '
  'aura, and persistent crack count (0 to 3). Owners read their own row; '
  'anon and authenticated hold no write privilege. Balances move only '
  'through private._post_ledger.';

create index if not exists wallets_last_seen on public.wallets (last_seen_at desc) where last_seen_at is not null;

create or replace trigger wallets_updated_at
  before update on public.wallets
  for each row execute function private.handle_updated_at();

alter table public.wallets enable row level security;

drop policy if exists "wallets: owner reads own row" on public.wallets;
create policy "wallets: owner reads own row" on public.wallets
  for select
  to authenticated
  using (user_id = (select auth.uid()));

revoke all on table public.wallets from public, anon, authenticated;
grant select on table public.wallets to authenticated;
grant select, insert, update, delete on table public.wallets to service_role;

-- ---------------------------------------------------------------------------
-- attempts: one row per paid attempt
-- ---------------------------------------------------------------------------
-- Owners read their own rows through a column grant, which hides rule_set_id,
-- the prompt hashes and fingerprint, validator reasons and signals, the
-- tripwire probability, canary and tool flags, the error code, and spend.
create table if not exists public.attempts (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles (id) on delete cascade,
  level_id             smallint not null references public.levels (id),
  pig_epoch            bigint   not null,                     -- pinned at start
  rule_set_id          uuid not null references public.rule_sets (id),
  idempotency_key      uuid not null,
  prompt               text,                                  -- null after the retention purge
  prompt_sha256        text not null,
  prompt_fingerprint   text not null,
  prompt_chars         integer not null,
  reply                text,
  outcome              public.attempt_outcome not null default 'pending',
  error_code           text,                                  -- required for error, optional for fail (R2-01)
  validator_reasons    text[] not null default '{}',          -- reason codes only, never matched text
  validator_signals    text[] not null default '{}',
  tripwire_probability real,
  technique            public.attack_technique,
  canary_leaked        boolean not null default false,
  tool_called          boolean not null default false,
  price_cents          bigint not null,
  payout_cents         bigint not null default 0,
  refund_cents         bigint not null default 0,
  refund_withheld      boolean not null default false,        -- a system error over the refund budget (R2-01)
  crack_event          public.crack_event,
  cracks_after         smallint,
  reserved_micros      bigint not null default 0,
  cost_micros          bigint not null default 0,
  spend_day            date   not null,                       -- R1-18: settle against the reservation's day
  created_at           timestamptz not null default now(),
  finalized_at         timestamptz,
  constraint attempts_user_idempotency_key unique (user_id, idempotency_key),
  constraint attempts_prompt_length        check (prompt is null or char_length(prompt) between 1 and 4000),
  constraint attempts_prompt_sha256_hex    check (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  constraint attempts_fingerprint_hex      check (prompt_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint attempts_prompt_chars_range   check (prompt_chars between 1 and 4000),
  constraint attempts_reply_length         check (reply is null or char_length(reply) <= 1200),
  constraint attempts_error_code_format    check (error_code is null or error_code ~ '^[a-z_]{3,40}$'),
  -- error needs a detail code, fail may carry one, every other outcome has none.
  constraint attempts_error_code_outcome   check (
    case outcome
      when 'error'::public.attempt_outcome then error_code is not null
      when 'fail'::public.attempt_outcome  then true
      else error_code is null
    end),
  constraint attempts_finalized_iff_final  check ((outcome = 'pending'::public.attempt_outcome) = (finalized_at is null)),
  constraint attempts_tripwire_range       check (tripwire_probability is null or tripwire_probability between 0 and 1),
  constraint attempts_price_positive       check (price_cents > 0),
  constraint attempts_payout_nonneg        check (payout_cents >= 0),
  constraint attempts_refund_nonneg        check (refund_cents >= 0),
  constraint attempts_cracks_after_range   check (cracks_after is null or cracks_after between 0 and 3),
  constraint attempts_reserved_nonneg      check (reserved_micros >= 0),
  constraint attempts_cost_nonneg          check (cost_micros >= 0),
  constraint attempts_pig_epoch_positive   check (pig_epoch >= 1)
);

comment on table public.attempts is
  'One row per paid attempt. Owners read their own rows through a column '
  'grant that hides rule-set ids, fingerprints, validator internals, tripwire '
  'scores, and costs. Written only by service-role RPCs.';

-- One payout per breach: a second paid win for an epoch fails loudly.
create unique index if not exists attempts_one_win_per_epoch on public.attempts (pig_epoch) where outcome = 'win';
-- The unique (user_id, idempotency_key) constraint also indexes the user_id foreign key.
create index if not exists attempts_user_created  on public.attempts (user_id, created_at desc);
create index if not exists attempts_pending       on public.attempts (created_at) where outcome = 'pending';
create index if not exists attempts_retention     on public.attempts (created_at) where prompt is not null;
create index if not exists attempts_traffic       on public.attempts (finalized_at desc)
  where outcome not in ('pending', 'win') and prompt is not null;
create index if not exists attempts_rule_set      on public.attempts (rule_set_id);                                   -- R2-19
create index if not exists attempts_user_refunds  on public.attempts (user_id, finalized_at desc) where refund_cents > 0;  -- R2-01

alter table public.attempts enable row level security;

drop policy if exists "attempts: owner reads own rows" on public.attempts;
create policy "attempts: owner reads own rows" on public.attempts
  for select
  to authenticated
  using (user_id = (select auth.uid()));

revoke all on table public.attempts from public, anon, authenticated;
grant select (
  id, level_id, outcome, technique, price_cents, payout_cents, refund_cents, refund_withheld,
  crack_event, cracks_after, prompt, reply, created_at, finalized_at
) on table public.attempts to authenticated;
grant select, insert, update, delete on table public.attempts to service_role;

-- ---------------------------------------------------------------------------
-- ledger_entries: the append-only journal of every money movement
-- ---------------------------------------------------------------------------
-- Accounts: player:<uuid>, treasury, mint (the source of grants, seeds, and
-- minted refunds), and cncf (the mock donation sink, which only receives).
-- user_id and attempt_id carry no foreign key, so the journal outlives
-- deleted rows (R2-19). external_ref is unique, which makes every grant,
-- fee, payout, and refund happen at most once.
create table if not exists public.ledger_entries (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  kind         text not null,
  from_account text not null,
  to_account   text not null,
  amount_cents bigint not null,
  user_id      uuid,
  attempt_id   uuid,
  external_ref text,
  constraint ledger_entries_external_ref_key unique (external_ref),
  constraint ledger_kind_valid check (kind in (
    'mint_starting', 'admin_grant', 'mint_treasury_seed', 'attempt_fee', 'attempt_refund',
    'refund_mint', 'payout', 'repair_fee', 'donation')),
  constraint ledger_from_account_format check (from_account ~ '^(treasury|mint|cncf|player:[0-9a-f-]{36})$'),
  constraint ledger_to_account_format   check (to_account   ~ '^(treasury|mint|cncf|player:[0-9a-f-]{36})$'),
  constraint ledger_amount_positive     check (amount_cents > 0),
  constraint ledger_external_ref_format check (external_ref is null or external_ref ~ '^[a-z0-9_:-]{8,100}$'),
  constraint ledger_accounts_differ     check (from_account <> to_account),
  constraint ledger_cncf_is_sink        check (from_account <> 'cncf')
);

comment on table public.ledger_entries is
  'Append-only journal of every mocked money movement (integer cents). '
  'UPDATE, DELETE, and TRUNCATE raise PT403 for every role. Rows come only '
  'from private._post_ledger. Owners read their own rows.';

create index if not exists ledger_entries_user    on public.ledger_entries (user_id, created_at desc);
create index if not exists ledger_entries_attempt on public.ledger_entries (attempt_id);

alter table public.ledger_entries enable row level security;

drop policy if exists "ledger_entries: owner reads own rows" on public.ledger_entries;
create policy "ledger_entries: owner reads own rows" on public.ledger_entries
  for select
  to authenticated
  using (user_id = (select auth.uid()));

revoke all on table public.ledger_entries from public, anon, authenticated;
revoke all on sequence public.ledger_entries_id_seq from public, anon, authenticated;
grant select on table public.ledger_entries to authenticated;
-- UPDATE and DELETE are granted so the generic H1 check holds; the
-- append-only trigger below refuses both for every role.
grant select, insert, update, delete on table public.ledger_entries to service_role;
grant usage, select on sequence public.ledger_entries_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- donations: mock CNCF donations (CH-2); the money moves in the ledger
-- ---------------------------------------------------------------------------
create table if not exists public.donations (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  amount_cents    bigint not null,
  idempotency_key uuid not null,
  created_at      timestamptz not null default now(),
  -- Also indexes the user_id foreign key.
  constraint donations_user_idempotency_key unique (user_id, idempotency_key),
  constraint donations_amount_positive check (amount_cents > 0)
);

comment on table public.donations is
  'Mock CNCF donations (CH-2): no real money moves. Owners read their own '
  'rows; written only by the donate RPC.';

alter table public.donations enable row level security;

drop policy if exists "donations: owner reads own rows" on public.donations;
create policy "donations: owner reads own rows" on public.donations
  for select
  to authenticated
  using (user_id = (select auth.uid()));

revoke all on table public.donations from public, anon, authenticated;
revoke all on sequence public.donations_id_seq from public, anon, authenticated;
grant select on table public.donations to authenticated;
grant select, insert, update, delete on table public.donations to service_role;
grant usage, select on sequence public.donations_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- live_feed: public event labels (in the realtime publication)
-- ---------------------------------------------------------------------------
-- No prompt, reply, name, email, balance, or free text (T15, CH-6).
-- player_id is a pseudonymous uuid; names and avatars come only from the
-- gated wall functions.
create table if not exists public.live_feed (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  event_type   text not null,
  level_id     smallint references public.levels (id),
  player_id    uuid references public.profiles (id) on delete set null,
  outcome      public.attempt_outcome,
  technique    public.attack_technique,
  amount_cents bigint,
  rule_version integer,
  constraint live_feed_event_type_valid check (event_type in
    ('attempt', 'level_advanced', 'hardened', 'rules_reset', 'game_reset')),
  constraint live_feed_outcome_final    check (outcome is null or outcome not in ('pending', 'error')),
  constraint live_feed_amount_nonneg    check (amount_cents is null or amount_cents >= 0),
  constraint live_feed_rule_version_nonneg check (rule_version is null or rule_version >= 0)
);

comment on table public.live_feed is
  'Public event labels for /live and the game page: enums and numbers only, '
  'no prompt, reply, name, or free text. Readable by anon and authenticated, '
  'in the realtime publication.';

create index if not exists live_feed_created on public.live_feed (created_at desc);
create index if not exists live_feed_player  on public.live_feed (player_id);   -- R2-19

alter table public.live_feed enable row level security;

drop policy if exists "live_feed: public read" on public.live_feed;
create policy "live_feed: public read" on public.live_feed
  for select
  to anon, authenticated
  using (true);

revoke all on table public.live_feed from public, anon, authenticated;
revoke all on sequence public.live_feed_id_seq from public, anon, authenticated;
grant select on table public.live_feed to anon, authenticated;
grant select, insert, update, delete on table public.live_feed to service_role;
grant usage, select on sequence public.live_feed_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- blocked_fingerprints: the exact-replay blocklist (paid wins only, CH-6b)
-- ---------------------------------------------------------------------------
-- attempt_id is nullable with on delete set null, so deleting a user keeps
-- their breach fingerprint blocked (R2-19).
create table if not exists public.blocked_fingerprints (
  fingerprint text primary key,
  level_id    smallint not null references public.levels (id),
  attempt_id  uuid references public.attempts (id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint blocked_fingerprints_hex check (fingerprint ~ '^[0-9a-f]{64}$')
);

comment on table public.blocked_fingerprints is
  'Exact-replay blocklist of paid-win prompt fingerprints (CH-6b). Service '
  'role only: RLS enabled, no policy, no grant to anon or authenticated.';

create index if not exists blocked_fingerprints_attempt on public.blocked_fingerprints (attempt_id);   -- R2-19

alter table public.blocked_fingerprints enable row level security;   -- no policy: service role only

revoke all on table public.blocked_fingerprints from public, anon, authenticated;
grant select, insert, update, delete on table public.blocked_fingerprints to service_role;

-- ---------------------------------------------------------------------------
-- ai_spend: the daily OpenAI spend reservations and settlements (micros)
-- ---------------------------------------------------------------------------
create table if not exists public.ai_spend (
  day                       date primary key,
  attempt_reserved_micros   bigint  not null default 0,
  attempt_settled_micros    bigint  not null default 0,
  hardening_reserved_micros bigint  not null default 0,
  hardening_settled_micros  bigint  not null default 0,
  attempt_calls             integer not null default 0,
  hardening_calls           integer not null default 0,
  updated_at                timestamptz not null default now(),
  constraint ai_spend_attempt_reserved_nonneg   check (attempt_reserved_micros >= 0),
  constraint ai_spend_attempt_settled_nonneg    check (attempt_settled_micros >= 0),
  constraint ai_spend_hardening_reserved_nonneg check (hardening_reserved_micros >= 0),
  constraint ai_spend_hardening_settled_nonneg  check (hardening_settled_micros >= 0),
  constraint ai_spend_calls_nonneg              check (attempt_calls >= 0 and hardening_calls >= 0)
);

comment on table public.ai_spend is
  'Daily AI spend in micro-dollars, reserved and settled by the attempt and '
  'hardening RPCs. Service role only: RLS enabled, no policy, no grant to '
  'anon or authenticated.';

alter table public.ai_spend enable row level security;   -- no policy: service role only

revoke all on table public.ai_spend from public, anon, authenticated;
grant select, insert, update, delete on table public.ai_spend to service_role;

-- ---------------------------------------------------------------------------
-- rate_limits: per-player token buckets and daily counts
-- ---------------------------------------------------------------------------
-- updated_at is the bucket's last refill time, set by the RPCs themselves,
-- so this table deliberately has no updated_at trigger.
create table if not exists public.rate_limits (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  bucket     text not null,
  tokens     numeric(10, 4) not null,   -- token bucket, or the day's count for attempt_daily
  window_day date,
  updated_at timestamptz not null default now(),
  -- The primary key also indexes the user_id foreign key.
  primary key (user_id, bucket),
  constraint rate_limits_bucket_valid  check (bucket in ('attempt', 'attempt_daily', 'wallet')),
  constraint rate_limits_tokens_nonneg check (tokens >= 0)
);

comment on table public.rate_limits is
  'Per-player token buckets (attempt, wallet) and the daily attempt count. '
  'Service role only: RLS enabled, no policy, no grant to anon or authenticated.';

alter table public.rate_limits enable row level security;   -- no policy: service role only

revoke all on table public.rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.rate_limits to service_role;

-- ---------------------------------------------------------------------------
-- hardening_jobs: one job per paid win (CH-6b, R1-S2)
-- ---------------------------------------------------------------------------
create table if not exists public.hardening_jobs (
  id            uuid primary key default gen_random_uuid(),
  attempt_id    uuid not null references public.attempts (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  level_id      smallint not null references public.levels (id),   -- the beaten level
  trigger       text not null,
  prompt_sha256 text not null,
  status        text not null default 'queued',
  claim_count   integer not null default 0,
  rule_set_id   uuid references public.rule_sets (id),
  error_code    text,
  created_at    timestamptz not null default now(),
  claimed_at    timestamptz,
  finished_at   timestamptz,
  -- Also indexes the attempt_id foreign key.
  constraint hardening_jobs_attempt_key      unique (attempt_id),
  constraint hardening_jobs_trigger_is_win   check (trigger = 'win'),   -- CH-6b: paid wins only
  constraint hardening_jobs_prompt_sha256    check (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  constraint hardening_jobs_status_valid     check (status in ('queued', 'processing', 'promoted', 'rejected', 'skipped', 'failed')),
  constraint hardening_jobs_claim_count      check (claim_count >= 0),
  constraint hardening_jobs_error_code       check (error_code is null or error_code ~ '^[a-z_]{3,40}$')
);

comment on table public.hardening_jobs is
  'The hardening queue: one job per paid win (trigger = win only, CH-6b). '
  'Service role only: RLS enabled, no policy, no grant to anon or authenticated.';

create index if not exists hardening_jobs_queue    on public.hardening_jobs (status, created_at);
create index if not exists hardening_jobs_user     on public.hardening_jobs (user_id, created_at desc);
create unique index if not exists hardening_jobs_dedupe on public.hardening_jobs (level_id, prompt_sha256)
  where status in ('queued', 'processing', 'promoted');
create index if not exists hardening_jobs_rule_set on public.hardening_jobs (rule_set_id);   -- R2-19

alter table public.hardening_jobs enable row level security;   -- no policy: service role only

revoke all on table public.hardening_jobs from public, anon, authenticated;
grant select, insert, update, delete on table public.hardening_jobs to service_role;

-- ---------------------------------------------------------------------------
-- admin_actions: the admin audit log (no free text)
-- ---------------------------------------------------------------------------
-- admin_id has no foreign key, so the log outlives a removed admin account.
create table if not exists public.admin_actions (
  id         bigint generated always as identity primary key,
  admin_id   uuid not null,
  action     text not null,
  target     text,
  created_at timestamptz not null default now(),
  constraint admin_actions_action_valid check (action in (
    'kill_switch_on', 'kill_switch_off', 'attempts_enabled', 'attempts_disabled',
    'hardening_enabled', 'hardening_disabled', 'game_reset', 'level_rules_reset',
    'hardening_run', 'admin_grant', 'player_hidden', 'player_unhidden',
    'keyword_removed', 'rule_rollback')),
  constraint admin_actions_target_length check (target is null or char_length(target) <= 80)
);

comment on table public.admin_actions is
  'Audit log of admin actions. Service role only: RLS enabled, no policy, no '
  'grant to anon or authenticated.';

alter table public.admin_actions enable row level security;   -- no policy: service role only

revoke all on table public.admin_actions from public, anon, authenticated;
revoke all on sequence public.admin_actions_id_seq from public, anon, authenticated;
grant select, insert, update, delete on table public.admin_actions to service_role;
grant usage, select on sequence public.admin_actions_id_seq to service_role;

-- ===========================================================================
-- 3. Foreign keys from 00002 back to attempts
-- ===========================================================================
-- 00002 created both columns and their indexes (R2-19). PostgreSQL has no
-- ADD CONSTRAINT IF NOT EXISTS, so each one is guarded.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'rule_sets_source_attempt_fk' and conrelid = 'public.rule_sets'::regclass
  ) then
    alter table public.rule_sets add constraint rule_sets_source_attempt_fk
      foreign key (source_attempt_id) references public.attempts (id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'golden_prompts_attempt_fk' and conrelid = 'public.golden_prompts'::regclass
  ) then
    alter table public.golden_prompts add constraint golden_prompts_attempt_fk
      foreign key (attempt_id) references public.attempts (id) on delete set null;
  end if;
end
$$;

-- ===========================================================================
-- 4. private._post_ledger: the single place that moves balances (CH-1)
-- ===========================================================================
-- Moves p_amount_cents from one account to another and appends the journal
-- row; returns the row's id. Each kind has fixed account types:
--   mint_starting, admin_grant, refund_mint   mint     -> player
--   mint_treasury_seed                         mint     -> treasury
--   attempt_fee, repair_fee                    player   -> treasury
--   attempt_refund, payout                     treasury -> player
--   donation                                   player   -> cncf
-- mint and cncf are external accounts with no stored balance. A player side
-- must name the wallet of p_user_id, so each owner's journal rows are exactly
-- the rows that move their wallet. The wallet side is applied before the
-- treasury side (lock order 3 before 4); callers already hold both row locks.
-- A player debit beyond the balance raises PT402 insufficient_funds, and a
-- treasury overdraft raises PT422; the CHECK constraints back both up.
-- A repeated external_ref raises unique_violation (23505), so a grant, fee,
-- payout, or refund can never be posted twice.
--
-- SECURITY INVOKER, executable by service_role only: its callers are the
-- service-role RPCs and the SECURITY DEFINER sign-up trigger (R2-17).
create or replace function private._post_ledger(
  p_kind         text,
  p_from         text,
  p_to           text,
  p_amount_cents bigint,
  p_user_id      uuid,
  p_attempt_id   uuid,
  p_external_ref text
)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_player_re   constant text := '^player:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_from_player uuid;
  v_to_player   uuid;
  v_player      uuid;
  v_balance     bigint;
  v_fits        boolean;
  v_id          bigint;
begin
  if p_kind is null or p_from is null or p_to is null or p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'invariant_violation: _post_ledger needs a kind, two accounts, and a positive amount'
      using errcode = 'PT422';
  end if;

  if p_from ~ v_player_re then
    v_from_player := substr(p_from, 8)::uuid;
  elsif p_from not in ('treasury', 'mint') then
    raise exception 'invariant_violation: _post_ledger cannot debit this account'
      using errcode = 'PT422';
  end if;

  if p_to ~ v_player_re then
    v_to_player := substr(p_to, 8)::uuid;
  elsif p_to not in ('treasury', 'cncf') then
    raise exception 'invariant_violation: _post_ledger cannot credit this account'
      using errcode = 'PT422';
  end if;

  -- Computed into a variable first: in plpgsql an IF condition ends at its
  -- first THEN, which would be the CASE's own.
  v_fits := case p_kind
    when 'mint_starting'      then p_from = 'mint' and v_to_player is not null
    when 'admin_grant'        then p_from = 'mint' and v_to_player is not null
    when 'refund_mint'        then p_from = 'mint' and v_to_player is not null
    when 'mint_treasury_seed' then p_from = 'mint' and p_to = 'treasury'
    when 'attempt_fee'        then v_from_player is not null and p_to = 'treasury'
    when 'repair_fee'         then v_from_player is not null and p_to = 'treasury'
    when 'attempt_refund'     then p_from = 'treasury' and v_to_player is not null
    when 'payout'             then p_from = 'treasury' and v_to_player is not null
    when 'donation'           then v_from_player is not null and p_to = 'cncf'
    else false
  end;

  if not coalesce(v_fits, false) then
    raise exception 'invariant_violation: _post_ledger got accounts that do not fit the kind'
      using errcode = 'PT422';
  end if;

  v_player := coalesce(v_from_player, v_to_player);
  if v_player is not null and p_user_id is distinct from v_player then
    raise exception 'invariant_violation: _post_ledger needs p_user_id to own the player account'
      using errcode = 'PT422';
  end if;

  -- Wallet side first (lock order 3).
  if v_from_player is not null then
    update public.wallets as w
       set balance_cents = w.balance_cents - p_amount_cents
     where w.user_id = v_from_player
       and w.balance_cents >= p_amount_cents;
    if not found then
      select w.balance_cents into v_balance from public.wallets as w where w.user_id = v_from_player;
      if not found then
        raise exception 'invariant_violation: _post_ledger found no wallet for the player'
          using errcode = 'PT422';
      end if;
      raise exception 'insufficient_funds: the balance is lower than the amount'
        using errcode = 'PT402',
              hint = format('{"balanceCents": %s, "priceCents": %s}', v_balance, p_amount_cents);
    end if;
  elsif v_to_player is not null then
    update public.wallets as w
       set balance_cents = w.balance_cents + p_amount_cents
     where w.user_id = v_to_player;
    if not found then
      raise exception 'invariant_violation: _post_ledger found no wallet for the player'
        using errcode = 'PT422';
    end if;
  end if;

  -- Treasury side second (lock order 4).
  if p_from = 'treasury' then
    update public.game_state as g
       set treasury_cents = g.treasury_cents - p_amount_cents
     where g.id = 1
       and g.treasury_cents >= p_amount_cents;
    if not found then
      raise exception 'invariant_violation: _post_ledger would overdraw the treasury'
        using errcode = 'PT422';
    end if;
  elsif p_to = 'treasury' then
    update public.game_state as g
       set treasury_cents = g.treasury_cents + p_amount_cents
     where g.id = 1;
    if not found then
      raise exception 'invariant_violation: _post_ledger found no game_state row'
        using errcode = 'PT422';
    end if;
  end if;

  insert into public.ledger_entries (kind, from_account, to_account, amount_cents, user_id, attempt_id, external_ref)
  values (p_kind, p_from, p_to, p_amount_cents, p_user_id, p_attempt_id, p_external_ref)
  returning id into v_id;

  return v_id;
end
$$;

revoke all on function private._post_ledger(text, text, text, bigint, uuid, uuid, text) from public, anon, authenticated;
grant execute on function private._post_ledger(text, text, text, bigint, uuid, uuid, text) to service_role;

comment on function private._post_ledger(text, text, text, bigint, uuid, uuid, text) is
  'The only function that changes wallets.balance_cents or '
  'game_state.treasury_cents (CH-1). Moves integer cents between accounts '
  'and appends the journal row. Service role only.';

-- ===========================================================================
-- 5. Sign-up: sanitizers and the one-time snapshot (R2-06, R2-16, R3-12)
-- ===========================================================================

-- Cleans a Google display name for public.profiles. It turns every run of
-- whitespace into one space, normalizes to NFC, strips the exact character
-- class that the CHECK in private.profile_display_name_ok rejects (C0 and C1
-- controls, zero-width characters, bidirectional embeddings, overrides, and
-- isolates, and the BOM) plus a few more invisible format characters, trims,
-- and truncates to 32 characters. It ends by calling the CHECK's own
-- validator, private.profile_display_name_ok, and falls back to "Player" and
-- four random digits for a null, empty, or still-invalid result, so a bad
-- Google profile can never abort sign-up (PR #3 review, M2).
--
-- VOLATILE, not immutable as section 5.4 suggests, because the fallback is
-- random.
create or replace function private._sanitize_display_name(p_name text)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_name text := p_name;
begin
  if v_name is not null then
    begin
      v_name := normalize(v_name, nfc);
    exception when others then
      v_name := p_name;   -- keep the raw text; the steps below still clean it
    end;

    v_name := regexp_replace(v_name, '[[:space:]]+', ' ', 'g');
    -- The CHECK's class (00001), then soft hyphen, Arabic letter mark,
    -- Mongolian vowel separator, line and paragraph separators, word joiner
    -- and invisible operators, and the deprecated format controls.
    v_name := regexp_replace(v_name, '[[:cntrl:]\u0080-\u009f​-‏‪-‮⁦-⁩﻿]', '', 'g');
    v_name := regexp_replace(v_name, '[­؜᠎  ⁠-⁤⁪-⁯]', '', 'g');
    v_name := regexp_replace(v_name, ' {2,}', ' ', 'g');
    v_name := btrim(left(btrim(v_name), 32));
  end if;

  if not coalesce(private.profile_display_name_ok(v_name), false) then
    v_name := 'Player ' || lpad(floor(random() * 10000)::integer::text, 4, '0');
  end if;

  return v_name;
end
$$;

-- Accepts a Google account-photo URL for public.profiles and returns null
-- for anything else (the UI then shows initials). The rule is the CHECK's
-- own validator, private.profile_avatar_url_ok: https on
-- lh3.googleusercontent.com under /a/ or /a-/, at most 512 characters, no
-- percent sign, query, fragment, or dot segment.
create or replace function private._sanitize_avatar_url(p_url text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_url text := nullif(btrim(p_url), '');
begin
  if v_url is null or not coalesce(private.profile_avatar_url_ok(v_url), false) then
    return null;
  end if;
  return v_url;
end
$$;

revoke all on function private._sanitize_display_name(text) from public, anon, authenticated;
revoke all on function private._sanitize_avatar_url(text) from public, anon, authenticated;
grant execute on function private._sanitize_display_name(text) to service_role;
grant execute on function private._sanitize_avatar_url(text) to service_role;

-- The sign-up trigger (AFTER INSERT on auth.users, SECURITY DEFINER).
--   - An anonymous user gets nothing: no profile, wallet, or grant (R2-16).
--   - The name and avatar are a one-time snapshot (R2-06). Only when
--     raw_app_meta_data->>'provider' is google do they come from
--     raw_user_meta_data (full_name or name; avatar_url or picture), through
--     the sanitizers. Any other provider gets "Player" and four digits and a
--     null avatar. At INSERT time GoTrue has filled the metadata from
--     Google's ID token and the user holds no session, so the user cannot
--     have edited it, and raw_app_meta_data is writable only by the service
--     role. No trigger copies raw_user_meta_data later.
--   - The wallet receives starting_balance_cents from app_config once, as a
--     mint_starting ledger row with external_ref start:<id> (CH-1). An
--     existing start:<id> row means the grant already happened, so it is
--     never minted twice.
-- SECURITY DEFINER because GoTrue inserts as supabase_auth_admin, which holds
-- no privilege on these tables. The function lives in schema private with
-- search_path = '' and is executable by no API role.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name     text;
  v_avatar   text;
  v_starting bigint;
  v_ref      text := 'start:' || new.id::text;
begin
  if coalesce(new.is_anonymous, false) then
    return null;
  end if;

  if new.raw_app_meta_data ->> 'provider' = 'google' then
    v_name := private._sanitize_display_name(
      coalesce(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''), new.raw_user_meta_data ->> 'name'));
    v_avatar := private._sanitize_avatar_url(
      coalesce(nullif(btrim(new.raw_user_meta_data ->> 'avatar_url'), ''), new.raw_user_meta_data ->> 'picture'));
  else
    v_name := private._sanitize_display_name(null);
    v_avatar := null;
  end if;

  -- The sanitizers already end with the CHECK validators. If a CHECK still
  -- refuses the row, sign-up continues with the fallback identity.
  begin
    insert into public.profiles (id, display_name, avatar_url)
    values (new.id, v_name, v_avatar)
    on conflict (id) do nothing;
  exception when check_violation then
    insert into public.profiles (id, display_name, avatar_url)
    values (new.id, private._sanitize_display_name(null), null)
    on conflict (id) do nothing;
  end;

  insert into public.wallets (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  select c.value::text::bigint into v_starting
  from public.app_config as c
  where c.key = 'starting_balance_cents';

  if coalesce(v_starting, 0) > 0
     and not exists (select 1 from public.ledger_entries as l where l.external_ref = v_ref) then
    perform private._post_ledger('mint_starting', 'mint', 'player:' || new.id::text, v_starting, new.id, null, v_ref);
  end if;

  return null;
end
$$;

revoke all on function private.handle_new_user() from public, anon, authenticated;

comment on function private.handle_new_user() is
  'AFTER INSERT trigger on auth.users: creates the profile (a one-time, '
  'sanitized Google snapshot), the wallet, and the one-time starting grant. '
  'Skips anonymous users. Executable by no API role.';

-- The only trigger on auth.users. It is created once and never replaced, so
-- a re-run needs no ownership of auth.users; the function body above is
-- replaced instead.
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'auth.users'::regclass and tgname = 'on_auth_user_created' and not tgisinternal
  ) then
    create trigger on_auth_user_created
      after insert on auth.users
      for each row execute function private.handle_new_user();
  end if;
end
$$;

-- ===========================================================================
-- 6. Triggers: append-only ledger and the rule-set activation feed
-- ===========================================================================

-- Refuses UPDATE, DELETE, and TRUNCATE on ledger_entries for every role,
-- the service role included.
create or replace function private.ledger_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'forbidden: ledger_entries is append-only'
    using errcode = 'PT403';
end
$$;

revoke all on function private.ledger_append_only() from public, anon, authenticated;

create or replace trigger ledger_no_update_delete
  before update or delete on public.ledger_entries
  for each row execute function private.ledger_append_only();

create or replace trigger ledger_no_truncate
  before truncate on public.ledger_entries
  for each statement execute function private.ledger_append_only();

-- Inserts one live_feed row when a rule set becomes active: hardened for a
-- hardening promotion, rules_reset for every other source (rollback, reset,
-- keyword removal). Superseding or rolling back a parent fires nothing
-- (R1-20). SECURITY INVOKER: its writers are service_role and postgres,
-- which may insert into live_feed (R2-30).
create or replace function private.rule_set_activated_feed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into public.live_feed (event_type, level_id, rule_version)
  values (
    case when new.source = 'hardening' then 'hardened' else 'rules_reset' end,
    new.level_id,
    new.version
  );
  return null;
end
$$;

revoke all on function private.rule_set_activated_feed() from public, anon, authenticated;

create or replace trigger rule_sets_activated_feed_update
  after update of state on public.rule_sets
  for each row
  when (new.state = 'active'::public.rule_set_state and old.state is distinct from 'active'::public.rule_set_state)
  execute function private.rule_set_activated_feed();

create or replace trigger rule_sets_activated_feed_insert
  after insert on public.rule_sets
  for each row
  when (new.state = 'active'::public.rule_set_state)
  execute function private.rule_set_activated_feed();

-- ===========================================================================
-- 7. Read functions
-- ===========================================================================

-- Public per-level rule version for /live. No rule content. SECURITY DEFINER
-- (one of the two advisor-allowlisted functions) because anon cannot read
-- rule_sets; it returns only the level id, name, active version, and the
-- time of the level's latest hardening activation.
create or replace function public.get_level_status()
returns table (level_id smallint, name text, active_version integer, last_hardened_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select l.id,
         l.name,
         a.version,
         (select max(h.activated_at)
            from public.rule_sets as h
           where h.level_id = l.id
             and h.source = 'hardening'
             and h.activated_at is not null)
  from public.levels as l
  left join public.rule_sets as a
    on a.level_id = l.id and a.state = 'active'::public.rule_set_state
  order by l.id;
$$;

revoke all on function public.get_level_status() from public, anon, authenticated;
grant execute on function public.get_level_status() to anon, authenticated, service_role;

-- The public subset of app_config. attempts_enabled is false while the kill
-- switch is on, so the switch itself is never exposed. SECURITY DEFINER (the
-- other allowlisted function) because anon cannot read app_config.
create or replace function public.get_public_config()
returns table (attempts_enabled boolean, attempt_price_cents bigint, repair_price_cents bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select c.value from public.app_config as c where c.key = 'attempts_enabled') = 'true'::jsonb, false)
           and coalesce((select c.value from public.app_config as c where c.key = 'kill_switch') = 'false'::jsonb, false),
         (select c.value::text::bigint from public.app_config as c where c.key = 'attempt_price_cents'),
         (select c.value::text::bigint from public.app_config as c where c.key = 'repair_price_cents');
$$;

revoke all on function public.get_public_config() from public, anon, authenticated;
grant execute on function public.get_public_config() to anon, authenticated, service_role;

-- The presence wall (CH-3, R2-07, R2-S1, R3-02). Players who are not hidden
-- and were seen within the window (clamped to 30..3600 seconds), newest
-- first, at most p_limit of them (clamped to 1..150).
--
-- It returns at most one row: list_hash, a hex md5 of the list, and players,
-- a JSON array of objects with exactly the LivePlayerDTO keys of
-- src/types/api.ts: id, name, avatarUrl, auraBps, and lastSeenBucket. No
-- email, balance, crack count, donation total, or raw timestamp.
--   - When p_known_hash equals the current hash, it returns no row, so an
--     unchanged list costs no bytes; the route answers { unchanged: true }.
--     A hash that is not 16 to 64 lowercase hex characters is ignored.
--   - An empty list is one row with players = [].
--   - The hash covers each player's id, name, avatar, and aura, sorted by id.
--     It excludes lastSeenBucket and the order of the list, which change on
--     every heartbeat, so "unchanged" does fire (PR #6 review, M4).
--   - lastSeenBucket is relative to now: floor(seconds since last seen / 120),
--     so 0 for everyone inside the default 120-second window.
-- SECURITY INVOKER, executable by service_role only: GET /live/players calls
-- it after the projector-cookie check, and presence_ping calls it for the
-- signed-in heartbeat.
create or replace function public.get_live_players(
  p_window_seconds integer default 120,
  p_limit          integer default 150,
  p_known_hash     text    default null
)
returns table (list_hash text, players jsonb)
language sql
stable
set search_path = ''
as $$
  with params as (
    select least(greatest(coalesce(p_window_seconds, 120), 30), 3600) as window_seconds,
           least(greatest(coalesce(p_limit, 150), 1), 150)            as max_rows
  ),
  seen as (
    select p.id, p.display_name, p.avatar_url, w.aura_bps, w.last_seen_at
    from public.wallets as w
    join public.profiles as p on p.id = w.user_id
    cross join params as x
    where w.last_seen_at is not null
      and w.last_seen_at >= now() - make_interval(secs => x.window_seconds)
      and not p.live_hidden
    order by w.last_seen_at desc, p.id
    limit (select x2.max_rows from params as x2)
  ),
  listing as (
    select md5(coalesce(
             jsonb_agg(jsonb_build_array(s.id, s.display_name, s.avatar_url, s.aura_bps) order by s.id)::text,
             '[]')) as list_hash,
           coalesce(
             jsonb_agg(jsonb_build_object(
               'id', s.id,
               'name', s.display_name,
               'avatarUrl', s.avatar_url,
               'auraBps', s.aura_bps,
               'lastSeenBucket', greatest(0, floor(extract(epoch from now() - s.last_seen_at) / 120))::integer
             ) order by s.last_seen_at desc, s.id),
             '[]'::jsonb) as players
    from seen as s
  )
  select l.list_hash, l.players
  from listing as l
  where p_known_hash is null
     or p_known_hash !~ '^[0-9a-f]{16,64}$'
     or l.list_hash <> p_known_hash;
$$;

revoke all on function public.get_live_players(integer, integer, text) from public, anon, authenticated;
grant execute on function public.get_live_players(integer, integer, text) to service_role;

comment on function public.get_live_players(integer, integer, text) is
  'The presence wall: at most one row (list_hash, players), or none when '
  'p_known_hash matches. players holds LivePlayerDTO objects only. Service role only.';

-- The signed-in heartbeat (R2-S1). It sets wallets.last_seen_at = now() only
-- when it is null or at least 60 seconds old, so pings never become a write
-- storm, and then returns get_live_players for the same window, limit, and
-- known hash. The route passes the id from getUser(), never from a body. Its
-- only lock is the caller's wallet row, taken by one UPDATE (lock order 3).
-- A user without a wallet (an anonymous session, R2-16) gets PT403.
create or replace function public.presence_ping(
  p_user_id        uuid,
  p_window_seconds integer default 120,
  p_limit          integer default 150,
  p_known_hash     text    default null
)
returns table (list_hash text, players jsonb)
language plpgsql
set search_path = ''
as $$
begin
  if p_user_id is null then
    raise exception 'invariant_violation: presence_ping needs a user id'
      using errcode = 'PT422';
  end if;

  update public.wallets as w
     set last_seen_at = now()
   where w.user_id = p_user_id
     and (w.last_seen_at is null or w.last_seen_at <= now() - interval '60 seconds');

  if not found and not exists (select 1 from public.wallets as w where w.user_id = p_user_id) then
    raise exception 'forbidden: presence_ping needs a player with a wallet'
      using errcode = 'PT403';
  end if;

  return query
    select g.list_hash, g.players
    from public.get_live_players(p_window_seconds, p_limit, p_known_hash) as g;
end
$$;

revoke all on function public.presence_ping(uuid, integer, integer, text) from public, anon, authenticated;
grant execute on function public.presence_ping(uuid, integer, integer, text) to service_role;

comment on function public.presence_ping(uuid, integer, integer, text) is
  'Heartbeat: records last_seen_at at most once per 60 seconds, then returns '
  'get_live_players for the same arguments. Service role only.';

-- ===========================================================================
-- 8. Seed: the singleton game state
-- ===========================================================================
-- The pig starts at level 1, epoch 1. A non-zero treasury_seed_cents is
-- minted into the treasury through the ledger once, so the journal explains
-- every cent (external_ref seed:epoch:1).
insert into public.game_state (id) values (1)
on conflict (id) do nothing;

do $$
declare
  v_seed bigint;
begin
  select c.value::text::bigint into v_seed
  from public.app_config as c
  where c.key = 'treasury_seed_cents';

  if coalesce(v_seed, 0) > 0
     and not exists (select 1 from public.ledger_entries as l where l.external_ref = 'seed:epoch:1') then
    perform private._post_ledger('mint_treasury_seed', 'mint', 'treasury', v_seed, null, null, 'seed:epoch:1');
  end if;
end
$$;

-- ===========================================================================
-- 9. Realtime publication: exactly game_state and live_feed (section 5.5)
-- ===========================================================================
-- Both tables are public by schema (T15). Guarded, so a re-run is a no-op.
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'game_state') then
    alter publication supabase_realtime add table public.game_state;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'live_feed') then
    alter publication supabase_realtime add table public.live_feed;
  end if;
end
$$;

-- ===========================================================================
-- 10. Self-check: fail loudly if a privilege is not as intended
-- ===========================================================================
-- REVOKE only warns when the current role is not the grantor, so the end
-- state is verified here as well as in supabase/tests/00004_game_ledger.test.sql.
do $$
declare
  v_privileges text[] := array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  v_tables     text[] := array[
    'public.game_state', 'public.wallets', 'public.attempts', 'public.ledger_entries',
    'public.donations', 'public.live_feed', 'public.blocked_fingerprints', 'public.ai_spend',
    'public.rate_limits', 'public.hardening_jobs', 'public.admin_actions'];
  v_problem    text;
begin
  if current_setting('server_version_num')::integer >= 170000 then
    v_privileges := array_append(v_privileges, 'MAINTAIN');
  end if;

  -- anon: SELECT on game_state and live_feed only. authenticated: SELECT on
  -- those plus wallets, ledger_entries, and donations (attempts is a column
  -- grant, so it holds no table-level SELECT). Nothing else.
  select string_agg(format('%s:%s.%s', r.role_name, t.table_name, p.privilege), ', ')
    into v_problem
  from (values ('anon'), ('authenticated')) as r (role_name)
  cross join unnest(v_tables) as t (table_name)
  cross join unnest(v_privileges) as p (privilege)
  where has_table_privilege(r.role_name, t.table_name, p.privilege)
    and not (p.privilege = 'SELECT' and t.table_name in ('public.game_state', 'public.live_feed'))
    and not (r.role_name = 'authenticated' and p.privilege = 'SELECT'
             and t.table_name in ('public.wallets', 'public.ledger_entries', 'public.donations'));

  if v_problem is not null then
    raise exception '00004: anon or authenticated hold unintended table privileges: %', v_problem;
  end if;

  -- service_role: explicit DML on every table and USAGE, SELECT on every
  -- identity sequence (PR #3 review, H1).
  select string_agg(format('%s.%s', t.table_name, p.privilege), ', ')
    into v_problem
  from unnest(v_tables) as t (table_name)
  cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p (privilege)
  where not has_table_privilege('service_role', t.table_name, p.privilege);

  if v_problem is null then
    select string_agg(s.seq, ', ')
      into v_problem
    from unnest(array['public.ledger_entries_id_seq', 'public.donations_id_seq',
                      'public.live_feed_id_seq', 'public.admin_actions_id_seq']) as s (seq)
    where not (has_sequence_privilege('service_role', s.seq, 'USAGE')
               and has_sequence_privilege('service_role', s.seq, 'SELECT'));
  end if;

  if v_problem is not null then
    raise exception '00004: service_role lacks its explicit grants: %', v_problem;
  end if;

  if has_function_privilege('anon', 'private._post_ledger(text, text, text, bigint, uuid, uuid, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'private._post_ledger(text, text, text, bigint, uuid, uuid, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.presence_ping(uuid, integer, integer, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.presence_ping(uuid, integer, integer, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.get_live_players(integer, integer, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.get_live_players(integer, integer, text)', 'EXECUTE') then
    raise exception '00004: a service-role function is executable by anon or authenticated';
  end if;

  if (select count(*) from public.game_state) <> 1 then
    raise exception '00004: game_state must hold exactly one row';
  end if;
end
$$;
