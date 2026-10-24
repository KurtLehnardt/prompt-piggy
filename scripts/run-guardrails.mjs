#!/usr/bin/env node
/**
 * Runs every guardrail check in scripts/ (pnpm guardrails, REVIEW-1 R1-23).
 *
 * It discovers each scripts/check-*.mjs file, so a later task adds a check by
 * adding a file, with no change here or in CI. For every check it runs:
 *
 *   1. node scripts/check-<name>.mjs              the check against this repository
 *   2. node scripts/check-<name>.mjs --self-test  the check against fixtures that
 *                                                 violate its rule, which proves
 *                                                 that it still fails when it should
 *
 * It exits 0 only when every check and every self-test exits 0, and 1
 * otherwise, including when no check is found.
 *
 * Checks read source and git metadata only. A scan of build output, such as
 * scripts/scan-client-bundle.mjs (PP-28), needs `pnpm build` first, so it is
 * never named check-*.mjs and runs explicitly in the CI build job instead.
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPTS_DIR, '..')
const CHECK_FILE = /^check-[a-z0-9-]+\.mjs$/

const checks = readdirSync(SCRIPTS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile() && CHECK_FILE.test(entry.name))
  .map((entry) => entry.name)
  .sort()

if (checks.length === 0) {
  console.error('No scripts/check-*.mjs files were found.')
  process.exit(1)
}

const results = []
for (const name of checks) {
  const path = relative(REPO_ROOT, join(SCRIPTS_DIR, name))
  for (const [label, args] of [
    ['check', []],
    ['self-test', ['--self-test']],
  ]) {
    console.log(`\n=== ${path}${args.length > 0 ? ` ${args.join(' ')}` : ''}`)
    const run = spawnSync(process.execPath, [path, ...args], { cwd: REPO_ROOT, stdio: 'inherit' })
    results.push({ path, label, status: run.status, signal: run.signal })
  }
}

console.log('\n=== Summary')
for (const { path, label, status, signal } of results) {
  const outcome = status === 0 ? 'pass' : `FAIL (${status ?? signal})`
  console.log(`${outcome.padEnd(10)} ${label.padEnd(10)} ${path}`)
}

const failed = results.filter(({ status }) => status !== 0)
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${results.length} guardrail run(s) failed.`)
  process.exit(1)
}
console.log(`\nAll ${checks.length} guardrail checks and their self-tests passed.`)
