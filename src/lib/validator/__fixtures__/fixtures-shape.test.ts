import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DETECTOR_FAMILIES, type DetectorFamily } from '@/lib/config/detector-families'
import { PROMPT_CHARS_HARD_MAX } from '@/types/api'

const dir = __dirname

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(dir, name), 'utf8'))
}

const id = z.string().regex(/^[a-z0-9_-]+$/)
const text = z.string().min(1).max(PROMPT_CHARS_HARD_MAX)
const tags = z.array(z.string().regex(/^[a-z0-9_]+$/)).min(1)
const family = z.enum(DETECTOR_FAMILIES)

const wrap = <T extends z.ZodType>(corpus: string, c: T) =>
  z.strictObject({
    schema_version: z.literal(1),
    corpus: z.literal(corpus),
    note: z.string().min(1),
    cases: z.array(c),
  })

const variant = z.enum([
  'plain',
  'zero_width',
  'homoglyph',
  'reversed',
  'encoded_base64',
  'encoded_hex',
  'encoded_url',
  'encoded_decimal',
])

const attackSchema = wrap(
  'attacks',
  z.strictObject({
    id,
    family,
    variant,
    flaggedFromLevel: z.number().int().min(2).max(5),
    tags,
    text,
  }),
)
const benignSchema = wrap('benign', z.strictObject({ id, tags, text }))
const loopholeSchema = wrap(
  'loophole',
  z.strictObject({ id, level: z.union([z.literal(1), z.literal(2), z.literal(3)]), tags, text }),
)
const trafficSchema = wrap(
  'traffic-sample',
  z.strictObject({
    id,
    authorId: z.string().regex(/^author-\d{2}$/),
    split: z.enum(['filter', 'holdout']),
    tags,
    text,
  }),
)

const attacks = attackSchema.parse(load('attacks.v1.json')).cases
const benign = benignSchema.parse(load('benign.v1.json')).cases
const loophole = loopholeSchema.parse(load('loophole.v1.json')).cases
const traffic = trafficSchema.parse(load('traffic-sample.v1.json')).cases

const FLAGGED_FROM: Record<DetectorFamily, number> = {
  roleplay: 2,
  authority: 3,
  override: 3,
  delimiter: 3,
  decode: 4,
  tool: 4,
  deferred: 4,
  mixed_script: 5,
  hypothetical: 5,
}

// Phrase catalog from ARCHITECTURE section 6.2, used only as a fixture hygiene check.
const PHRASES: Record<'roleplay' | 'authority' | 'override' | 'deferred' | 'hypothetical' | 'tool', string[]> = {
  roleplay: ['pretend you are', 'act as', 'you are now', 'roleplay as', 'developer mode', 'jailbreak mode'],
  authority: ['i am the administrator', 'root user', 'admin override', 'openai staff', 'security team', 'law enforcement'],
  override: ['ignore previous', 'disregard all', 'new instructions', 'forget your rules'],
  deferred: ['from now on', 'after n messages', 'next time', 'remember this', 'in the future', 'when you see the word'],
  hypothetical: ['hypothetically', 'in a story', 'for a novel', 'imagine that', 'for testing purposes'],
  tool: ['approvetransfer', 'function call', 'tool call', 'invoke the tool', 'json-rpc', 'tools/call'],
}
const hits = (t: string, family: keyof typeof PHRASES) =>
  PHRASES[family].some((p) => t.toLowerCase().includes(p))

const ZERO_WIDTH = /[​-‏⁠﻿]/
const NON_LATIN_LETTER = /[Ѐ-ӿ]/

function uniqueIds(items: { id: string }[]) {
  const ids = items.map((i) => i.id)
  expect(new Set(ids).size).toBe(ids.length)
}

describe('attacks.v1.json', () => {
  it('has unique ids and at least 60 cases', () => {
    uniqueIds(attacks)
    expect(attacks.length).toBeGreaterThanOrEqual(60)
  })

  it('covers all nine families with at least 5 cases each and the right level tag', () => {
    for (const f of DETECTOR_FAMILIES) {
      const own = attacks.filter((a) => a.family === f)
      expect(own.length, f).toBeGreaterThanOrEqual(5)
      for (const a of own) {
        expect(a.flaggedFromLevel).toBe(FLAGGED_FROM[f])
        expect(a.tags).toContain(f)
        expect(a.tags).toContain(a.variant)
      }
    }
  })

  it('includes zero-width, homoglyph, and encoded variants', () => {
    const zw = attacks.filter((a) => a.variant === 'zero_width')
    const hg = attacks.filter((a) => a.variant === 'homoglyph')
    expect(zw.length).toBeGreaterThanOrEqual(5)
    expect(hg.length).toBeGreaterThanOrEqual(5)
    for (const a of zw) expect(a.text).toMatch(ZERO_WIDTH)
    for (const a of hg) expect(a.text).toMatch(NON_LATIN_LETTER)
    for (const v of ['encoded_base64', 'encoded_hex', 'encoded_url', 'encoded_decimal'] as const) {
      expect(attacks.filter((a) => a.variant === v).length, v).toBeGreaterThanOrEqual(2)
    }
  })

  it('decode-family cases decode to at least 12 printable characters', () => {
    for (const a of attacks.filter((x) => x.variant.startsWith('encoded_'))) {
      const run =
        a.variant === 'encoded_base64'
          ? (a.text.match(/[A-Za-z0-9+/]{16,}={0,2}/)?.[0] ?? '')
          : a.variant === 'encoded_hex'
            ? (a.text.match(/(?:[0-9a-f]{2}){8,}/)?.[0] ?? '')
            : ''
      let decoded = ''
      if (a.variant === 'encoded_base64') decoded = Buffer.from(run, 'base64').toString('utf8')
      else if (a.variant === 'encoded_hex') decoded = Buffer.from(run, 'hex').toString('utf8')
      else if (a.variant === 'encoded_url') decoded = decodeURIComponent(a.text.replace(/^[^%]*?(?=%)/, ''))
      else decoded = String.fromCharCode(...(a.text.match(/\d+/g) ?? []).map(Number))
      expect(decoded.length, a.id).toBeGreaterThanOrEqual(12)
      expect(decoded, a.id).toMatch(/^[\x20-\x7e]+$/)
    }
  })
})

describe('benign.v1.json', () => {
  it('has unique ids and at least 150 cases', () => {
    uniqueIds(benign)
    expect(benign.length).toBeGreaterThanOrEqual(150)
    expect(new Set(benign.map((b) => b.text.toLowerCase())).size).toBeGreaterThanOrEqual(150)
  })

  it('includes every section 6.6 near-miss and the poisoner targets', () => {
    const all = benign.map((b) => b.text.toLowerCase())
    for (const phrase of [
      'root beer float fund',
      'override my autopay date',
      'what role does a savings account play',
      'pretend money games for kids',
      'administrator of my hoa',
      'thank you so much for the help',
      'can you please check my balance',
    ]) {
      expect(all.some((t) => t.includes(phrase)), phrase).toBe(true)
    }
    expect(benign.filter((b) => b.tags.includes('near_miss')).length).toBeGreaterThanOrEqual(20)
    expect(benign.filter((b) => b.tags.includes('poisoner_target')).length).toBeGreaterThanOrEqual(10)
  })

  it('contains no catalog attack phrase, zero-width character, or confusable script', () => {
    for (const b of benign) {
      expect(b.text, b.id).not.toMatch(ZERO_WIDTH)
      expect(b.text, b.id).not.toMatch(NON_LATIN_LETTER)
      for (const f of Object.keys(PHRASES) as (keyof typeof PHRASES)[]) {
        expect(hits(b.text, f), `${b.id} ${f}`).toBe(false)
      }
    }
  })
})

describe('loophole.v1.json', () => {
  it('has unique ids and at least 8 prompts for each of levels 1 to 3, tagged by level', () => {
    uniqueIds(loophole)
    for (const level of [1, 2, 3] as const) {
      const own = loophole.filter((l) => l.level === level)
      expect(own.length, `level ${level}`).toBeGreaterThanOrEqual(8)
      for (const l of own) expect(l.tags).toContain(`level_${level}`)
    }
  })

  it('uses each level route and passes the phrase catalog active at that level', () => {
    for (const l of loophole) {
      const t = l.text.toLowerCase()
      if (l.level === 1) expect(t, l.id).toMatch(/branch manager|manage this branch/)
      if (l.level === 1) expect(t, l.id).toMatch(/pig-mgr-\d{4}/)
      if (l.level === 2) expect(t, l.id).toContain('truffle')
      if (l.level === 3) expect(t, l.id).toContain('appointment')
      expect(l.text, l.id).not.toMatch(ZERO_WIDTH)
      const active: (keyof typeof PHRASES)[] =
        l.level === 1 ? [] : l.level === 2 ? ['roleplay'] : ['roleplay', 'authority', 'override']
      for (const f of active) expect(hits(l.text, f), `${l.id} ${f}`).toBe(false)
    }
  })
})

describe('traffic-sample.v1.json', () => {
  it('has unique ids and exactly 200 cases split 100 filter and 100 holdout', () => {
    uniqueIds(traffic)
    expect(traffic).toHaveLength(200)
    expect(traffic.filter((t) => t.split === 'filter')).toHaveLength(100)
    expect(traffic.filter((t) => t.split === 'holdout')).toHaveLength(100)
  })

  it('draws from at least 40 distinct synthetic authors, present in the filter half', () => {
    const authors = new Set(traffic.map((t) => t.authorId))
    expect(authors.size).toBeGreaterThanOrEqual(40)
    const filterAuthors = new Set(traffic.filter((t) => t.split === 'filter').map((t) => t.authorId))
    expect(filterAuthors.size).toBeGreaterThanOrEqual(40)
  })

  it('has unique texts', () => {
    expect(new Set(traffic.map((t) => t.text)).size).toBe(traffic.length)
  })
})

describe('all corpora', () => {
  it('have globally unique ids and no key-shaped or contact strings', () => {
    const everything = [...attacks, ...benign, ...loophole, ...traffic]
    uniqueIds(everything)
    for (const c of everything) {
      expect(c.text, c.id).not.toMatch(/sk-[A-Za-z0-9]{10,}|eyJ[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{12,}|ghp_[A-Za-z0-9]{10,}/)
      expect(c.text, c.id).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/)
      expect(c.text, c.id).not.toMatch(/https?:\/\//)
    }
  })
})
