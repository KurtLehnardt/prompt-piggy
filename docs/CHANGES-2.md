# Prompt Piggy — User Changes Round 2 (2026-10-24)

Apply these in the round-2 fix pass, or patch `orchestrator-tasks.json` `conventions` during the docs-commit step if no fix pass runs.

## 1. Supabase agent skills (installed by the user 2026-10-24 at `~/.agents/skills/`)

- `supabase` v0.1.2 (author: supabase) at `~/.agents/skills/supabase/SKILL.md`, with `references/` and `assets/`.
- `supabase-postgres-best-practices` v1.1.1 (author: supabase) at `~/.agents/skills/supabase-postgres-best-practices/SKILL.md`, with `references/`.
- Every task that touches migrations, schema, RLS, RPCs/functions, triggers, realtime, auth, or `@supabase/ssr` code lists both SKILL.md paths as required `inputs`. Workers read them before writing that code. Reviewers of those PRs check against them.

## 2. No skill or global installs by agents

- `find-skills` (the skills CLI helper) was also installed. Its instructions tell agents to run `npx skills add <pkg> -g -y`, which installs globally and skips confirmation.
- Add to `conventions`: workers must NOT run `npx skills add`, `npx skills update`, or any global install (`-g`). Installing or updating skills requires the user's explicit approval.
- Project dependencies are installed only through the repo's package manager, and only the dependencies a task's spec names.

## 3. Repo destination: PUBLIC, `KurtLehnardt/prompt-piggy` (user decision)

- The repo is PUBLIC under the user's personal account (not the IniTechInc org). The orchestrator creates it; PP-01 still creates no remote.
- Because it is public:
  - CI must include a secret scan (e.g. gitleaks) on every PR.
  - `.env*` stays gitignored except `.env.example`.
  - No real keys appear in docs, tests, or fixtures.
  - Breach prompts and the breach regression corpus live only in the database, never in the repo.
  - The benign golden dataset may live in the repo.
- Vercel is connected by importing this repo in the Vercel dashboard, and needs PP-01 merged. Production Google OAuth redirect URLs and the Supabase URL config must cover the Vercel production URL and preview URLs. Document this in the deploy task.
