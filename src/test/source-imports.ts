import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Test helpers that read import statements straight from source files, so
 * they also see type-only and side-effect imports. They are used only by
 * tests and never by the app.
 */

export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

export function importSpecifiers(source: string): string[] {
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

/** Reads a source file, or returns undefined when there is no such file. */
export type SourceReader = (absolutePath: string) => string | undefined

export function diskReader(absolutePath: string): string | undefined {
  try {
    if (!statSync(absolutePath).isFile()) return undefined
    return readFileSync(absolutePath, 'utf8')
  } catch {
    return undefined
  }
}

const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js']

/**
 * Resolves an `@/` or relative specifier to a file under `root`/src. Package
 * imports return null: only this repository's modules are followed.
 */
export function resolveLocalImport(
  root: string,
  fromFile: string,
  specifier: string,
  read: SourceReader
): string | null {
  let base: string
  if (specifier.startsWith('@/')) base = path.join(root, 'src', specifier.slice(2))
  else if (specifier.startsWith('./') || specifier.startsWith('../')) {
    base = path.resolve(path.dirname(fromFile), specifier)
  } else return null
  for (const extension of EXTENSIONS) {
    const candidate = base + extension
    if (read(candidate) !== undefined) return candidate
  }
  return null
}

/** Every repository module reachable from `entries` through static or dynamic imports, entries included. */
export function reachableModules(root: string, entries: string[], read: SourceReader): Set<string> {
  const seen = new Set<string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    const source = read(file)
    if (source === undefined) continue
    seen.add(file)
    for (const specifier of importSpecifiers(source)) {
      const resolved = resolveLocalImport(root, file, specifier, read)
      if (resolved && !seen.has(resolved)) queue.push(resolved)
    }
  }
  return seen
}

/** True when the file starts with a "use client" directive (after comments and blank lines). */
export function isClientModule(source: string): boolean {
  return /^\s*['"]use client['"]/.test(stripComments(source))
}

/** True when the first statement of the file is `import 'server-only'`. */
export function startsWithServerOnly(source: string): boolean {
  return /^\s*import\s+['"]server-only['"]/.test(stripComments(source))
}
