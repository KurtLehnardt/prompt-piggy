import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DETECTOR_FAMILIES } from '@/lib/config/detector-families'
import { LevelSecretPayloadSchema } from '@/lib/config/level-secrets'
import {
  DETECTOR_FAMILIES as SCRIPT_DETECTOR_FAMILIES,
  PLACEHOLDER_FIXTURE,
  fileProblems,
  gitTrackingOf,
  isLocalSupabaseUrl,
  parseArgs,
  payloadProblems,
  payloadSha256,
} from '../../../scripts/ops/seed-level-secrets.mjs'

/**
 * scripts/ops/seed-level-secrets.mjs (docs/ARCHITECTURE.md section 6.2,
 * REVIEW-2 R2-12). Every payload here is synthetic. The script is run only
 * with --dry-run or without a key, so these tests never send anything.
 */
const ROOT = path.resolve(__dirname, '../../..')
const SCRIPT = path.join(ROOT, 'scripts/ops/seed-level-secrets.mjs')
const FIXTURE: Record<string, Record<string, unknown>> = JSON.parse(readFileSync(PLACEHOLDER_FIXTURE, 'utf8'))
const LOCAL_URL = 'http://127.0.0.1:54321'
const NON_LOCAL_URL = 'https://fake-project.supabase.invalid'

const scratch = mkdtempSync(path.join(tmpdir(), 'pp07-seed-script-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function synthetic(): Record<string, unknown> {
  return {
    schema_version: 1,
    placeholder: false,
    policy: 'Synthetic test policy that grants nothing.',
    fragments: ['Synthetic test fragment one.', 'Synthetic test fragment two.'],
    tripwire_threshold: 0.9,
    decisions_predicate_instructions: 'Synthetic test predicate text that is longer than forty characters.',
    extra_detector_phrases: { tool: ['synthetic tool phrase'] },
  }
}

/** Runs the script with a clean Supabase environment plus the given variables. */
function run(args: string[], vars: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const name of ['LEVEL_SECRETS_FILE', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
    delete env[name]
  }
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...env, ...vars } as NodeJS.ProcessEnv,
    encoding: 'utf8',
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

/** Every string value in the fixture, so a test can prove none is printed. */
function fixtureStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(fixtureStrings)
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(fixtureStrings)
  return []
}

function expectNoPayloadText(output: string) {
  for (const text of fixtureStrings(FIXTURE)) expect(output).not.toContain(text)
  expect(output).not.toMatch(/placeholder (?:level|roleplay|tool|deferred|authority|hypothetical|mixed)/i)
}

describe('the payload shape check mirrors LevelSecretPayloadSchema', () => {
  const mutations: [string, (p: Record<string, unknown>) => unknown][] = [
    ['the synthetic payload', (p) => p],
    ['an unknown key', (p) => ({ ...p, extra: true })],
    ['a missing key', (p) => ({ ...p, policy: undefined })],
    ['schema_version 2', (p) => ({ ...p, schema_version: 2 })],
    ['a string placeholder', (p) => ({ ...p, placeholder: 'true' })],
    ['an empty policy', (p) => ({ ...p, policy: '' })],
    ['a 600-character policy', (p) => ({ ...p, policy: 'p'.repeat(600) })],
    ['a 601-character policy', (p) => ({ ...p, policy: 'p'.repeat(601) })],
    ['no fragments', (p) => ({ ...p, fragments: [] })],
    ['8 fragments', (p) => ({ ...p, fragments: Array.from({ length: 8 }, (_, i) => `f${i}`) })],
    ['9 fragments', (p) => ({ ...p, fragments: Array.from({ length: 9 }, (_, i) => `f${i}`) })],
    ['a 400-character fragment', (p) => ({ ...p, fragments: ['f'.repeat(400)] })],
    ['a 401-character fragment', (p) => ({ ...p, fragments: ['f'.repeat(401)] })],
    ['an empty fragment', (p) => ({ ...p, fragments: [''] })],
    ['a threshold of 0.5', (p) => ({ ...p, tripwire_threshold: 0.5 })],
    ['a threshold of 0.99', (p) => ({ ...p, tripwire_threshold: 0.99 })],
    ['a threshold of 0.49', (p) => ({ ...p, tripwire_threshold: 0.49 })],
    ['a threshold of 0.991', (p) => ({ ...p, tripwire_threshold: 0.991 })],
    ['a string threshold', (p) => ({ ...p, tripwire_threshold: '0.9' })],
    ['39 characters of predicate text', (p) => ({ ...p, decisions_predicate_instructions: 'd'.repeat(39) })],
    ['1500 characters of predicate text', (p) => ({ ...p, decisions_predicate_instructions: 'd'.repeat(1500) })],
    ['1501 characters of predicate text', (p) => ({ ...p, decisions_predicate_instructions: 'd'.repeat(1501) })],
    ['no extra phrases', (p) => ({ ...p, extra_detector_phrases: {} })],
    ['an unknown detector family', (p) => ({ ...p, extra_detector_phrases: { jailbreak: ['synthetic phrase'] } })],
    ['an uppercase phrase', (p) => ({ ...p, extra_detector_phrases: { tool: ['Synthetic Phrase'] } })],
    ['a 64-character phrase', (p) => ({ ...p, extra_detector_phrases: { tool: [`${'a'.repeat(30)} ${'b'.repeat(33)}`] } })],
    ['a 65-character phrase', (p) => ({ ...p, extra_detector_phrases: { tool: [`${'a'.repeat(30)} ${'b'.repeat(34)}`] } })],
    ['a 2-character phrase', (p) => ({ ...p, extra_detector_phrases: { tool: ['ab'] } })],
    ['a 7-token phrase', (p) => ({ ...p, extra_detector_phrases: { tool: ['a b c d e f g'] } })],
    ['64 phrases', (p) => ({ ...p, extra_detector_phrases: { tool: Array.from({ length: 64 }, (_, i) => `phrase ${i}`) } })],
    ['65 phrases', (p) => ({ ...p, extra_detector_phrases: { tool: Array.from({ length: 65 }, (_, i) => `phrase ${i}`) } })],
    ['phrases that are not an array', (p) => ({ ...p, extra_detector_phrases: { tool: 'synthetic phrase' } })],
    ['every detector family', (p) => ({ ...p, extra_detector_phrases: Object.fromEntries(DETECTOR_FAMILIES.map((f) => [f, ['synthetic phrase']])) })],
    ['an array payload', () => []],
    ['a null payload', () => null],
  ]

  it.each(mutations)('agrees with zod on %s', (_name, mutate) => {
    const payload = JSON.parse(JSON.stringify(mutate(synthetic()) ?? null))
    expect(payloadProblems(payload).length === 0).toBe(LevelSecretPayloadSchema.safeParse(payload).success)
  })

  it('accepts both placeholder fixture payloads', () => {
    expect(fileProblems(FIXTURE)).toEqual([])
  })

  it('needs exactly the keys "4" and "5"', () => {
    expect(fileProblems({ '4': FIXTURE['4'] })).toEqual(['(file).5: missing'])
    expect(fileProblems({ ...FIXTURE, '3': FIXTURE['4'] })).toHaveLength(1)
  })

  it('names paths, never values', () => {
    const problems = payloadProblems({ ...synthetic(), policy: 'S'.repeat(700), fragments: ['secret-looking text '.repeat(30)] })
    expect(problems.join('\n')).not.toContain('SSSS')
    expect(problems.join('\n')).not.toContain('secret-looking')
    expect(problems).toEqual([
      '(payload).policy: must be a string of 1 to 600 characters',
      '(payload).fragments.0: must be a string of 1 to 400 characters',
    ])
  })

  it('uses the detector families of src/lib/config/detector-families.ts', () => {
    expect([...SCRIPT_DETECTOR_FAMILIES]).toEqual([...DETECTOR_FAMILIES])
  })
})

describe('helpers', () => {
  it('treats only localhost and 127.0.0.1 as local', () => {
    expect(isLocalSupabaseUrl('http://127.0.0.1:54321')).toBe(true)
    expect(isLocalSupabaseUrl('http://localhost:54321')).toBe(true)
    expect(isLocalSupabaseUrl('https://localhost')).toBe(true)
    expect(isLocalSupabaseUrl(NON_LOCAL_URL)).toBe(false)
    expect(isLocalSupabaseUrl('http://localhost.example.invalid')).toBe(false)
    expect(isLocalSupabaseUrl('http://127.0.0.1.example.invalid')).toBe(false)
    expect(isLocalSupabaseUrl('http://10.0.0.5:54321')).toBe(false)
    expect(isLocalSupabaseUrl('ftp://localhost')).toBe(false)
    expect(isLocalSupabaseUrl('not a url')).toBe(false)
    expect(isLocalSupabaseUrl('')).toBe(false)
    expect(isLocalSupabaseUrl(undefined)).toBe(false)
  })

  it('parses its flags and collects unknown arguments', () => {
    expect(parseArgs(['--dry-run', '--placeholder-fixture'])).toEqual({
      dryRun: true,
      placeholderFixture: true,
      help: false,
      unknown: [],
    })
    expect(parseArgs(['--force']).unknown).toEqual(['--force'])
  })

  it('knows that git tracks the fixture and not a scratch file', () => {
    expect(gitTrackingOf(PLACEHOLDER_FIXTURE)).toBe('tracked')
    const file = path.join(scratch, 'untracked.json')
    writeFileSync(file, '{}')
    expect(gitTrackingOf(file)).toBe('untracked')
  })

  it('hashes key order away', () => {
    const payload = synthetic()
    const reordered = Object.fromEntries(Object.entries(payload).reverse())
    expect(payloadSha256(reordered)).toBe(payloadSha256(payload))
    expect(payloadSha256(payload)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('running the script', () => {
  it('loads the placeholder fixture for a local URL in a dry run and prints only level ids and hash prefixes', () => {
    const { status, output } = run(['--placeholder-fixture', '--dry-run'], { NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL })
    expect(status).toBe(0)
    const lines = output.trim().split('\n')
    expect(lines).toEqual([
      'Dry run: nothing was sent.',
      `level 4 sha256:${payloadSha256(FIXTURE['4']).slice(0, 12)}`,
      `level 5 sha256:${payloadSha256(FIXTURE['5']).slice(0, 12)}`,
    ])
    expectNoPayloadText(output)
  })

  it('refuses the placeholder fixture for a non-local URL', () => {
    const { status, output } = run(['--placeholder-fixture', '--dry-run'], { NEXT_PUBLIC_SUPABASE_URL: NON_LOCAL_URL })
    expect(status).toBe(1)
    expect(output).toContain('the Supabase URL is not local')
    expectNoPayloadText(output)
  })

  it('refuses a placeholder payload from a file for a non-local URL', () => {
    const file = path.join(scratch, 'placeholder.json')
    writeFileSync(file, JSON.stringify({ '4': { ...synthetic(), placeholder: true }, '5': synthetic() }))
    const { status, output } = run(['--dry-run'], { LEVEL_SECRETS_FILE: file, NEXT_PUBLIC_SUPABASE_URL: NON_LOCAL_URL })
    expect(status).toBe(1)
    expect(output).toContain('level 4 is a placeholder')
  })

  it('accepts a non-placeholder file for a non-local URL in a dry run', () => {
    const file = path.join(scratch, 'real-shaped.json')
    writeFileSync(file, JSON.stringify({ '4': synthetic(), '5': synthetic() }))
    const { status, output } = run(['--dry-run'], { LEVEL_SECRETS_FILE: file, NEXT_PUBLIC_SUPABASE_URL: NON_LOCAL_URL })
    expect(status).toBe(0)
    expect(output).not.toContain('Synthetic test')
  })

  it('refuses an input file that git tracks', () => {
    const { status, output } = run(['--dry-run'], {
      LEVEL_SECRETS_FILE: 'src/lib/config/__fixtures__/level-secrets.placeholder.json',
      NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL,
    })
    expect(status).toBe(1)
    expect(output).toContain('tracked by git')
    expectNoPayloadText(output)
  })

  it('refuses an invalid payload and names only the failing paths', () => {
    const file = path.join(scratch, 'invalid.json')
    writeFileSync(file, JSON.stringify({ '4': { ...synthetic(), tripwire_threshold: 0.2 }, '5': synthetic() }))
    const { status, output } = run(['--dry-run'], { LEVEL_SECRETS_FILE: file, NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL })
    expect(status).toBe(1)
    expect(output).toContain('(file).4.tripwire_threshold')
    expect(output).not.toContain('0.2')
    expect(output).not.toContain('Synthetic test')
  })

  it('refuses a file that is not JSON without quoting it', () => {
    const file = path.join(scratch, 'broken.json')
    writeFileSync(file, '{"4": Synthetic unquoted text')
    const { status, output } = run(['--dry-run'], { LEVEL_SECRETS_FILE: file, NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL })
    expect(status).toBe(1)
    expect(output).not.toContain('Synthetic')
  })

  it('refuses --placeholder-fixture together with LEVEL_SECRETS_FILE', () => {
    const { status } = run(['--placeholder-fixture', '--dry-run'], {
      LEVEL_SECRETS_FILE: path.join(scratch, 'real-shaped.json'),
      NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL,
    })
    expect(status).toBe(2)
  })

  it('needs the Supabase URL even for a dry run', () => {
    expect(run(['--placeholder-fixture', '--dry-run']).status).toBe(2)
  })

  it('needs the secret key for a real run and sends nothing without it', () => {
    const { status, output } = run(['--placeholder-fixture'], { NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL })
    expect(status).toBe(2)
    expect(output).toContain('SUPABASE_SECRET_KEY')
  })

  it('rejects an unknown argument', () => {
    expect(run(['--force']).status).toBe(2)
  })

  it('reports a missing default file', () => {
    const { status } = run(['--dry-run'], { LEVEL_SECRETS_FILE: path.join(scratch, 'absent.json'), NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL })
    expect(status).toBe(2)
  })
})
