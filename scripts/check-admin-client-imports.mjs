#!/usr/bin/env node
/**
 * Strict allowlist of the modules that may import the Supabase secret-key
 * client (ARCHITECTURE section 11, T14; REVIEW-1 R1-24; REVIEW-2 R2-07).
 *
 * src/lib/supabase/admin.ts returns a client that bypasses row-level security.
 * Skylite guards its equivalent with a baseline ratchet
 * (.github/scripts/check-admin-client-guards.mjs). This repository starts at
 * zero call sites, so the check is a strict allowlist of importing paths
 * instead (ARCHITECTURE section 1.2, row 20).
 *
 * @/lib/supabase/admin may be imported only from:
 *   - src/app/api/**, except src/app/api/live/** and src/app/api/health/**
 *   - src/app/live/players/**
 *   - src/app/admin/**
 *   - src/lib/game/attempt-service.ts and src/lib/game/rpc.ts
 *   - src/lib/hardening/pipeline/**
 *   - src/lib/ai/calibration/**
 *   - src/lib/supabase/**, the client's own module directory and its tests
 *
 * It is never allowed in a file that contains a 'use client' directive, in
 * src/app/live/page.tsx, in src/lib/live/**, or in src/components/**. Those
 * rules win over the allowlist.
 *
 * Those files, and the cookie-less routes under src/app/api/live/** and
 * src/app/api/health/**, must not reach either guarded module indirectly
 * either (REVIEW-PR5 H1). A second pass starts from each of them, walks its
 * local imports breadth-first through any number of modules, allowed ones
 * included, and fails with the import chain when the walk reaches
 * src/lib/supabase/admin.ts or src/lib/supabase/env.server.ts. So a live
 * route that imports src/lib/game/rpc.ts, which imports the admin client,
 * fails even though rpc.ts itself is allowed.
 *
 * The same rules guard @/lib/supabase/env.server, the only module that reads
 * the secret-key variables (REVIEW-3 R3-14). Only the admin client and the
 * /health page, which shows the variable's name and never its value, may
 * import it.
 *
 * Unit test files (name.test.ts, name.spec.tsx, and so on) are exempt from the
 * allowlist and the denied paths: Vitest runs them in Node, and no bundle ever
 * includes them, so they cannot expose the key. They may import the client to
 * test how its errors are handled. The 'use client' rule still applies to
 * them. Every import form is counted: static, type-only, side-effect,
 * export-from, dynamic import(), and require(), through the @/ alias or a
 * relative path.
 *
 * Usage:
 *   node scripts/check-admin-client-imports.mjs               check this repository
 *   node scripts/check-admin-client-imports.mjs --root <dir>  check another git working tree
 *   node scripts/check-admin-client-imports.mjs --self-test   prove the check fails on violating fixtures
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

/** Directories scanned for importers. Only these resolve the @/ alias. */
const SCAN_PREFIXES = ['src/', 'e2e/']
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/
const UNIT_TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/

/** Denied everywhere, whatever the allowlist says. An entry ending in "/" is a prefix. */
const ALWAYS_DENIED = ['src/app/live/page.tsx', 'src/lib/live/', 'src/components/']

/** Paths that must not reach a guarded module through any chain of imports. 'use client' files are added to these. */
const TRANSITIVE_DENIED = [...ALWAYS_DENIED, 'src/app/api/live/', 'src/app/api/health/']
const RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js']

const GUARDED_MODULES = [
  {
    module: 'src/lib/supabase/admin',
    label: '@/lib/supabase/admin',
    allowed: [
      { prefix: 'src/app/api/', except: ['src/app/api/live/', 'src/app/api/health/'] },
      { prefix: 'src/app/live/players/' },
      { prefix: 'src/app/admin/' },
      { file: 'src/lib/game/attempt-service.ts' },
      { file: 'src/lib/game/rpc.ts' },
      { prefix: 'src/lib/hardening/pipeline/' },
      { prefix: 'src/lib/ai/calibration/' },
      { prefix: 'src/lib/supabase/' },
    ],
  },
  {
    module: 'src/lib/supabase/env.server',
    label: '@/lib/supabase/env.server',
    allowed: [{ prefix: 'src/lib/supabase/' }, { file: 'src/app/health/page.tsx' }],
  },
]

const RESOLVABLE_SUFFIXES = /(?:\/index)?\.(?:[cm]?[jt]sx?)$/

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
  return [...found]
}

function hasUseClientDirective(source) {
  return /(?:^|[\s;])['"]use client['"]/.test(stripComments(source))
}

/** The repository path, without extension, that a specifier points at, or null for a package import. */
function resolveSpecifier(fromPath, specifier) {
  let target
  if (specifier.startsWith('@/')) target = `src/${specifier.slice(2)}`
  else if (specifier.startsWith('./') || specifier.startsWith('../')) {
    target = posix.normalize(posix.join(posix.dirname(fromPath), specifier))
  } else return null
  return target.replace(RESOLVABLE_SUFFIXES, '').replace(/\/index$/, '')
}

/** The repository path that a local specifier names, before extension resolution, or null for a package import. */
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
    const candidate = join(root, base + extension)
    if (existsSync(candidate) && statSync(candidate).isFile()) return base + extension
  }
  return null
}

/**
 * Every chain of local imports from `start` that ends at a guarded module and
 * passes through at least one other module. Direct imports are reported by
 * the first pass. An unresolved path is still judged by its name, so a
 * missing file cannot hide a guarded import.
 */
function transitiveChains(root, start, readSource) {
  const found = []
  const seen = new Set([start])
  const queue = [[start]]
  while (queue.length > 0) {
    const chain = queue.shift()
    const file = chain[chain.length - 1]
    const source = readSource(file)
    if (source === undefined) continue
    for (const specifier of importSpecifiers(source)) {
      const base = localBase(file, specifier)
      if (base === null) continue
      const resolved = resolveFile(root, base)
      const target = (resolved ?? base).replace(RESOLVABLE_SUFFIXES, '').replace(/\/index$/, '')
      const guarded = GUARDED_MODULES.find((candidate) => candidate.module === target)
      if (guarded) {
        if (chain.length > 1) found.push({ guarded, chain: [...chain, resolved ?? base] })
      } else if (resolved !== null && !seen.has(resolved)) {
        seen.add(resolved)
        queue.push([...chain, resolved])
      }
    }
  }
  return found
}

function matchesEntry(path, entry) {
  return entry.endsWith('/') ? path.startsWith(entry) : path === entry
}

function isAllowedBy(path, rule) {
  if (rule.file) return path === rule.file
  return path.startsWith(rule.prefix) && !(rule.except ?? []).some((prefix) => path.startsWith(prefix))
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

function check(root) {
  const failures = []
  let scanned = 0
  let importers = 0
  const sources = new Map()
  const readSource = (path) => {
    if (!sources.has(path)) {
      const full = join(root, path)
      sources.set(path, existsSync(full) && statSync(full).isFile() ? readFileSync(full, 'utf8') : undefined)
    }
    return sources.get(path)
  }
  const transitiveStarts = []
  for (const path of gitFiles(root)) {
    if (!SCAN_PREFIXES.some((prefix) => path.startsWith(prefix)) || !CODE_FILE.test(path)) continue
    const source = readSource(path)
    if (source === undefined) continue
    scanned++
    if (!UNIT_TEST_FILE.test(path) && (hasUseClientDirective(source) || TRANSITIVE_DENIED.some((entry) => matchesEntry(path, entry)))) {
      transitiveStarts.push(path)
    }
    const ownModule = path.replace(RESOLVABLE_SUFFIXES, '')
    const targets = new Set(importSpecifiers(source).map((specifier) => resolveSpecifier(path, specifier)))
    for (const guarded of GUARDED_MODULES) {
      if (!targets.has(guarded.module) || ownModule === guarded.module) continue
      importers++
      if (hasUseClientDirective(source)) {
        failures.push(`${path} imports ${guarded.label} but contains a 'use client' directive.`)
      } else if (UNIT_TEST_FILE.test(path)) {
        continue
      } else if (ALWAYS_DENIED.some((entry) => matchesEntry(path, entry))) {
        failures.push(`${path} imports ${guarded.label}, which is never allowed under ${ALWAYS_DENIED.join(', ')}.`)
      } else if (!guarded.allowed.some((rule) => isAllowedBy(path, rule))) {
        failures.push(`${path} imports ${guarded.label} but is not on its allowlist in scripts/check-admin-client-imports.mjs.`)
      }
    }
  }
  for (const start of transitiveStarts) {
    for (const { guarded, chain } of transitiveChains(root, start, readSource)) {
      failures.push(`${start} reaches ${guarded.label} indirectly: ${chain.join(' -> ')}.`)
    }
  }
  console.log(
    `Scanned ${scanned} source files; ${importers} direct import(s) of a guarded secret-key module; ` +
      `${transitiveStarts.length} denied or 'use client' file(s) walked transitively.`
  )
  for (const failure of failures) console.error(`FAIL  ${failure}`)
  if (failures.length > 0) {
    console.error(
      `\n${failures.length} disallowed import(s). The secret-key client bypasses row-level security, so it is reachable only from` +
        ' server route handlers and server modules that authorize the caller first (ARCHITECTURE section 11, T14).'
    )
    return 1
  }
  console.log('Secret-key client import guard passed.')
  return 0
}

// ---------------------------------------------------------------------------
// Self-test: every case runs this script against a fixture repository created
// in the system temp directory, outside this repository. The import lines are
// assembled at run time so this file never contains one itself.
// ---------------------------------------------------------------------------

const importAdmin = (from = '@/lib/supabase/admin') => `import { createAdminClient } from '${from}'\n`
const importEnvServer = (from = '@/lib/supabase/env.server') => `import { resolveSupabaseSecretKey } from '${from}'\n`
const USE_CLIENT = "'use client'\n"

const SELF_TEST_CASES = [
  {
    name: 'a component importing the admin client is rejected',
    expect: 1,
    files: { 'src/components/wallet/wallet-panel.tsx': importAdmin() },
  },
  {
    name: "an allowed route that contains 'use client' is rejected",
    expect: 1,
    files: { 'src/app/api/attempts/route.ts': USE_CLIENT + importAdmin() },
  },
  {
    name: 'the cookie-less live and health API routes are rejected',
    expect: 1,
    files: { 'src/app/api/live/snapshot/route.ts': `import type { X } from '@/lib/supabase/admin'\n` },
  },
  {
    name: 'a relative dynamic import from a module off the allowlist is rejected',
    expect: 1,
    files: { 'src/lib/ops/spend.ts': "export const load = () => import('../supabase/admin')\n" },
  },
  {
    name: 'the live view and its library are rejected',
    expect: 1,
    files: { 'src/lib/live/snapshot.ts': importAdmin() },
  },
  {
    name: 'a denied live route that reaches the admin client through the allowed RPC wrapper is rejected',
    expect: 1,
    files: {
      'src/lib/supabase/admin.ts': "import 'server-only'\n",
      'src/lib/game/rpc.ts': importAdmin(),
      'src/app/api/live/snapshot/route.ts': "import { call } from '@/lib/game/rpc'\n",
    },
  },
  {
    name: 'the live library reaching the admin client through a re-export is rejected',
    expect: 1,
    files: {
      'src/lib/supabase/admin.ts': "import 'server-only'\n",
      'src/lib/supabase/service.ts': "export { createAdminClient } from './admin'\n",
      'src/lib/live/feed.ts': "import { createAdminClient } from '../supabase/service'\n",
    },
  },
  {
    name: "a 'use client' file reaching the secret-key reader through two modules is rejected",
    expect: 1,
    files: {
      'src/lib/supabase/env.server.ts': "import 'server-only'\n",
      'src/lib/supabase/admin.ts': importEnvServer(),
      'src/lib/game/rpc.ts': importAdmin(),
      'src/lib/hooks/use-thing.ts': "export const load = () => import('@/lib/game/rpc')\n",
      'src/app/(game)/play/view.tsx': USE_CLIENT + "import { load } from '@/lib/hooks/use-thing'\n",
    },
  },
  {
    name: "a unit test that contains 'use client' is still rejected",
    expect: 1,
    files: { 'src/components/wallet/wallet-panel.test.tsx': USE_CLIENT + importAdmin() },
  },
  {
    name: 'the secret-key reader imported off its allowlist is rejected',
    expect: 1,
    files: { 'src/lib/ai/openai.ts': importEnvServer() },
  },
  {
    name: 'every allowlisted importer passes',
    expect: 0,
    files: {
      'src/lib/supabase/env.server.ts': "import 'server-only'\n",
      'src/lib/supabase/admin.ts': "import 'server-only'\n" + importEnvServer(),
      'src/lib/supabase/lazy-env.test.ts': "await import('./admin')\n",
      'src/app/api/attempts/route.ts': importAdmin(),
      'src/app/api/healthz/route.ts': importAdmin(),
      'src/app/live/players/route.ts': importAdmin(),
      'src/app/admin/page.tsx': importAdmin(),
      'src/lib/game/attempt-service.ts': importAdmin(),
      'src/lib/game/attempt-service.test.ts': importAdmin(),
      'src/lib/errors.test.ts': "const load = () => import('@/lib/supabase/admin')\n",
      'src/app/api/wallet/repair/route.ts': "import { call } from '@/lib/game/rpc'\n",
      'src/lib/utils.ts': 'export const cn = () => ""\n',
      'src/lib/live/labels.ts': "import { cn } from '@/lib/utils'\n",
      'src/app/api/health/route.ts': "import { cn } from '../../../lib/utils'\n",
      'src/components/live/feed.tsx': USE_CLIENT + "import { cn } from '@/lib/utils'\n",
      'src/lib/game/rpc.ts': importAdmin('../supabase/admin'),
      'src/lib/hardening/pipeline/process-job.ts': importAdmin(),
      'src/lib/ai/calibration/run.ts': importAdmin(),
      'src/app/health/page.tsx': importEnvServer(),
      'src/components/note.tsx': '// a comment that mentions @/lib/supabase/admin is not an import\n',
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
  console.error(`check-admin-client-imports: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}
