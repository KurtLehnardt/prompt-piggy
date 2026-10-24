import { readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  diskReader,
  isClientModule,
  reachableModules,
  startsWithServerOnly,
  stripComments,
  type SourceReader,
} from '@/test/source-imports'

/**
 * REVIEW-PR2-r2 P2R-02: the Supabase secret key must never be readable from a
 * module that a Client Component can import. A Client Component also renders
 * on the server, so a secret read during that render ends up in the HTML.
 *
 * - env.server.ts is the only module that reads the secret-key variables, and
 *   its first statement is `import 'server-only'`, which makes importing it
 *   from a Client Component a build error. server-only-guard.test.tsx shows
 *   that the guard throws under the browser export conditions.
 * - No client module reaches env.server.ts or admin.ts through its imports.
 * - env.ts, which the browser client imports, does not name the secret key.
 */
const root = path.resolve(__dirname, '../../..')
const src = path.join(root, 'src')
const SECRET_NAMES = ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const
const SECRET_READ = /\bprocess\.env\s*(?:\.\s*SUPABASE_(?:SECRET_KEY|SERVICE_ROLE_KEY)\b|\[\s*['"`]SUPABASE_(?:SECRET_KEY|SERVICE_ROLE_KEY)['"`]\s*\])/
const ENV_SERVER = path.join(src, 'lib/supabase/env.server.ts')
const ADMIN = path.join(src, 'lib/supabase/admin.ts')
// Modules that run in the browser without a "use client" directive of their own.
const BROWSER_MODULES = [path.join(src, 'lib/supabase/client.ts')]

function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(full))
    else if (/\.(?:ts|tsx|js|jsx|mjs)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      files.push(full)
    }
  }
  return files
}

function relative(file: string): string {
  return path.relative(root, file)
}

/** The modules a client module can reach that are server-only secrets, or that name a secret. */
function secretModulesReachableFromClient(files: string[], read: SourceReader): string[] {
  const entries = [
    ...files.filter((file) => isClientModule(read(file) ?? '')),
    ...BROWSER_MODULES.filter((file) => read(file) !== undefined),
  ]
  const reached = reachableModules(root, entries, read)
  return [...reached]
    .filter((file) => {
      if (file === ENV_SERVER || file === ADMIN) return true
      const code = stripComments(read(file) ?? '')
      return SECRET_NAMES.some((name) => code.includes(name))
    })
    .map(relative)
    .sort()
}

describe('secret-key boundary (P2R-02)', () => {
  const files = sourceFiles(src)

  it('finds the client modules it walks from', () => {
    const clientModules = files.filter((file) => isClientModule(diskReader(file) ?? ''))
    expect(clientModules.length).toBeGreaterThan(0)
  })

  it('env.server.ts starts with import "server-only"', () => {
    expect(startsWithServerOnly(diskReader(ENV_SERVER) ?? '')).toBe(true)
  })

  it('admin.ts starts with import "server-only"', () => {
    expect(startsWithServerOnly(diskReader(ADMIN) ?? '')).toBe(true)
  })

  it('env.server.ts is the only module that reads a secret-key variable', () => {
    const readers = files.filter((file) => SECRET_READ.test(stripComments(diskReader(file) ?? '')))
    expect(readers.map(relative)).toEqual(['src/lib/supabase/env.server.ts'])
  })

  it('every module that names a secret-key variable is server-only', () => {
    const naming = files.filter((file) => {
      const code = stripComments(diskReader(file) ?? '')
      return SECRET_NAMES.some((name) => code.includes(name))
    })
    expect(naming.length).toBeGreaterThan(0)
    for (const file of naming) {
      expect(startsWithServerOnly(diskReader(file) ?? ''), relative(file)).toBe(true)
    }
  })

  it('env.ts, which the browser client imports, does not name the secret key', () => {
    const source = diskReader(path.join(src, 'lib/supabase/env.ts')) ?? ''
    expect(source).not.toMatch(/SUPABASE_SECRET_KEY|SERVICE_ROLE|resolveSupabaseSecretKey/)
  })

  it('no client module reaches env.server.ts, admin.ts, or a module that names the secret key', () => {
    expect(secretModulesReachableFromClient(files, diskReader)).toEqual([])
  })

  it('would catch a Client Component that imports the secret reader, directly or through another module', () => {
    const page = path.join(src, 'app/probe/page.tsx')
    const widget = path.join(src, 'components/probe-widget.tsx')
    const helper = path.join(src, 'lib/probe-helper.ts')
    const fake = new Map<string, string>([
      [page, "'use client'\nimport { Widget } from '@/components/probe-widget'\n"],
      [widget, "import { secret } from '../lib/probe-helper'\nexport const Widget = secret\n"],
      [helper, "export { resolveSupabaseSecretKey as secret } from '@/lib/supabase/env.server'\n"],
    ])
    const read: SourceReader = (file) => fake.get(file) ?? diskReader(file)
    expect(secretModulesReachableFromClient([...files, page, widget, helper], read)).toEqual([
      'src/lib/supabase/env.server.ts',
    ])
  })
})
