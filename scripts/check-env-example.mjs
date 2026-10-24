#!/usr/bin/env node
/**
 * Keeps .env.example complete, empty, and the only committed env file
 * (CHANGES-2 CH2-3, ARCHITECTURE section 13, T30).
 *
 * It fails when:
 *   - .env.example does not list exactly the names in SECTION_13_NAMES, the
 *     table in ARCHITECTURE section 13 (revision 2), which includes
 *     LIVE_VIEW_TOKEN and both the new and the legacy Supabase key names. A
 *     retired name such as OPENAI_DECISIONS_FALLBACK therefore fails too;
 *   - code under src/ or scripts/ reads an environment variable that
 *     .env.example does not list, except the platform-provided names in
 *     PLATFORM_NAMES and PLATFORM_PREFIXES;
 *   - either name of a Supabase key pair is missing, or the legacy name comes
 *     before the new one (the app reads the new name first; see
 *     src/lib/supabase/env.ts and env.server.ts);
 *   - .env.example holds a value, a duplicate name, or a line that is neither
 *     a comment nor NAME=;
 *   - git tracks any .env* file other than the root .env.example.
 *
 * A read is process.env.NAME, process.env['NAME'], or a destructuring
 * assignment from process.env, outside comments. A dotted mention inside a
 * quoted string, such as a test title, is not a read. Computed reads such as
 * process.env[name] cannot be resolved statically and are not counted.
 *
 * Usage:
 *   node scripts/check-env-example.mjs               check this repository
 *   node scripts/check-env-example.mjs --root <dir>  check another git working tree
 *   node scripts/check-env-example.mjs --self-test   prove the check fails on violating fixtures
 *
 * Exit codes: 0 pass, 1 violation, 2 usage or internal error.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(import.meta.url)
const REPO_ROOT = resolve(dirname(SCRIPT), '..')

const SCAN_PREFIXES = ['src/', 'scripts/']
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/

/** Set by Node, CI, Vercel, GitHub Actions, or Playwright, never by hand (ARCHITECTURE section 13). */
const PLATFORM_NAMES = new Set([
  'NODE_ENV',
  'CI',
  'VERCEL',
  'VERCEL_ENV',
  'VERCEL_URL',
  'VERCEL_BRANCH_URL',
  'VERCEL_GIT_COMMIT_SHA',
  'VERCEL_AUTOMATION_BYPASS_SECRET',
  'TZ',
  'UPDATE_SCHEMA',
  'RUNNER_TEMP',
])
const PLATFORM_PREFIXES = ['GITHUB_', 'PLAYWRIGHT_']

/**
 * ARCHITECTURE section 13 (revision 2), in table order. Changing this list
 * means changing section 13 and .env.example in the same pull request.
 */
const SECTION_13_NAMES = [
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'OPENAI_API_KEY',
  'CRON_SECRET',
  'LIVE_VIEW_TOKEN',
  'ADMIN_EMAILS',
  'SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID',
  'SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET',
  'OPENAI_CORE_MODEL',
  'OPENAI_HARDENING_MODEL',
  'OPENAI_DECISIONS_MODEL',
  'OPENAI_REASONING_EFFORT',
  'OPENAI_CORE_MAX_OUTPUT_TOKENS',
  'OPENAI_HARDENING_MAX_OUTPUT_TOKENS',
  'OPENAI_DAILY_SPEND_CAP_USD',
  'OPENAI_ATTEMPT_SPEND_SHARE_PCT',
  'PIGGY_KILL_SWITCH',
  'RATE_LIMIT_ATTEMPTS_PER_MIN',
  'RATE_LIMIT_BURST',
  'RATE_LIMIT_ATTEMPTS_PER_DAY',
  'RATE_LIMIT_WALLET_PER_MIN',
  'MAX_PROMPT_CHARS',
  'HARDENING_MAX_JOBS_PER_HOUR',
  'HARDENING_MAX_JOBS_PER_USER_PER_HOUR',
  'HARDENING_TRAFFIC_WINDOW',
  'HARDENING_TRAFFIC_MAX_BPS',
  'RAW_PROMPT_RETENTION_DAYS',
  'PAYMENTS_MODE',
  'E2E_TEST_MODE',
  'ALLOW_E2E_TEST_MODE',
  'CALIBRATE',
  'CALIBRATION_PROMPTS_FILE',
  'LEVEL_SECRETS_FILE',
]

/** Each pair is [new name, legacy fallback]. Both must be listed, new name first. */
const KEY_PAIRS = [
  ['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
  ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
]

const NAME = '[A-Za-z_][A-Za-z0-9_]*'
const DOT_READ = new RegExp(`\\bprocess\\.env\\??\\.(${NAME})`, 'g')
const BRACKET_READ = new RegExp(`\\bprocess\\.env\\??\\.?\\[\\s*['"\`](${NAME})['"\`]\\s*\\]`, 'g')
const DESTRUCTURE = /\{([^{}]*)\}\s*=\s*process\.env\b/g

function isPlatformName(name) {
  return PLATFORM_NAMES.has(name) || PLATFORM_PREFIXES.some((prefix) => name.startsWith(prefix))
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
}

/** Removes single- and double-quoted string literals that end on the same line. */
function stripQuotedStrings(code) {
  return code.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''")
}

/** Every environment variable name the source reads statically. */
function envReads(source) {
  const code = stripComments(source)
  const names = new Set()
  // Bracket reads carry the name in quotes, so they are found before strings are removed.
  for (const match of code.matchAll(BRACKET_READ)) names.add(match[1])
  for (const match of stripQuotedStrings(code).matchAll(DOT_READ)) names.add(match[1])
  for (const match of code.matchAll(DESTRUCTURE)) {
    for (const part of match[1].split(',')) {
      const key = part.split(/[:=]/)[0].trim().replace(/^\.\.\./, '')
      if (new RegExp(`^${NAME}$`).test(key)) names.add(key)
    }
  }
  return names
}

function gitFiles(root, { untracked }) {
  const args = ['ls-files', '-z', '--cached']
  if (untracked) args.push('--others', '--exclude-standard')
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`git ls-files failed in ${root}: ${result.stderr.trim()}`)
  return [...new Set(result.stdout.split('\0').filter(Boolean))].sort()
}

/** Parses .env.example into its names, in order, and the problems found on the way. */
function parseEnvExample(text) {
  const names = []
  const problems = []
  text.split('\n').forEach((rawLine, index) => {
    const line = rawLine.replace(/\r$/, '')
    if (line.trim() === '' || line.trimStart().startsWith('#')) return
    const match = new RegExp(`^(${NAME})=(.*)$`).exec(line)
    if (!match) {
      problems.push(`.env.example:${index + 1} is neither a comment nor NAME=.`)
      return
    }
    const [, name, value] = match
    if (value.trim() !== '') problems.push(`.env.example:${index + 1} gives ${name} a value. Only names may be committed.`)
    if (names.includes(name)) problems.push(`.env.example:${index + 1} lists ${name} a second time.`)
    names.push(name)
  })
  return { names, problems }
}

function check(root) {
  const failures = []

  const tracked = gitFiles(root, { untracked: false })
  for (const path of tracked) {
    if (basename(path).startsWith('.env') && path !== '.env.example') {
      failures.push(`git tracks ${path}. Only the root .env.example may be committed; untrack the file and keep values in .env.local or the Vercel project settings.`)
    }
  }

  const examplePath = join(root, '.env.example')
  let listed = []
  if (!existsSync(examplePath)) {
    failures.push('.env.example is missing.')
  } else {
    const { names, problems } = parseEnvExample(readFileSync(examplePath, 'utf8'))
    listed = names
    failures.push(...problems)
    for (const name of SECTION_13_NAMES) {
      if (!names.includes(name)) failures.push(`.env.example is missing ${name}, which ARCHITECTURE section 13 lists.`)
    }
    for (const name of names) {
      if (!SECTION_13_NAMES.includes(name)) {
        failures.push(`.env.example lists ${name}, which ARCHITECTURE section 13 does not (a retired or unknown name).`)
      }
    }
    for (const [current, legacy] of KEY_PAIRS) {
      for (const name of [current, legacy]) {
        if (!names.includes(name)) failures.push(`.env.example is missing ${name}. Both ${current} and its legacy fallback ${legacy} must be listed.`)
      }
      if (names.includes(current) && names.includes(legacy) && names.indexOf(legacy) < names.indexOf(current)) {
        failures.push(`.env.example lists ${legacy} before ${current}. The new name comes first, then the legacy fallback.`)
      }
    }
  }

  const readBy = new Map()
  let scanned = 0
  for (const path of gitFiles(root, { untracked: true })) {
    if (!SCAN_PREFIXES.some((prefix) => path.startsWith(prefix)) || !CODE_FILE.test(path)) continue
    const full = join(root, path)
    if (!existsSync(full) || !statSync(full).isFile()) continue
    scanned++
    for (const name of envReads(readFileSync(full, 'utf8'))) {
      if (isPlatformName(name)) continue
      if (!readBy.has(name)) readBy.set(name, [])
      readBy.get(name).push(path)
    }
  }
  for (const [name, paths] of [...readBy].sort(([a], [b]) => a.localeCompare(b))) {
    if (!listed.includes(name)) failures.push(`${name} is read by ${paths.join(', ')} but is not listed in .env.example.`)
  }

  console.log(`.env.example lists ${listed.length} names; ${scanned} files under ${SCAN_PREFIXES.join(' and ')} read ${readBy.size} non-platform names.`)
  for (const failure of failures) console.error(`FAIL  ${failure}`)
  if (failures.length > 0) {
    console.error(`\n${failures.length} env template problem(s).`)
    return 1
  }
  console.log('.env.example guard passed.')
  return 0
}

// ---------------------------------------------------------------------------
// Self-test: every case runs this script against a fixture repository created
// in the system temp directory, outside this repository. The reads are
// assembled at run time so this file's own scan never sees the fixture names.
// ---------------------------------------------------------------------------

const ENV = ['process', 'env'].join('.')
const CLEAN_EXAMPLE = ['# names only', ...SECTION_13_NAMES.map((name) => `${name}=`), ''].join('\n')
const CLEAN_SOURCE = [
  `export const url = ${ENV}.NEXT_PUBLIC_APP_URL`,
  `export const key = ${ENV}['SUPABASE_SECRET_KEY']`,
  `export const platform = [${ENV}.NODE_ENV, ${ENV}.VERCEL_URL, ${ENV}.GITHUB_SHA, ${ENV}.PLAYWRIGHT_PORT]`,
  `export const title = 'reads each variable with a literal ${ENV}.NAME expression'`,
  '',
].join('\n')

const SELF_TEST_CASES = [
  {
    name: 'a name read in src/ but missing from .env.example is rejected',
    expect: 1,
    files: { '.env.example': CLEAN_EXAMPLE, 'src/lib/a.ts': `export const x = ${ENV}.UNLISTED_SETTING\n` },
  },
  {
    name: 'a destructured name read in scripts/ but missing from .env.example is rejected',
    expect: 1,
    files: { '.env.example': CLEAN_EXAMPLE, 'scripts/ops/b.mjs': `const { NEXT_PUBLIC_APP_URL, UNLISTED_FILE } = ${ENV}\n` },
  },
  {
    name: 'a value in .env.example is rejected',
    expect: 1,
    files: { '.env.example': CLEAN_EXAMPLE.replace('NEXT_PUBLIC_APP_URL=', 'NEXT_PUBLIC_APP_URL=http://localhost:3000') },
  },
  {
    name: 'a missing legacy key name is rejected',
    expect: 1,
    files: { '.env.example': CLEAN_EXAMPLE.replace('SUPABASE_SERVICE_ROLE_KEY=\n', '') },
  },
  {
    name: 'a retired name in .env.example is rejected',
    expect: 1,
    files: { '.env.example': `${CLEAN_EXAMPLE}OPENAI_DECISIONS_FALLBACK=\n` },
  },
  {
    name: 'a section 13 name missing from .env.example is rejected',
    expect: 1,
    files: { '.env.example': CLEAN_EXAMPLE.replace('LIVE_VIEW_TOKEN=\n', '') },
  },
  {
    name: 'a missing new key name is rejected',
    expect: 1,
    files: { '.env.example': CLEAN_EXAMPLE.replace('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=\n', '') },
  },
  {
    name: 'a tracked .env file other than .env.example is rejected',
    expect: 1,
    files: { '.env.example': CLEAN_EXAMPLE, '.env.production': '# empty\n' },
  },
  {
    name: 'a complete, empty .env.example with platform reads passes',
    expect: 0,
    files: { '.env.example': CLEAN_EXAMPLE, 'src/lib/a.ts': CLEAN_SOURCE, 'scripts/c.mjs': `const { NEXT_PUBLIC_APP_URL: url } = ${ENV}\n` },
  },
]

function fixtureEnv() {
  const env = { ...process.env }
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name]
  return env
}

function runGit(cwd, args) {
  const result = spawnSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', env: fixtureEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
}

function writeFixture(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  runGit(dir, ['init', '--quiet'])
  // --force, so a global gitignore on the machine cannot leave a fixture file untracked.
  runGit(dir, ['add', '--all', '--force'])
}

function selfTest(cases) {
  if (!cases.some((testCase) => testCase.expect === 1)) throw new Error('The self-test has no violating case.')
  let failures = 0
  for (const testCase of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'prompt-piggy-guardrail-'))
    try {
      const fromRepo = relative(REPO_ROOT, dir)
      if (!fromRepo.startsWith('..') && !isAbsolute(fromRepo)) {
        throw new Error(`The fixture directory ${dir} is inside the repository.`)
      }
      writeFixture(dir, testCase.files)
      const result = spawnSync(process.execPath, [SCRIPT, '--root', dir], { encoding: 'utf8', env: fixtureEnv() })
      if (result.status === testCase.expect) {
        console.log(`ok    ${testCase.name} (exit ${result.status})`)
      } else {
        failures++
        console.error(`FAIL  ${testCase.name}: expected exit ${testCase.expect}, got ${result.status ?? result.signal}`)
        console.error(`${result.stdout}${result.stderr}`.replace(/^/gm, '      '))
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  if (failures > 0) {
    console.error(`\nSelf-test failed: ${failures} of ${cases.length} case(s).`)
    return 1
  }
  console.log(`\nSelf-test passed: ${cases.length} case(s).`)
  return 0
}

function parseArgs(argv) {
  const args = { selfTest: false, root: REPO_ROOT }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--self-test') args.selfTest = true
    else if (argv[i] === '--root' && argv[i + 1]) args.root = resolve(argv[++i])
    else throw new Error(`Unknown or incomplete argument: ${argv[i]}`)
  }
  return args
}

try {
  const args = parseArgs(process.argv.slice(2))
  process.exitCode = args.selfTest ? selfTest(SELF_TEST_CASES) : check(args.root)
} catch (error) {
  console.error(`check-env-example: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}
