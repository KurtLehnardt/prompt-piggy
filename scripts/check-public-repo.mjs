#!/usr/bin/env node
/**
 * Fails when git tracks a file that must never be published in this public
 * repository (CHANGES-2 CH2-3; ARCHITECTURE section 11, T30 and T31; REVIEW-2
 * R2-12). It moved here from PP-28 so it guards every later pull request.
 *
 * It fails when git ls-files lists:
 *   - any .env* file other than the root .env.example;
 *   - any file under a .secrets/ or .calibration/ directory;
 *   - a file named level-secrets.json or level-secrets.*.json, except the
 *     placeholder fixture src/lib/config/__fixtures__/level-secrets.placeholder.json,
 *     and that fixture only while every level in it has "placeholder": true;
 *   - a file named like known-wins.json, except the calibration schema and
 *     example under src/lib/ai/calibration/ (known-wins.schema.json and
 *     known-wins.example.json);
 *   - a file whose path contains breach-export;
 *   - calibration-report.json, which the conventions also list as never
 *     committed.
 *
 * It reads only file names, plus the placeholder fixture, and never prints a
 * file's contents.
 *
 * Usage:
 *   node scripts/check-public-repo.mjs               check this repository
 *   node scripts/check-public-repo.mjs --root <dir>  check another git working tree
 *   node scripts/check-public-repo.mjs --self-test   prove the check fails on violating fixtures
 *
 * Exit codes: 0 pass, 1 violation, 2 usage or internal error.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(import.meta.url)
const REPO_ROOT = resolve(dirname(SCRIPT), '..')

const PLACEHOLDER_FIXTURE = 'src/lib/config/__fixtures__/level-secrets.placeholder.json'
const CALIBRATION_DIR = 'src/lib/ai/calibration/'
const KNOWN_WINS_ALLOWED = new Set(['known-wins.schema.json', 'known-wins.example.json'])
const LEVEL_SECRETS_NAME = /^level-secrets(?:\..+)?\.json$/i
const KNOWN_WINS_NAME = /known[-_]?wins/i
/** Keys that only a level 4 or 5 secret payload has (ARCHITECTURE section 6.2, LevelSecretPayloadSchema). */
const PAYLOAD_KEYS = ['policy', 'fragments', 'tripwire_threshold', 'decisions_predicate_instructions', 'extra_detector_phrases']

function gitTracked(root) {
  const result = spawnSync('git', ['ls-files', '-z', '--cached'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`git ls-files failed in ${root}: ${result.stderr.trim()}`)
  return [...new Set(result.stdout.split('\0').filter(Boolean))].sort()
}

/**
 * Problems with the placeholder fixture: every object that looks like a level
 * payload, and every object that has a placeholder key, must have
 * placeholder === true, and at least one level must be present.
 */
function placeholderProblems(root) {
  const full = join(root, PLACEHOLDER_FIXTURE)
  if (!existsSync(full)) return []
  let data
  try {
    data = JSON.parse(readFileSync(full, 'utf8'))
  } catch {
    return [`${PLACEHOLDER_FIXTURE} is not valid JSON, so its placeholder flags cannot be checked.`]
  }
  const problems = []
  let levels = 0
  const visit = (value, at) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${at}[${index}]`))
      return
    }
    if (value === null || typeof value !== 'object') return
    const isPayload = PAYLOAD_KEYS.some((key) => key in value)
    if (isPayload) levels++
    if ((isPayload || 'placeholder' in value) && value.placeholder !== true) {
      problems.push(`${PLACEHOLDER_FIXTURE} has an entry at ${at || '(top level)'} without "placeholder": true. Real level 4 and 5 material lives only in the level_secrets table (R2-12).`)
    }
    for (const [key, child] of Object.entries(value)) visit(child, at ? `${at}.${key}` : key)
  }
  visit(data, '')
  if (levels === 0) problems.push(`${PLACEHOLDER_FIXTURE} contains no level entry, so "placeholder": true cannot be confirmed for every level.`)
  return problems
}

function check(root) {
  const failures = []
  const tracked = gitTracked(root)
  for (const path of tracked) {
    const name = posix.basename(path)
    const segments = path.split('/')
    if (name.startsWith('.env') && path !== '.env.example') {
      failures.push(`${path}: only the root .env.example may be committed; every other .env* file holds values.`)
    }
    if (segments.includes('.secrets')) {
      failures.push(`${path}: .secrets/ holds level 4 and 5 secret material and stays on the operator's machine (R2-12).`)
    }
    if (segments.includes('.calibration')) {
      failures.push(`${path}: .calibration/ holds known-win prompts and stays local (CH2-3).`)
    }
    if (LEVEL_SECRETS_NAME.test(name) && path !== PLACEHOLDER_FIXTURE) {
      failures.push(`${path}: level secret files are never committed; only ${PLACEHOLDER_FIXTURE} is allowed (R2-12).`)
    }
    if (KNOWN_WINS_NAME.test(name) && !(path.startsWith(CALIBRATION_DIR) && KNOWN_WINS_ALLOWED.has(name))) {
      failures.push(`${path}: known-win prompts come from a gitignored local file; only the calibration schema and example are committed (CH2-3).`)
    }
    if (/breach-export/i.test(path)) {
      failures.push(`${path}: breach exports contain real attack prompts, which live only in the database (CH2-3).`)
    }
    if (name === 'calibration-report.json') {
      failures.push(`${path}: the calibration report stays local (conventions.git_rules.never_commit).`)
    }
  }
  if (tracked.includes(PLACEHOLDER_FIXTURE)) failures.push(...placeholderProblems(root))

  console.log(`Checked ${tracked.length} tracked files for material that must stay out of this public repository.`)
  for (const failure of failures) console.error(`FAIL  ${failure}`)
  if (failures.length > 0) {
    console.error(`\n${failures.length} public-repository violation(s). Untrack the file (git rm --cached) and keep it local.`)
    return 1
  }
  console.log('Public repository guard passed.')
  return 0
}

// ---------------------------------------------------------------------------
// Self-test: every case runs this script against a fixture repository created
// in the system temp directory, outside this repository. Every fixture value
// is synthetic.
// ---------------------------------------------------------------------------

const placeholderLevel = (placeholder) => ({
  schema_version: 1,
  placeholder,
  policy: 'placeholder policy text',
  fragments: ['placeholder fragment'],
  tripwire_threshold: 0.9,
  decisions_predicate_instructions: 'placeholder instructions that are long enough to pass the schema',
  extra_detector_phrases: {},
})
const placeholderFixture = (level5Placeholder) =>
  `${JSON.stringify({ levels: { 4: placeholderLevel(true), 5: placeholderLevel(level5Placeholder) } }, null, 2)}\n`

const SELF_TEST_CASES = [
  { name: 'a tracked .env.local is rejected', expect: 1, files: { '.env.local': '# synthetic\n' } },
  { name: 'a file under .secrets/ is rejected', expect: 1, files: { '.secrets/level-secrets.json': '{}\n' } },
  { name: 'a file under .calibration/ is rejected', expect: 1, files: { '.calibration/notes.txt': 'synthetic\n' } },
  { name: 'a level-secrets.*.json outside the fixture path is rejected', expect: 1, files: { 'src/lib/config/level-secrets.prod.json': '{}\n' } },
  {
    name: 'a placeholder fixture with a level that is not a placeholder is rejected',
    expect: 1,
    files: { [PLACEHOLDER_FIXTURE]: placeholderFixture(false) },
  },
  { name: 'a known-wins file outside the calibration schema and example is rejected', expect: 1, files: { 'data/known-wins.json': '[]\n' } },
  { name: 'a breach export is rejected', expect: 1, files: { 'exports/2026-10-24-breach-export.csv': 'synthetic\n' } },
  {
    name: 'the env template, placeholder fixture, and calibration schema and example pass',
    expect: 0,
    files: {
      '.env.example': 'NEXT_PUBLIC_APP_URL=\n',
      [PLACEHOLDER_FIXTURE]: placeholderFixture(true),
      [`${CALIBRATION_DIR}known-wins.schema.json`]: '{}\n',
      [`${CALIBRATION_DIR}known-wins.example.json`]: '[]\n',
      'docs/notes.md': 'synthetic\n',
    },
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
  console.error(`check-public-repo: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}
