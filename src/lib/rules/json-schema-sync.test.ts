import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { HardeningProposalSchema, RuleSetSchema } from '@/lib/rules/schema'

/**
 * The committed JSON Schemas are generated from the authoritative zod schemas
 * (docs/ARCHITECTURE.md section 6.1). This test fails on drift; `pnpm
 * rules:schema` sets UPDATE_SCHEMA=1, which rewrites both files first.
 */

const DIR = path.dirname(fileURLToPath(import.meta.url))
const UPDATE = process.env.UPDATE_SCHEMA === '1'

const CASES = [
  { file: 'rule-set.schema.json', schema: RuleSetSchema },
  { file: 'proposal.schema.json', schema: HardeningProposalSchema },
] as const

describe('committed JSON Schemas', () => {
  for (const { file, schema } of CASES) {
    it(`${file} deep-equals z.toJSONSchema of its zod schema`, () => {
      const target = path.join(DIR, file)
      const generated = z.toJSONSchema(schema)
      if (UPDATE) writeFileSync(target, `${JSON.stringify(generated, null, 2)}\n`)
      const committed: unknown = JSON.parse(readFileSync(target, 'utf8'))
      expect(committed).toEqual(generated)
    })
  }
})
