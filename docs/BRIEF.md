# MISSION BRIEF: Prompt Piggy System Architecture & Action Plan (user-supplied, verbatim)

You are acting as the Chief Software Architect. Your job is to inspect an existing repository (`~/work/PresidentNelsonsScriptureChallenge`), extract its patterns, and design a blueprint for **Prompt Piggy**—a self-hardening prompt-security game.

Deconstruct this brief into actionable task packages for an Orchestrator Agent to distribute to specialised worker agents.

---

## SECTION 1: Repository Pattern Scan
Scan the local directory `~/work/PresidentNelsonsScriptureChallenge` and extract:
1. **Authentication & Session Patterns:** Supabase Auth setup (`@supabase/auth-helpers-nextjs` or `@supabase/ssr`), OAuth configuration (Google, GitHub, etc.), and protected API/route handlers.
2. **Database Schema & ORM:** Supabase Client instances, Row-Level Security (RLS) policies, and TypeScript interface definitions.
3. **Deployment Strategy:** Vercel configuration (`vercel.json` or Next.js App Router setup), environment variables, and build scripts.
4. **UI Design System:** Tailwind CSS setup, component conventions, state management, and toaster/notification patterns.

Reuse these structural patterns to ensure architectural consistency for Prompt Piggy.

---

## SECTION 2: System Blueprint & Target Stack
- **Hosting:** Vercel (Next.js App Router, Serverless / Edge Functions).
- **Database & Auth:** Supabase (PostgreSQL, RLS, Auth with OAuth/Social Logins copied from `PresidentNelsonsScriptureChallenge`).
- **AI Core:**
  - **OpenAI Decisions API:** High-speed, bounded binary evaluation (`payout: true` vs `payout: false`) on whether an attack attempt succeeded.
  - **OpenAI Agents API / Agents SDK (`@openai/agents`):** Multi-turn session orchestration, secure execution sandboxing, and dynamic memory context compaction.
- **Game Mechanics:**
  - Dynamic interactive UI with an animated hammer striking a piggy bank on submission.
  - Animated screen-crack overlay tracking failures (0 to 3 cracks per session).
  - Treasury Bank balance ($T$) and scale-based penalty system: 1% baseline penalty on 3 failures, scaling dynamically up to high-value lock amounts (e.g., $100,000 lock state).
- **Payment Gateway:** Dual-mode payment subsystem with a mock environment for local testing and production adapters for Stripe / Bitcoin (Lightning).
- **Hardening & Security:**
  - Dual-layer context encapsulation to prevent system prompt extraction.
  - Canary tokens and tripwire outputs for leakage detection.
  - Pre-screening filters for adversarial vectors (base64 smuggling, role-play impersonation, MCP takeover, delimiter manipulation).

---

## SECTION 3: Detailed Task Breakdowns for Worker Agents

Generate actionable specifications for four worker roles:

### 1. `Worker-UI-Frontend`
- Replicate the layout and Auth state providers from `PresidentNelsonsScriptureChallenge`.
- Build an SVG/Canvas physics animation for the interactive Hammer and Piggy Bank.
- Implement the screen-crack overlay state machine (Tracks 0 to 3 cracks; triggers penalty popup on 3rd failure and resets glass).
- Build the live Treasury Counter with real-time SSE or Supabase realtime subscriptions.

### 2. `Worker-Supabase-Finance`
- Create Supabase migrations mirroring the schema structure in the reference repo:
  - `profiles` table (linked to `auth.users`).
  - `treasury_ledger` table (tracks total bank value, total attempts, total payouts).
  - `attempt_logs` table (tracks user ID, prompt string, binary decision outcome, cracks, penalty deducted).
- Write Supabase RLS policies ensuring users can only query public stats and their own session data.
- Build the payment module (Mock payment provider toggle + Stripe/Crypto webhook handlers).

### 3. `Worker-AI-Engine`
- Implement OpenAI Agents API (`@openai/agents`) session management to isolate attacker contexts.
- Route prompt evaluations through the OpenAI Decisions API for sub-second, bounded true/false output without free-form text exposure.
- Build a context-compaction routine to update system instructions dynamically with neutralized attacker attempts ("self-hardening baseline").

### 4. `Worker-Security-Hardening`
- Implement input sanitization and heuristic tripwires before prompts reach the LLM.
- Implement canary token injection and prompt encapsulation layers to render prompt extraction impossible.
- Build an anti-steering filter to neutralize hostile Agent/MCP tool takeover attempts.

---

## OUTPUT REQUIREMENTS FOR ARCHITECT AGENT:
1. Provide a step-by-step summary of patterns discovered in `~/work/PresidentNelsonsScriptureChallenge`.
2. Generate the directory tree for the new Next.js / Supabase application.
3. Produce exact JSON / Markdown action items ready to feed directly into an Orchestrator Agent loop.
