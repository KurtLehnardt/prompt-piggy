#!/usr/bin/env node
/**
 * Loads the level 4 and 5 secret material into the service-role-only table
 * public.level_secrets (docs/ARCHITECTURE.md section 6.2, REVIEW-2 R2-12).
 *
 * OPERATOR ONLY. The repository is public, so the real level 4 and 5 policy,
 * fragments, tripwire threshold, Decisions predicate text, and extra detector
 * phrases never appear in it, in a pull request, or in a log. The operator
 * keeps them in the gitignored file .secrets/level-secrets.json and runs this
 * script against staging (for calibration) and production (at cut-over).
 *
 * What it does, in order:
 *   1. Reads LEVEL_SECRETS_FILE (default .secrets/level-secrets.json, relative
 *      to the current directory), or, with --placeholder-fixture, the
 *      committed placeholder fixture
 *      src/lib/config/__fixtures__/level-secrets.placeholder.json.
 *   2. Refuses an input file that git tracks, unless --placeholder-fixture
 *      selects the committed fixture explicitly. It also refuses when git
 *      cannot tell, so the check fails closed.
 *   3. Checks the payload shape: exactly the keys "4" and "5", each a payload
 *      of the shape of LevelSecretPayloadSchema in
 *      src/lib/config/level-secrets.ts. The CHECK constraint
 *      public.level_secret_payload_ok stays authoritative.
 *   4. Refuses a payload with "placeholder": true unless the Supabase URL
 *      (NEXT_PUBLIC_SUPABASE_URL) is local, that is, its host is localhost or
 *      127.0.0.1.
 *   5. Upserts levels 4 and 5 with payload_sha256 in one request, through the
 *      secret key (SUPABASE_SECRET_KEY, falling back to the legacy
 *      SUPABASE_SERVICE_ROLE_KEY).
 *
 * It prints only level ids and the first 12 hex characters of each payload
 * hash. It never prints a payload value, a key, the parse error of the input
 * file (which can quote the file), or the details of a database error (which
 * can quote the row).
 *
 * payload_sha256 is the sha256 (lowercase hex) of the payload's canonical
 * JSON: object keys sorted recursively in JavaScript's default sort order,
 * arrays in their order, no whitespace, and every scalar written by
 * JSON.stringify. The calibration report and preflight compare these hashes.
 *
 * Usage:
 *   node scripts/ops/seed-level-secrets.mjs [--dry-run]
 *   node scripts/ops/seed-level-secrets.mjs --placeholder-fixture [--dry-run]
 *   node scripts/ops/seed-level-secrets.mjs --help
 *
 * --dry-run runs every check and prints the hashes, but sends nothing; it
 * needs no key.
 *
 * Exit codes: 0 success, 1 refused (tracked file, invalid payload, placeholder
 * for a non-local URL, or a database error), 2 usage or configuration error.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(import.meta.url)
const REPO_ROOT = resolve(dirname(SCRIPT), '..', '..')

export const PLACEHOLDER_FIXTURE = resolve(REPO_ROOT, 'src/lib/config/__fixtures__/level-secrets.placeholder.json')
export const DEFAULT_LEVEL_SECRETS_FILE = '.secrets/level-secrets.json'
export const SECRET_LEVEL_IDS = Object.freeze(['4', '5'])

/**
 * The nine detector families, in the order of DETECTOR_FAMILIES in
 * src/lib/config/detector-families.ts. A unit test keeps the two lists equal.
 */
export const DETECTOR_FAMILIES = Object.freeze([
  'roleplay',
  'authority',
  'override',
  'delimiter',
  'decode',
  'tool',
  'deferred',
  'mixed_script',
  'hypothetical',
])

const PAYLOAD_KEYS = Object.freeze([
  'decisions_predicate_instructions',
  'extra_detector_phrases',
  'fragments',
  'placeholder',
  'policy',
  'schema_version',
  'tripwire_threshold',
])

/** The DetectorPhrase pattern of src/lib/config/level-secrets.ts. */
const DETECTOR_PHRASE = /^[a-z0-9]+(?:[ '-][a-z0-9]+){0,5}$/

/** The byte cap of public.level_secret_payload_ok, measured on jsonb's text form. */
const MAX_PAYLOAD_BYTES = 16384

const USAGE = `Usage:
  node scripts/ops/seed-level-secrets.mjs [--dry-run]
  node scripts/ops/seed-level-secrets.mjs --placeholder-fixture [--dry-run]

Reads LEVEL_SECRETS_FILE (default ${DEFAULT_LEVEL_SECRETS_FILE}) and upserts levels 4 and 5 into
public.level_secrets at NEXT_PUBLIC_SUPABASE_URL with SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY).
--placeholder-fixture loads the committed placeholder fixture instead; it is accepted only for a local URL.
--dry-run checks everything and prints the hashes without sending anything.`

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Canonical JSON: object keys sorted recursively, arrays in order, no
 * whitespace, scalars as JSON.stringify writes them.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (isPlainObject(value)) {
    const object = /** @type {Record<string, unknown>} */ (value)
    const members = Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    return `{${members.join(',')}}`
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number')
  if (value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  throw new TypeError(`canonicalJson: unsupported ${typeof value}`)
}

/**
 * The sha256 (lowercase hex) of the payload's canonical JSON.
 *
 * @param {unknown} payload
 * @returns {string}
 */
export function payloadSha256(payload) {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex')
}

/**
 * The byte length of the value in Postgres's jsonb text form, which separates
 * members with ", " and keys from values with ": ". Key order does not change
 * the length.
 *
 * @param {unknown} value
 * @returns {number}
 */
function jsonbTextBytes(value) {
  const text = (/** @type {unknown} */ item) => {
    if (Array.isArray(item)) return `[${item.map(text).join(', ')}]`
    if (isPlainObject(item)) {
      const object = /** @type {Record<string, unknown>} */ (item)
      return `{${Object.keys(object).map((key) => `${JSON.stringify(key)}: ${text(object[key])}`).join(', ')}}`
    }
    return JSON.stringify(item)
  }
  return Buffer.byteLength(text(value), 'utf8')
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 */
function isStringOfLength(value, min, max) {
  return typeof value === 'string' && value.length >= min && value.length <= max
}

/**
 * The problems with one level payload, as paths and rule names only, never
 * values. An empty list means the payload has the shape of
 * LevelSecretPayloadSchema. String lengths count UTF-16 code units, as zod
 * does.
 *
 * @param {unknown} payload
 * @param {string} [at]
 * @returns {string[]}
 */
export function payloadProblems(payload, at = '(payload)') {
  if (!isPlainObject(payload)) return [`${at}: must be an object`]
  const p = /** @type {Record<string, unknown>} */ (payload)
  const problems = []

  for (const key of Object.keys(p)) {
    if (!PAYLOAD_KEYS.includes(key)) problems.push(`${at}: unknown key ${JSON.stringify(key)}`)
  }
  for (const key of PAYLOAD_KEYS) {
    if (!(key in p)) problems.push(`${at}.${key}: missing`)
  }

  if ('schema_version' in p && p.schema_version !== 1) problems.push(`${at}.schema_version: must be 1`)
  if ('placeholder' in p && typeof p.placeholder !== 'boolean') problems.push(`${at}.placeholder: must be a boolean`)
  if ('policy' in p && !isStringOfLength(p.policy, 1, 600)) problems.push(`${at}.policy: must be a string of 1 to 600 characters`)

  if ('fragments' in p) {
    if (!Array.isArray(p.fragments) || p.fragments.length < 1 || p.fragments.length > 8) {
      problems.push(`${at}.fragments: must be an array of 1 to 8 strings`)
    } else {
      p.fragments.forEach((fragment, index) => {
        if (!isStringOfLength(fragment, 1, 400)) problems.push(`${at}.fragments.${index}: must be a string of 1 to 400 characters`)
      })
    }
  }

  if ('tripwire_threshold' in p) {
    const threshold = p.tripwire_threshold
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0.5 || threshold > 0.99) {
      problems.push(`${at}.tripwire_threshold: must be a number from 0.5 to 0.99`)
    }
  }

  if ('decisions_predicate_instructions' in p && !isStringOfLength(p.decisions_predicate_instructions, 40, 1500)) {
    problems.push(`${at}.decisions_predicate_instructions: must be a string of 40 to 1500 characters`)
  }

  if ('extra_detector_phrases' in p) {
    const extra = p.extra_detector_phrases
    if (!isPlainObject(extra)) {
      problems.push(`${at}.extra_detector_phrases: must be an object`)
    } else {
      for (const [family, phrases] of Object.entries(/** @type {Record<string, unknown>} */ (extra))) {
        const path = `${at}.extra_detector_phrases.${family}`
        if (!DETECTOR_FAMILIES.includes(family)) {
          problems.push(`${at}.extra_detector_phrases: unknown detector family ${JSON.stringify(family)}`)
        } else if (!Array.isArray(phrases) || phrases.length > 64) {
          problems.push(`${path}: must be an array of at most 64 phrases`)
        } else {
          phrases.forEach((phrase, index) => {
            if (!isStringOfLength(phrase, 3, 64) || !DETECTOR_PHRASE.test(/** @type {string} */ (phrase))) {
              problems.push(`${path}.${index}: must be 3 to 64 characters of 1 to 6 lowercase ASCII tokens`)
            }
          })
        }
      }
    }
  }

  if (problems.length === 0 && jsonbTextBytes(p) > MAX_PAYLOAD_BYTES) {
    problems.push(`${at}: larger than ${MAX_PAYLOAD_BYTES} bytes`)
  }
  return problems
}

/**
 * The problems with a whole secrets file: exactly the keys "4" and "5", each
 * a valid payload.
 *
 * @param {unknown} data
 * @returns {string[]}
 */
export function fileProblems(data) {
  if (!isPlainObject(data)) return ['(file): must be an object with the keys "4" and "5"']
  const file = /** @type {Record<string, unknown>} */ (data)
  const problems = []
  for (const key of Object.keys(file)) {
    if (!SECRET_LEVEL_IDS.includes(key)) problems.push(`(file): unknown key ${JSON.stringify(key)}; only "4" and "5" are allowed`)
  }
  for (const level of SECRET_LEVEL_IDS) {
    if (!(level in file)) problems.push(`(file).${level}: missing`)
    else problems.push(...payloadProblems(file[level], `(file).${level}`))
  }
  return problems
}

/**
 * True when the URL's host is localhost or 127.0.0.1.
 *
 * @param {string | undefined} url
 * @returns {boolean}
 */
export function isLocalSupabaseUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return false
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
}

/**
 * Whether git tracks the file: 'tracked', 'untracked', or 'unknown' when git
 * could not answer. A file outside any git working tree is untracked.
 *
 * @param {string} file an absolute path
 * @returns {'tracked' | 'untracked' | 'unknown'}
 */
export function gitTrackingOf(file) {
  let real
  try {
    real = realpathSync(file)
  } catch {
    real = file
  }
  const result = spawnSync('git', ['-C', dirname(real), 'ls-files', '--error-unmatch', '--', basename(real)], {
    encoding: 'utf8',
  })
  if (result.error) return 'unknown'
  if (result.status === 0) return 'tracked'
  // 1: the file is not in the index. 128: the directory is not in a git working tree.
  if (result.status === 1 || result.status === 128) return 'untracked'
  return 'unknown'
}

/**
 * @param {string[]} argv
 * @returns {{ dryRun: boolean, placeholderFixture: boolean, help: boolean, unknown: string[] }}
 */
export function parseArgs(argv) {
  const options = { dryRun: false, placeholderFixture: false, help: false, unknown: /** @type {string[]} */ ([]) }
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--placeholder-fixture') options.placeholderFixture = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else options.unknown.push(arg)
  }
  return options
}

/** @param {string} hash */
function hashPrefix(hash) {
  return hash.slice(0, 12)
}

/**
 * @typedef {object} SeedEnv
 * @property {string | undefined} LEVEL_SECRETS_FILE
 * @property {string | undefined} NEXT_PUBLIC_SUPABASE_URL
 * @property {string | undefined} SUPABASE_SECRET_KEY
 * @property {string | undefined} SUPABASE_SERVICE_ROLE_KEY
 */

/**
 * @typedef {object} SeedIo
 * @property {(line: string) => void} out
 * @property {(line: string) => void} err
 * @property {string} cwd
 */

/**
 * Upserts both rows in one PostgREST request, so they are written in one
 * statement, and returns the stored hashes. Only the level id and the hash
 * are read back, never the payload.
 *
 * @param {string} url
 * @param {string} key
 * @param {{ level_id: number, payload: unknown, payload_sha256: string }[]} rows
 * @returns {Promise<{ ok: true, stored: { level_id: number, payload_sha256: string }[] } | { ok: false, code: string }>}
 */
async function upsertLevelSecrets(url, key, rows) {
  const { createClient } = await import('@supabase/supabase-js')
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await client
    .from('level_secrets')
    .upsert(rows, { onConflict: 'level_id' })
    .select('level_id, payload_sha256')
  if (error) return { ok: false, code: typeof error.code === 'string' && error.code !== '' ? error.code : 'unknown' }
  return { ok: true, stored: data ?? [] }
}

/**
 * Runs the script. Returns the exit code.
 *
 * @param {string[]} argv
 * @param {SeedEnv} env
 * @param {SeedIo} io
 * @returns {Promise<number>}
 */
export async function main(argv, env, io) {
  const options = parseArgs(argv)
  if (options.help) {
    io.out(USAGE)
    return 0
  }
  if (options.unknown.length > 0) {
    io.err(`Unknown argument. ${USAGE}`)
    return 2
  }

  // 1 and 2: the input file, which git must not track.
  let file
  if (options.placeholderFixture) {
    if (env.LEVEL_SECRETS_FILE) {
      io.err('Refusing: --placeholder-fixture and LEVEL_SECRETS_FILE were both given. Choose one input.')
      return 2
    }
    file = PLACEHOLDER_FIXTURE
  } else {
    file = resolve(io.cwd, env.LEVEL_SECRETS_FILE || DEFAULT_LEVEL_SECRETS_FILE)
    const tracking = gitTrackingOf(file)
    if (tracking === 'tracked') {
      io.err(
        'Refusing: the input file is tracked by git, and this repository is public. Level 4 and 5 material lives only ' +
          'in a gitignored file such as .secrets/level-secrets.json (R2-12). To load the committed placeholders into a ' +
          'local database, use --placeholder-fixture.'
      )
      return 1
    }
    if (tracking === 'unknown') {
      io.err('Refusing: git could not tell whether the input file is tracked, so the public-repository check fails closed.')
      return 1
    }
  }

  if (!existsSync(file)) {
    io.err(`The input file does not exist. Set LEVEL_SECRETS_FILE or create ${DEFAULT_LEVEL_SECRETS_FILE}.`)
    return 2
  }

  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // The parse error can quote the file's contents, so it is not printed.
    io.err('Refusing: the input file is not valid JSON.')
    return 1
  }

  // 3: the payload shape.
  const problems = fileProblems(data)
  if (problems.length > 0) {
    io.err(`Refusing: the input file does not match LevelSecretPayloadSchema:\n  ${problems.join('\n  ')}`)
    return 1
  }

  // 4: placeholders go to local databases only.
  const url = env.NEXT_PUBLIC_SUPABASE_URL
  if (!url) {
    io.err('NEXT_PUBLIC_SUPABASE_URL is not set.')
    return 2
  }
  try {
    new URL(url)
  } catch {
    io.err('NEXT_PUBLIC_SUPABASE_URL is not a valid URL.')
    return 2
  }
  const placeholderLevels = SECRET_LEVEL_IDS.filter((level) => data[level].placeholder === true)
  if (placeholderLevels.length > 0 && !isLocalSupabaseUrl(url)) {
    io.err(
      `Refusing: level ${placeholderLevels.join(' and ')} ${placeholderLevels.length === 1 ? 'is a placeholder' : 'are placeholders'} ` +
        '("placeholder": true), and the Supabase URL is not local (localhost or 127.0.0.1). Placeholders are for local ' +
        'databases only.'
    )
    return 1
  }

  const rows = SECRET_LEVEL_IDS.map((level) => ({
    level_id: Number(level),
    payload: data[level],
    payload_sha256: payloadSha256(data[level]),
  }))

  if (options.dryRun) {
    io.out('Dry run: nothing was sent.')
    for (const row of rows) io.out(`level ${row.level_id} sha256:${hashPrefix(row.payload_sha256)}`)
    return 0
  }

  // 5: the upsert, through the secret key.
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) {
    io.err('SUPABASE_SECRET_KEY (or the legacy SUPABASE_SERVICE_ROLE_KEY) is not set.')
    return 2
  }

  let result
  try {
    result = await upsertLevelSecrets(url, key, rows)
  } catch {
    io.err('The upsert failed before the database answered (network or client error). Nothing is known to be written.')
    return 1
  }
  if (!result.ok) {
    // Only the SQLSTATE or PostgREST code: the message and details can quote the row.
    io.err(`The upsert was refused by the database (code ${result.code}). Nothing was written.`)
    return 1
  }

  for (const row of rows) {
    const stored = result.stored.find((entry) => entry.level_id === row.level_id)
    if (!stored || stored.payload_sha256 !== row.payload_sha256) {
      io.err(`The database did not confirm level ${row.level_id}.`)
      return 1
    }
    io.out(`level ${row.level_id} sha256:${hashPrefix(row.payload_sha256)}`)
  }
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  const env = {
    LEVEL_SECRETS_FILE: process.env.LEVEL_SECRETS_FILE,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  }
  const io = {
    out: (/** @type {string} */ line) => process.stdout.write(`${line}\n`),
    err: (/** @type {string} */ line) => process.stderr.write(`${line}\n`),
    cwd: process.cwd(),
  }
  main(process.argv.slice(2), env, io).then(
    (code) => {
      process.exitCode = code
    },
    () => {
      process.stderr.write('Unexpected internal error.\n')
      process.exitCode = 2
    }
  )
}
