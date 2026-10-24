import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * HC-A4: the Dynamic Validator and every other piece of game logic run in the
 * attempt route handler, never in the Next.js proxy. These checks read the
 * source files, so they also catch type-only and side-effect imports.
 */
const root = path.resolve(__dirname, '../../..')

function read(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), 'utf8')
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function importSpecifiers(source: string): string[] {
  const code = stripComments(source)
  const patterns = [
    /\bimport\s+(?:type\s+)?[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
    /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  ]
  const found = new Set<string>()
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) found.add(match[1])
  }
  return [...found].sort()
}

describe('src/proxy.ts scope (HC-A4)', () => {
  const source = read('src/proxy.ts')

  it('imports only next/server and @/lib/supabase/proxy', () => {
    expect(importSpecifiers(source)).toEqual(['@/lib/supabase/proxy', 'next/server'])
  })

  it('has no dynamic import or require', () => {
    const code = stripComments(source)
    expect(code).not.toMatch(/\bimport\s*\(/)
    expect(code).not.toMatch(/\brequire\s*\(/)
  })

  it('does not export a runtime, which Next.js 16 proxy rejects', () => {
    expect(stripComments(source)).not.toMatch(/export\s+const\s+runtime\b/)
  })

  it('exports a function named proxy', () => {
    expect(source).toMatch(/export\s+(async\s+)?function\s+proxy\s*\(/)
  })
})

describe('src/lib/supabase/proxy.ts scope (HC-A4)', () => {
  it('imports only the Supabase SSR client, next/server, the env helper, and the Database type', () => {
    expect(importSpecifiers(read('src/lib/supabase/proxy.ts'))).toEqual([
      '@/lib/supabase/env',
      '@/types/database',
      '@supabase/ssr',
      'next/server',
    ])
  })

  it('reaches no other module through the env helper', () => {
    expect(importSpecifiers(read('src/lib/supabase/env.ts'))).toEqual([])
  })
})

describe('importSpecifiers', () => {
  it('finds every import form', () => {
    const sample = [
      "import a from 'a'",
      "import type { B } from 'b'",
      "import 'c'",
      "export { d } from 'd'",
      "const e = await import('e')",
      "const f = require('f')",
      "// import g from 'g'",
    ].join('\n')
    expect(importSpecifiers(sample)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })
})
