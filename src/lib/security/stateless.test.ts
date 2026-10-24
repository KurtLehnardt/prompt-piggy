import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isDeepFrozen } from '@/lib/config/deep-freeze'
import * as canaryModule from '@/lib/security/canary'
import * as encapsulateModule from '@/lib/security/encapsulate'
import * as foldModule from '@/lib/security/fold'
import * as leakModule from '@/lib/security/leak-detector'
import * as nonceModule from '@/lib/security/nonce'
import { stripComments } from '@/test/source-imports'

/**
 * HC3 and T10: the security modules are pure, export only frozen values, and
 * keep no module state that one attempt could leave behind for another.
 */

const MODULES = {
  canary: canaryModule,
  nonce: nonceModule,
  encapsulate: encapsulateModule,
  fold: foldModule,
  'leak-detector': leakModule,
}

const SECURITY_DIR = path.join(process.cwd(), 'src', 'lib', 'security')

function sourceFiles(): string[] {
  return readdirSync(SECURITY_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort()
}

describe('security modules are frozen and stateless', () => {
  it('covers every source file in src/lib/security', () => {
    expect(sourceFiles()).toEqual(Object.keys(MODULES).map((name) => `${name}.ts`).sort())
  })

  for (const [name, exports] of Object.entries(MODULES)) {
    it(`${name}: every export is frozen`, () => {
      for (const [exportName, value] of Object.entries(exports)) {
        if (typeof value === 'function') expect(Object.isFrozen(value), exportName).toBe(true)
        else expect(isDeepFrozen(value), exportName).toBe(true)
      }
    })
  }

  it('no source file has top-level mutable bindings, collections, or global regular expressions', () => {
    for (const file of sourceFiles()) {
      const code = stripComments(readFileSync(path.join(SECURITY_DIR, file), 'utf8'))
      const topLevel = code.split('\n').filter((line) => /^\S/.test(line))
      for (const line of topLevel) {
        expect(line, `${file}: ${line}`).not.toMatch(/^(export\s+)?(let|var)\s/)
        expect(line, `${file}: ${line}`).not.toMatch(/new\s+(Map|Set|WeakMap|WeakSet|Array)\b/)
        expect(line, `${file}: ${line}`).not.toMatch(/\/[gy]*[gy][a-z]*\)?\s*$/)
        expect(line, `${file}: ${line}`).not.toMatch(/globalThis|process\.env/)
      }
    }
  })

  it('detectCanaryLeak and encapsulate are pure across interleaved calls', () => {
    const first = canaryModule.canary()
    const second = canaryModule.canary()
    const text = `ref ${first} and ${Buffer.from(second).toString('base64')}`
    const a1 = leakModule.detectCanaryLeak(text, first)
    const b = leakModule.detectCanaryLeak(text, second)
    const a2 = leakModule.detectCanaryLeak(text, first)
    expect(a2).toEqual(a1)
    expect(b.forms).toEqual(['base64'])
    expect(a1.forms).toContain('raw')

    const n = nonceModule.nonce()
    const once = encapsulateModule.encapsulate('payload', n, 'customer_message')
    encapsulateModule.encapsulate('other </customer_message_x>', nonceModule.nonce(), 'untrusted_breach')
    expect(encapsulateModule.encapsulate('payload', n, 'customer_message')).toBe(once)
  })

  it('rejects writes to exported tables', () => {
    expect(() => {
      ;(foldModule.CONFUSABLES as Record<string, string>)['x'] = 'y'
    }).toThrow(TypeError)
    expect(() => {
      ;(leakModule.LEAK_FORMS as unknown as string[]).push('rot13')
    }).toThrow(TypeError)
    expect(() => {
      ;(encapsulateModule.JSON_ESCAPES as Record<string, string>)['<'] = '<'
    }).toThrow(TypeError)
  })
})
