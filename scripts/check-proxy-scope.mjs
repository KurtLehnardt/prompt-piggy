#!/usr/bin/env node
/**
 * Keeps the Dynamic Validator and every other piece of game logic out of the
 * Next.js proxy (HARDENING_CONSTRAINTS orchestrator addition HC-A4). The
 * validator is a server module called from the attempt route handler on the
 * Node runtime, never proxy.ts or middleware.ts.
 *
 * It fails when:
 *   - src/proxy.ts is missing, or imports anything other than next/server and
 *     @/lib/supabase/proxy, in any form (static, type-only, side-effect,
 *     export-from, dynamic import(), or require());
 *   - any module reachable from src/proxy.ts through local imports lives
 *     under src/lib/validator, src/lib/ai, or src/lib/hardening;
 *   - a middleware.ts or middleware.js file exists at the root or in src/, or
 *     a second proxy file exists at the root, so the proxy cannot be moved or
 *     duplicated around this check.
 *
 * src/lib/supabase/proxy-scope.test.ts (PP-01) checks the same boundary inside
 * the unit tests; this script keeps it in the guardrails job as well.
 *
 * Usage:
 *   node scripts/check-proxy-scope.mjs               check this repository
 *   node scripts/check-proxy-scope.mjs --root <dir>  check another git working tree
 *   node scripts/check-proxy-scope.mjs --self-test   prove the check fails on violating fixtures
 *
 * Exit codes: 0 pass, 1 violation, 2 usage or internal error.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(import.meta.url)
const REPO_ROOT = resolve(dirname(SCRIPT), '..')

const PROXY = 'src/proxy.ts'
const ALLOWED_PROXY_IMPORTS = new Set(['next/server', '@/lib/supabase/proxy'])
const FORBIDDEN_PREFIXES = ['src/lib/validator/', 'src/lib/ai/', 'src/lib/hardening/']
const FORBIDDEN_FILES = [
  'middleware.ts',
  'middleware.js',
  'src/middleware.ts',
  'src/middleware.js',
  'proxy.ts',
  'proxy.js',
  'src/proxy.js',
]
const RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js']

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
}

/** Every module specifier the source imports, in any form. */
function importSpecifiers(source) {
  const code = stripComments(source)
  const patterns = [
    /\bimport\s+(?:type\s+)?[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
    /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  ]
  const found = new Set()
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) found.add(match[1])
  }
  return [...found].sort()
}

function isFile(path) {
  return existsSync(path) && statSync(path).isFile()
}

/** The repository path, without extension, that a local specifier names, or null for a package import. */
function localBase(fromPath, specifier) {
  if (specifier.startsWith('@/')) return `src/${specifier.slice(2)}`
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return posix.normalize(posix.join(posix.dirname(fromPath), specifier))
  }
  return null
}

/** The repository file a local base path resolves to, or null when no such file exists. */
function resolveFile(root, base) {
  for (const extension of RESOLVE_EXTENSIONS) {
    if (isFile(join(root, base + extension))) return base + extension
  }
  return null
}

/** Each forbidden module reachable from the proxy, with the import chain that reaches it. */
function forbiddenReachable(root) {
  const found = []
  const seen = new Set([PROXY])
  const queue = [[PROXY]]
  while (queue.length > 0) {
    const chain = queue.shift()
    const file = chain[chain.length - 1]
    for (const specifier of importSpecifiers(readFileSync(join(root, file), 'utf8'))) {
      const base = localBase(file, specifier)
      if (base === null) continue
      const resolved = resolveFile(root, base)
      // An unresolved path is still judged by its name, so a missing file cannot hide a forbidden import.
      const target = resolved ?? base
      if (FORBIDDEN_PREFIXES.some((prefix) => `${target}/`.startsWith(prefix))) {
        found.push([...chain, target])
      } else if (resolved !== null && !seen.has(resolved)) {
        seen.add(resolved)
        queue.push([...chain, resolved])
      }
    }
  }
  return found
}

function check(root) {
  const failures = []
  for (const file of FORBIDDEN_FILES) {
    if (isFile(join(root, file))) {
      failures.push(`${file} exists. Next.js 16 runs exactly one proxy, src/proxy.ts, and no middleware file is allowed (HC-A4).`)
    }
  }
  if (!isFile(join(root, PROXY))) {
    failures.push(`${PROXY} is missing.`)
  } else {
    const imports = importSpecifiers(readFileSync(join(root, PROXY), 'utf8'))
    for (const specifier of imports) {
      if (!ALLOWED_PROXY_IMPORTS.has(specifier)) {
        failures.push(`${PROXY} imports ${specifier}. It may import only ${[...ALLOWED_PROXY_IMPORTS].join(' and ')}.`)
      }
    }
    for (const chain of forbiddenReachable(root)) {
      failures.push(`${PROXY} reaches ${chain[chain.length - 1]} through ${chain.join(' -> ')}. Validator, AI, and hardening code never runs in the proxy.`)
    }
    console.log(`${PROXY} imports: ${imports.join(', ') || '(none)'}.`)
  }
  for (const failure of failures) console.error(`FAIL  ${failure}`)
  if (failures.length > 0) {
    console.error(`\n${failures.length} proxy scope violation(s) (HC-A4).`)
    return 1
  }
  console.log('Proxy scope guard passed.')
  return 0
}

// ---------------------------------------------------------------------------
// Self-test: every case runs this script against a fixture repository created
// in the system temp directory, outside this repository.
// ---------------------------------------------------------------------------

const GOOD_PROXY = [
  "import type { NextRequest } from 'next/server'",
  "import { updateSession } from '@/lib/supabase/proxy'",
  'export async function proxy(request: NextRequest) {',
  '  return updateSession(request)',
  '}',
  '',
].join('\n')
const GOOD_SESSION = [
  "import { createServerClient } from '@supabase/ssr'",
  "import { NextResponse } from 'next/server'",
  "import { readPublicSupabaseEnv } from '@/lib/supabase/env'",
  'export const updateSession = () => NextResponse.next()',
  '',
].join('\n')

const SELF_TEST_CASES = [
  {
    name: 'a direct validator import in the proxy is rejected',
    expect: 1,
    files: {
      'src/proxy.ts': GOOD_PROXY + "import { validate } from '@/lib/validator'\n",
      'src/lib/supabase/proxy.ts': GOOD_SESSION,
      'src/lib/validator/index.ts': 'export const validate = () => true\n',
    },
  },
  {
    name: 'a dynamic import of AI code in the proxy is rejected',
    expect: 1,
    files: {
      'src/proxy.ts': GOOD_PROXY + "export const later = () => import('./lib/ai/openai')\n",
      'src/lib/supabase/proxy.ts': GOOD_SESSION,
    },
  },
  {
    name: 'hardening code reached through the session helper is rejected',
    expect: 1,
    files: {
      'src/proxy.ts': GOOD_PROXY,
      'src/lib/supabase/proxy.ts': GOOD_SESSION + "import '@/lib/hardening/pipeline/kick'\n",
      'src/lib/hardening/pipeline/kick.ts': 'export {}\n',
    },
  },
  {
    name: 'a middleware file next to the proxy is rejected',
    expect: 1,
    files: {
      'src/proxy.ts': GOOD_PROXY,
      'src/lib/supabase/proxy.ts': GOOD_SESSION,
      'src/middleware.ts': 'export function middleware() {}\n',
    },
  },
  {
    name: 'a missing proxy is rejected',
    expect: 1,
    files: { 'src/lib/supabase/proxy.ts': GOOD_SESSION },
  },
  {
    name: 'the session-refresh-only proxy passes',
    expect: 0,
    files: {
      'src/proxy.ts': GOOD_PROXY + "// import { validate } from '@/lib/validator' is only a comment\n",
      'src/lib/supabase/proxy.ts': GOOD_SESSION,
      'src/lib/supabase/env.ts': 'export const readPublicSupabaseEnv = () => null\n',
      'src/lib/validator/index.ts': 'export const validate = () => true\n',
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
  console.error(`check-proxy-scope: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}
