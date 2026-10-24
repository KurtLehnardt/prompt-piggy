import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LEVEL_IDS } from '@/lib/config/levels'
import { CAPS, KEYWORD_PATTERN } from '@/lib/rules/caps'
import { SEED_RULE_SETS } from '@/lib/rules/seed'

/**
 * Sync between migration 00002 (PP-07) and the TypeScript rule schema
 * (PP-06), moved here from PP-07.
 *
 * The task text names `-- seed:level:N` markers. Migration 00002 as merged
 * has none; it seeds each level as one `(N::smallint, '{...}'::jsonb)` row of
 * a VALUES list, so this test reads those rows instead. The cap literals are
 * read from public.rule_set_payload_ok.
 */

const MIGRATION = readFileSync(
  path.join(process.cwd(), 'supabase', 'migrations', '00002_rule_sets.sql'),
  'utf8'
)

function seedRows(): Map<number, unknown> {
  const rows = new Map<number, unknown>()
  const pattern = /\((\d)::smallint,\s*'(\{[\s\S]*?\})'::jsonb\)/g
  for (const match of MIGRATION.matchAll(pattern)) {
    rows.set(Number(match[1]), JSON.parse(match[2].replace(/''/g, "'")))
  }
  return rows
}

function payloadOkBody(): string {
  const start = MIGRATION.indexOf('create or replace function public.rule_set_payload_ok')
  const end = MIGRATION.indexOf('$$;', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return MIGRATION.slice(start, end)
}

describe('00002 seed rows equal SEED_RULE_SETS', () => {
  const rows = seedRows()

  it('has exactly one seed row per level', () => {
    expect([...rows.keys()].sort()).toEqual([...LEVEL_IDS])
  })

  for (const level of LEVEL_IDS) {
    it(`level ${level}`, () => {
      expect(rows.get(level)).toEqual(SEED_RULE_SETS[level])
    })
  }
})

describe('rule_set_payload_ok cap literals equal src/lib/rules/caps.ts', () => {
  const body = payloadOkBody()

  it('uses the canonical byte cap', () => {
    expect(body).toContain(`octet_length(p::text) > ${CAPS.ruleSetBytes}`)
  })

  it('uses the keyword count cap', () => {
    expect(body).toContain(`jsonb_array_length(p -> 'block_keywords') > ${CAPS.keywordsPerRuleSet}`)
  })

  it('uses the keyword length caps', () => {
    expect(body).toContain(`not between ${CAPS.keywordMin} and ${CAPS.keywordMax}`)
  })

  it('uses the keyword pattern and token counts', () => {
    const match = body.match(/!~ '(\^\[a-z0-9\]\+\(\[ ''-\]\[a-z0-9\]\+\)\{(\d),(\d)\}\$)'/)
    expect(match).not.toBeNull()
    const [, sqlPattern, min, max] = match as RegExpMatchArray
    expect(Number(min)).toBe(CAPS.keywordMinTokens - 1)
    expect(Number(max)).toBe(CAPS.keywordMaxTokens - 1)
    const unescaped = sqlPattern.replace(/''/g, "'").replace('([', '(?:[')
    expect(unescaped).toBe(KEYWORD_PATTERN)
  })

  it('accepts exactly schema_version 1', () => {
    expect(body).toContain(`p -> 'schema_version' is distinct from '${CAPS.schemaVersion}'::jsonb`)
  })
})
