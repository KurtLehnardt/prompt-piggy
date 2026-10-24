# Prompt Piggy — User Changes Round 1 (2026-10-24)

These changes override FACTS.md and the current ARCHITECTURE.md / orchestrator-tasks.json wherever they conflict. HARDENING_CONSTRAINTS.md still overrides everything.

## 1. Economy (replaces the penalty / LOCK_CAP economy in FACTS §A and ARCHITECTURE §9)

- **All money is mocked in v1.** Amounts are denominated in USD and stored as integer cents (`bigint`). No real charge or payout happens anywhere.
- **Wallet:** each player has one.
  - A starting grant of `STARTING_BALANCE_CENTS` = 2000 ($20) at first sign-in (user decision). The real "Add funds" is "coming soon".
  - Admins can grant extra demo funds.
  - Every debit (attempts, glass repair, donations) is a mock debit from this wallet. No real money moves.
- **Attempt price:** each attempt costs `ATTEMPT_PRICE_CENTS` (default 100, i.e. $1).
  - The price is debited from the wallet and credited to the treasury atomically, inside the same RPC that opens the attempt, BEFORE any model call, so failed or errored attempts are never free.
  - Define the refund policy for system errors (e.g. OpenAI outage) explicitly.
  - Insufficient balance means the attempt is rejected with a clear message.
- **Win:** the winner takes the whole treasury into their wallet, and the treasury resets to `TREASURY_SEED_CENTS` (default 0). It must be atomic and idempotent, with exactly one payout per breach.
- **Cracks persist per user** (user decision, supersedes "reset each session").
  - Store `crack_count` server-side on the player's game state, NOT in localStorage. Range 0 to 3; each failed attempt adds one, capped at 3.
  - Cracks survive sign-out, new sessions, and new devices.
  - The ONLY way to clear them is "Repair glass" for `REPAIR_PRICE_CENTS` (default 100, i.e. $1). The repair RPC atomically debits the wallet, credits the treasury (the piggy bank), and resets `crack_count` to 0. Reject the repair with no charge when `crack_count` = 0.
  - There is no automatic reset at 3.
  - The 3rd crack shows the "glass shattered" popup with a "Repair for $1" action.
  - ASSUMPTION (user may change): cracks do NOT block play; a player can keep attacking with a shattered screen.
  - There is NO other monetary penalty. Remove `PENALTY_BASE_PCT`, `LOCK_CAP`, penalty scaling, and burn logic.
  - **HC3 compatibility:** `crack_count` is game/economy state that only deterministic server logic changes, based on the attempt outcome. It must NEVER be passed into Core LLM, Validator, Evaluator, or Hardening Engine context. Add an acceptance test asserting the model input is identical regardless of `crack_count`.
  - The UI renders the crack overlay from server state on load and via realtime/refetch after each attempt or repair.

## 2. CNCF donations and aura

- **Donate to CNCF (mocked):**
  - The player donates any amount from 1 cent up to their full wallet balance.
  - A donation atomically debits the wallet, increments the player's `total_donated_cents`, and writes a `donations` row.
  - The UI says plainly: "Mock donation: no money moves." Do NOT use the CNCF logo or imply affiliation (trademark). Text name only.
- **Aura formula (user spec, pure percentage):**
  - `aura = total_donated / (total_donated + wallet_balance)`, in the range 0 to 1, and 0 when both are 0.
  - Donating 100% of the balance gives max aura instantly.
  - Compute it server-side (generated column or view). Never trust a client-supplied value.
- **Glow:**
  - A soft glow around the Google profile picture, extending at most 10px from the avatar edge.
  - Intensity and opacity scale with aura. High aura is very bright within that 10px.
  - Any pulsing animation respects `prefers-reduced-motion`.

## 3. Presence wall

- **Who appears:** every signed-in user, simultaneously, on the `/live` projector view and as a strip on the game page.
- **Mechanism:** Supabase Realtime Presence.
- **SECURITY:** presence payloads are client-controlled, so a user could fake their aura or name. Presence tracks only the user id (bound to the authenticated session). Aura, display name, and avatar URL come from a public, server-computed profile view or table, read via RLS or realtime. Define the channel authorization (Realtime Authorization / private channels) so unauthenticated clients cannot inject presence entries.
- **Avatar:**
  - Copied from Google `user_metadata` (`avatar_url` / `picture`) into `profiles` at sign-up via a trigger.
  - Configure `next/image` `remotePatterns` for `lh3.googleusercontent.com`.
  - Fall back to initials.
- **Sign-in notice:** "Your Google photo and name appear on the big screen." The user's spec is that every signed-in user is shown, so there is no opt-out in v1.
- **Scale:** fewer than 100 concurrent users.

## 4. Payment in/out UI (mocked, "coming soon")

- **Buttons:** the wallet panel has "Add funds" and "Withdraw". Each offers "Card (Stripe)" and "Crypto (Lightning)".
- **Behavior:** every one of those buttons is clickable and shows "Coming soon" (dialog or toast). They make NO network calls, and the Stripe/crypto SDKs are NOT installed in v1.
- **Adapter interface:** keep the payment adapter interface for future rails. The mock adapter backs the starting grant, attempt debits, payouts, and donations.
- **Legal note:** the real-money note stays in the docs. Withdrawal (cash-out) is the part that needs legal review before any real rail ships, and Stripe prohibits paid-entry cash-prize games.

## 5. Scale and ops

- **Audience:** fewer than 100 concurrent players. Free tiers are acceptable. No load-test task.
- **Verify and document free-tier limits:**
  - Supabase Free: Realtime concurrent connections and messages/sec; Presence counts both the projector and the players.
  - Vercel Hobby: function `maxDuration`; cron frequency (Hobby = daily only), so redesign anything that depended on per-minute cron; the non-commercial use clause.
  Flag anything that breaks at fewer than 100 users.

## 6. `/live` projector

- Labels only: player display name/avatar, attack-technique label, outcome, treasury, and the presence wall.
- NEVER raw prompts or excerpts.

## 6b. Blocklist source (user decision)

- `block_keywords`, the winning-prompt fingerprint block, and every other hardening rule change may be proposed ONLY from a verified successful bank break, meaning a server-verified `approveTransfer` win.
- These never feed the blocklist or hardening: failed attempts, Validator-blocked attempts, tripwire hits, canary leaks without a win, and attack-technique labels.
- This matches R1-S2. It does not remove R1-01: the winner fully controls the breach text, so they can still try to seed benign phrases. The R1-01 control still applies to win-derived keywords.

## 7. Defaults for the remaining open questions (ARCHITECTURE §14.2)

- Hardening is per level.
- Animation is hand-rolled (no animation library) unless the architect has a strong reason otherwise.
- Admins come from env `ADMIN_EMAILS` (comma-separated), set at deploy. Do not hardcode any email.
- Retention: raw attempt prompts for 30 days; breach prompts indefinitely (golden dataset / regression).
- The GitHub repo name and visibility, and the Vercel plan, are deferred. PP-01 does not create a remote.
