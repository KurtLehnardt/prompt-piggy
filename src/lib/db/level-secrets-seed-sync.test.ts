import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LevelSecretsFileSchema } from '@/lib/config/level-secrets'
import { canonicalJson, payloadSha256 } from '../../../scripts/ops/seed-level-secrets.mjs'

/**
 * Keeps the local placeholder rows in supabase/seed.sql in step with the
 * committed fixture (docs/ARCHITECTURE.md section 6.2, REVIEW-2 R2-12), and
 * keeps every migration free of level_secrets rows. Every payload here is
 * synthetic and says "placeholder".
 */
const ROOT = path.resolve(__dirname, '../../..')
const SEED_SQL = readFileSync(path.join(ROOT, 'supabase/seed.sql'), 'utf8')
const FIXTURE: Record<string, unknown> = JSON.parse(
  readFileSync(path.join(ROOT, 'src/lib/config/__fixtures__/level-secrets.placeholder.json'), 'utf8')
)

/** The rows of the level_secrets insert in seed.sql: the dollar-quoted JSON and the hash after it. */
function seedRows(): Map<string, { payload: unknown; sha256: string }> {
  const rows = new Map<string, { payload: unknown; sha256: string }>()
  const pattern = /\(\s*(\d+),\s*\$level_(\d+)\$([\s\S]*?)\$level_\2\$::jsonb,\s*'([0-9a-f]{64})'\s*\)/g
  for (const match of SEED_SQL.matchAll(pattern)) {
    expect(match[1], 'the level id matches its dollar-quote tag').toBe(match[2])
    rows.set(match[1], { payload: JSON.parse(match[3]), sha256: match[4] })
  }
  return rows
}

describe('supabase/seed.sql level 4 and 5 placeholders (R2-12)', () => {
  it('has exactly one row each for levels 4 and 5, inserted into public.level_secrets', () => {
    expect([...seedRows().keys()].sort()).toEqual(['4', '5'])
    expect(SEED_SQL).toMatch(/insert into public\.level_secrets \(level_id, payload, payload_sha256\)/)
  })

  it('deep-equals the committed placeholder fixture', () => {
    const rows = seedRows()
    expect(rows.get('4')?.payload).toEqual(FIXTURE['4'])
    expect(rows.get('5')?.payload).toEqual(FIXTURE['5'])
  })

  it('stores the hash that the seed script computes for each payload', () => {
    const rows = seedRows()
    expect(rows.get('4')?.sha256).toBe(payloadSha256(FIXTURE['4']))
    expect(rows.get('5')?.sha256).toBe(payloadSha256(FIXTURE['5']))
  })

  it('holds placeholders only, and they pass LevelSecretsFileSchema', () => {
    const rows = seedRows()
    const file = { '4': rows.get('4')?.payload, '5': rows.get('5')?.payload }
    const parsed = LevelSecretsFileSchema.parse(file)
    expect(parsed['4'].placeholder).toBe(true)
    expect(parsed['5'].placeholder).toBe(true)
  })

  it('keeps the header of PP-03: local databases only', () => {
    expect(SEED_SQL).toMatch(/^-- Local seed data for Prompt Piggy\./)
    expect(SEED_SQL).toContain('LOCAL DATABASES ONLY.')
  })
})

describe('migrations never write level_secrets (R2-12)', () => {
  const migrationsDir = path.join(ROOT, 'supabase/migrations')
  const migrations = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'))

  it('finds the migrations', () => {
    expect(migrations).toContain('00002_rule_sets.sql')
  })

  it.each(migrations)('%s inserts, copies, or merges no level_secrets row', (name) => {
    const sql = readFileSync(path.join(migrationsDir, name), 'utf8')
    expect(sql).not.toMatch(/\b(?:insert\s+into|copy|merge\s+into)\s+(?:public\.)?level_secrets\b/i)
  })
})

describe('canonical JSON hashes shared with SQL', () => {
  // supabase/tests/00002_rule_sets.test.sql pins private.rule_set_sha256 to
  // the same two values, so the SQL and JavaScript canonical forms of a rule
  // set (sorted keys, sorted keywords, no whitespace) cannot drift apart.
  const FLAGS = [
    'reject_roleplay_archetypes',
    'reject_authority_claims',
    'reject_instruction_override',
    'reject_delimiter_tokens',
    'reject_encoded_payloads',
    'reject_tool_invocation_language',
    'reject_deferred_instructions',
    'reject_mixed_script_obfuscation',
    'reject_hypothetical_framing',
  ]
  function ruleSet(on: string[], keywords: string[]): Record<string, unknown> {
    return {
      schema_version: 1,
      block_keywords: [...keywords].sort(),
      ...Object.fromEntries(FLAGS.map((flag) => [flag, on.includes(flag)])),
    }
  }
  const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

  it('matches the SQL hash of the all-false rule set', () => {
    expect(sha256(canonicalJson(ruleSet([], [])))).toBe('7956bfa522d3750ab535213cf6abbcb4df68c26a51d092a55fa2297f2055d6d2')
  })

  it('matches the SQL hash of a rule set with flags and keywords', () => {
    const rules = ruleSet(['reject_roleplay_archetypes', 'reject_authority_claims'], ['root user override', 'grandma vault ritual'])
    expect(sha256(canonicalJson(rules))).toBe('4bd98daff10190ee9c1f639a073b675a594ccf904a5fc94a7ec44de8caefe110')
  })

  it('is compact JSON with recursively sorted keys', () => {
    expect(canonicalJson({ b: [2, { d: 1, c: 'x' }], a: true })).toBe('{"a":true,"b":[2,{"c":"x","d":1}]}')
  })
})
