import { describe, expect, it } from 'vitest'
import {
  buildFailReply,
  FIXED_REPLIES,
  fixedReply,
  REPLY_MAX_CHARS,
  sanitizeReplyText,
  TRUNCATION_MARK,
  truncateReply,
} from '@/lib/ai/evaluator/reply'
import { isDeepFrozen } from '@/lib/config/deep-freeze'
import { canary as newCanary } from '@/lib/security/canary'

/**
 * src/lib/ai/evaluator/reply.ts (docs/ARCHITECTURE.md section 8.4; REVIEW-3
 * R3-07; T3).
 */

describe('truncateReply', () => {
  it('keeps a reply of up to 600 characters and cuts a longer one to exactly 600', () => {
    expect(REPLY_MAX_CHARS).toBe(600)
    const exact = 'a'.repeat(600)
    expect(truncateReply(exact)).toBe(exact)
    const cut = truncateReply('b'.repeat(5000))
    expect(cut).toHaveLength(600)
    expect(cut.endsWith(TRUNCATION_MARK)).toBe(true)
  })

  it('counts code points and never splits a surrogate pair', () => {
    const cut = truncateReply('🐷'.repeat(700))
    expect(Array.from(cut)).toHaveLength(600)
    expect(cut.isWellFormed()).toBe(true)
  })
})

describe('sanitizeReplyText [R3-07]', () => {
  it('removes NUL, other C0 and C1 controls, and lone surrogates, keeping newlines, tabs, and emoji', () => {
    const dirty = 'a\u0000b\u0007c\r\nd\te\u0085f\u009fg\ud800h\udc00i🐷j\u007f'
    expect(sanitizeReplyText(dirty)).toBe('abc\nd\tefghi🐷j')
    expect(sanitizeReplyText('café, naïve, “quotes”, 日本語')).toBe('café, naïve, “quotes”, 日本語')
  })
})

describe('buildFailReply', () => {
  it('returns the cleaned and truncated model text', () => {
    const { reply, leaked } = buildFailReply(`  Oink!\u0000 ${'x'.repeat(900)}  `, newCanary())
    expect(leaked).toBe(false)
    expect(reply.startsWith('Oink! x')).toBe(true)
    expect(Array.from(reply).length).toBeLessThanOrEqual(600)
    expect(reply).not.toContain('\u0000')
  })

  it('re-scans for the canary and withholds a leaking reply', () => {
    const canary = newCanary()
    expect(buildFailReply(`ref: ${canary}`, canary)).toEqual({ reply: FIXED_REPLIES.leak_blocked, leaked: true })
    // A canary hidden behind a control character is found after sanitizing.
    const hidden = `${canary.slice(0, 8)}\u0001${canary.slice(8)}`
    expect(buildFailReply(hidden, canary).leaked).toBe(true)
    // A partial run that survives truncation is still a leak.
    const tail = `${'y'.repeat(585)} ${canary.slice(3, 13)}`
    expect(buildFailReply(tail, canary).leaked).toBe(true)
  })

  it('returns fixed copy for empty text', () => {
    expect(buildFailReply(' \u0000 \n', newCanary())).toEqual({ reply: FIXED_REPLIES.fail_without_text, leaked: false })
  })
})

describe('fixed copy', () => {
  it('has fixed copy for win, blocked, leak_blocked, and error, none echoing input', () => {
    for (const outcome of ['win', 'late_win', 'blocked', 'leak_blocked', 'error'] as const) {
      const text = fixedReply(outcome)
      expect(text.length).toBeGreaterThan(10)
      expect(text.length).toBeLessThanOrEqual(600)
    }
    expect(isDeepFrozen(FIXED_REPLIES)).toBe(true)
  })
})
