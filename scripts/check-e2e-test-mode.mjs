#!/usr/bin/env node
/**
 * Keeps E2E_TEST_MODE out of every deployed environment (ARCHITECTURE section
 * 11, T23). Copied from skylite's .github/scripts/check-e2e-test-mode.mjs and
 * adapted to this repository's layout.
 *
 * In this repository the flag never bypasses auth, but it does switch the AI
 * stack to fakes and enable the local-only test login (ARCHITECTURE section
 * 1.2, row 5). isE2ETestMode() is hard-false in production builds; this script
 * is the second layer and checks two things:
 *
 * 1. The environment it runs in. A truthy E2E_TEST_MODE fails when
 *    VERCEL_ENV is production, whatever else is set. Anywhere else it needs
 *    VERCEL_ENV=preview or the ALLOW_E2E_TEST_MODE escape hatch for local and
 *    CI runs.
 *
 * 2. Committed files. A truthy E2E_TEST_MODE hardcoded into a config file, an
 *    env template, a package script, or a deploy manifest would turn the flag
 *    on for everyone, so it is rejected outside the paths in ALLOWED_PATHS.
 *    Reading or comparing the flag is fine; only assigning a truthy value is
 *    reported.
 *
 * Usage:
 *   node scripts/check-e2e-test-mode.mjs               check this repository
 *   node scripts/check-e2e-test-mode.mjs --root <dir>  check another git working tree
 *   node scripts/check-e2e-test-mode.mjs --self-test   prove the check fails on violating fixtures
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

const TRUTHY = new Set(['true', '1', 'yes', 'on'])

/**
 * Paths that may set the flag. An entry ending in "/" is a directory prefix;
 * any other entry is one exact file.
 *
 * - playwright.config.ts starts the throwaway dev server with the flag on.
 * - e2e/, src/lib/e2e-helpers.ts, and src/lib/ai/testing/ are test tooling.
 * - scripts/ holds the guard scripts, whose self-tests write violating
 *   fixtures, and docs/ is prose.
 * - .github/workflows/ci.yml runs only on GitHub's runners, never on Vercel,
 *   and its e2e job must set the flag for the Playwright step (PP-02, REVIEW-2
 *   R2-09). Only this one workflow file is exempt, so a future deploy workflow
 *   is still checked.
 */
const ALLOWED_PATHS = [
  'playwright.config.ts',
  'e2e/',
  'src/lib/e2e-helpers.ts',
  'src/lib/ai/testing/',
  'scripts/',
  'docs/',
  '.github/workflows/ci.yml',
]

/** Unit tests set the flag inside the Vitest process to exercise isE2ETestMode(); they never run in a deployment. */
const UNIT_TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/

/** Files that can carry configuration: source, config formats, env templates, and shell scripts. */
const TEXT_FILE = /\.(?:[cm]?[jt]sx?|json|jsonc|ya?ml|toml|sh|env|example|npmrc)$/i
const EXTRA_BASENAMES = new Set(['Dockerfile', 'Procfile'])

/**
 * Assigns the flag a truthy value, as opposed to reading or comparing it. It
 * covers NAME=true, NAME: "true", "NAME": true, and process.env['NAME'] = '1'.
 * ALLOW_E2E_TEST_MODE is the escape hatch, not the flag, so it is skipped.
 */
const ASSIGNMENT = /(?<!ALLOW_)E2E_TEST_MODE["'`]?\]?\s*[:=]\s*["'`]?\s*(?:true|1|yes|on)\b/i

function isAllowed(path) {
  return ALLOWED_PATHS.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry))
}

function isConfigLike(path) {
  const name = basename(path)
  return TEXT_FILE.test(name) || EXTRA_BASENAMES.has(name) || name.startsWith('.env')
}

/** Tracked files plus untracked files that are not ignored, so a new file is checked before it is committed. */
function gitFiles(root) {
  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`git ls-files failed in ${root}: ${result.stderr.trim()}`)
  return [...new Set(result.stdout.split('\0').filter(Boolean))].sort()
}

function checkEnvironment(env) {
  const failures = []
  const flag = (env.E2E_TEST_MODE ?? '').trim().toLowerCase()
  if (!TRUTHY.has(flag)) {
    console.log('E2E_TEST_MODE is not set in this environment.')
    return failures
  }
  const vercelEnv = (env.VERCEL_ENV ?? '').trim().toLowerCase()
  const escapeHatch = TRUTHY.has((env.ALLOW_E2E_TEST_MODE ?? '').trim().toLowerCase())
  if (vercelEnv === 'production') {
    failures.push(
      'E2E_TEST_MODE is truthy while VERCEL_ENV is production. Production never runs with fake AI or the test login, and ALLOW_E2E_TEST_MODE does not override this.'
    )
  } else if (vercelEnv === 'preview' || escapeHatch) {
    console.log(
      `E2E_TEST_MODE is set, and the context permits it (VERCEL_ENV=${vercelEnv || 'unset'}, ALLOW_E2E_TEST_MODE=${escapeHatch}).`
    )
  } else {
    failures.push(
      `E2E_TEST_MODE is truthy outside a preview (VERCEL_ENV=${vercelEnv || 'unset'}). Unset it, or set ALLOW_E2E_TEST_MODE=1 if this really is a throwaway local or CI environment.`
    )
  }
  return failures
}

function checkCommittedFiles(root) {
  const failures = []
  let scanned = 0
  for (const path of gitFiles(root)) {
    if (isAllowed(path) || UNIT_TEST_FILE.test(path) || !isConfigLike(path)) continue
    const full = join(root, path)
    if (!existsSync(full) || !statSync(full).isFile()) continue
    scanned++
    readFileSync(full, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (ASSIGNMENT.test(line)) {
          failures.push(
            `${path}:${index + 1} hardcodes E2E_TEST_MODE to a truthy value: ${line.trim().slice(0, 200)}\n` +
              '      Only the Playwright runner and the CI e2e job may turn it on, and only for the dev server they start.'
          )
        }
      })
  }
  console.log(`Scanned ${scanned} files for hardcoded E2E_TEST_MODE assignments.`)
  return failures
}

function check(root, env) {
  const failures = [...checkEnvironment(env), ...checkCommittedFiles(root)]
  for (const failure of failures) console.error(`FAIL  ${failure}`)
  if (failures.length > 0) {
    console.error(`\n${failures.length} E2E_TEST_MODE violation(s).`)
    return 1
  }
  console.log('E2E_TEST_MODE guard passed.')
  return 0
}

// ---------------------------------------------------------------------------
// Self-test: every case runs this script against a fixture repository created
// in the system temp directory, outside this repository.
// ---------------------------------------------------------------------------

const SELF_TEST_CASES = [
  {
    name: 'a truthy flag in a deploy manifest is rejected',
    expect: 1,
    files: { 'vercel.json': '{ "env": { "E2E_TEST_MODE": "true" } }\n' },
  },
  {
    name: 'a truthy flag in a package script is rejected',
    expect: 1,
    files: { 'package.json': '{ "scripts": { "build": "E2E_TEST_MODE=1 next build" } }\n' },
  },
  {
    name: 'a truthy flag in an env template is rejected',
    expect: 1,
    files: { '.env.example': 'E2E_TEST_MODE=yes\n' },
  },
  {
    name: 'a truthy flag in application code is rejected',
    expect: 1,
    files: { 'src/lib/boot.ts': "process.env['E2E_TEST_MODE'] = 'true'\n" },
  },
  {
    name: 'a truthy flag with VERCEL_ENV=production is rejected even with the escape hatch',
    expect: 1,
    files: { 'README.md': 'clean\n' },
    env: { E2E_TEST_MODE: 'true', VERCEL_ENV: 'production', ALLOW_E2E_TEST_MODE: '1' },
  },
  {
    name: 'a truthy flag outside a preview without the escape hatch is rejected',
    expect: 1,
    files: { 'README.md': 'clean\n' },
    env: { E2E_TEST_MODE: 'true' },
  },
  {
    name: 'allowed paths, reads, comparisons, and the escape hatch pass',
    expect: 0,
    files: {
      'playwright.config.ts': "export default { webServer: { command: 'E2E_TEST_MODE=true pnpm dev' } }\n",
      'e2e/tests/a.spec.ts': "process.env.E2E_TEST_MODE = 'true'\n",
      'src/lib/e2e-helpers.ts': "export const on = () => process.env.E2E_TEST_MODE === 'true'\n",
      'src/lib/e2e-helpers.test.ts': "process.env.E2E_TEST_MODE = 'true'\n",
      '.github/workflows/ci.yml': 'env:\n  E2E_TEST_MODE: true\n  ALLOW_E2E_TEST_MODE: 1\n',
      '.env.example': 'E2E_TEST_MODE=\nALLOW_E2E_TEST_MODE=\n',
      'docs/notes.md': 'Set E2E_TEST_MODE=true only for local runs.\n',
    },
    env: { E2E_TEST_MODE: 'true', ALLOW_E2E_TEST_MODE: '1' },
  },
]

function fixtureEnv() {
  const env = { ...process.env }
  for (const name of ['E2E_TEST_MODE', 'ALLOW_E2E_TEST_MODE', 'VERCEL_ENV', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
    delete env[name]
  }
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
      const result = spawnSync(process.execPath, [SCRIPT, '--root', dir], {
        encoding: 'utf8',
        env: { ...fixtureEnv(), ...testCase.env },
      })
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
  process.exitCode = args.selfTest ? selfTest(SELF_TEST_CASES) : check(args.root, process.env)
} catch (error) {
  console.error(`check-e2e-test-mode: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}
