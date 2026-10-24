import 'server-only'
import { deepFreeze } from '@/lib/config/deep-freeze'
import { detectCanaryLeak } from '@/lib/security/leak-detector'

/**
 * The reply shown to the player (docs/ARCHITECTURE.md section 8.4; REVIEW-3
 * R3-07; T3).
 *
 * Only a `fail` shows model text, and only after three steps: characters
 * that Postgres text cannot store or that render as invisible control codes
 * are removed, the text is cut to 600 characters, and the result is scanned
 * for the canary again. Every other outcome shows fixed copy, so a win, a
 * block, a leak, or an error never echoes model or attacker text.
 */

/** The longest reply, in characters (Unicode code points). */
export const REPLY_MAX_CHARS = 600

/** Appended when a reply was cut. */
export const TRUNCATION_MARK = '…'

export const FIXED_REPLIES = deepFreeze({
  win: 'Penny approved the transfer. The vault is yours!',
  late_win: 'Penny approved the transfer, but another player emptied the vault first.',
  blocked: "The vault's security system stopped that message before it reached Penny.",
  leak_blocked: 'Penny started to reveal something confidential, so her reply was withheld.',
  error: 'Something went wrong on our side, so Penny could not answer. System errors are refunded within the hourly limit.',
  fail_without_text: 'Penny did not approve a transfer.',
} as const)

export type FixedReplyOutcome = Exclude<keyof typeof FIXED_REPLIES, 'fail_without_text'>

/** The fixed copy for an outcome that never shows model text. */
export function fixedReply(outcome: FixedReplyOutcome): string {
  return FIXED_REPLIES[outcome]
}

/**
 * Removes U+0000 and every other C0 and C1 control character except line
 * feed and tab, plus lone surrogates, so the reply can always be stored
 * (R3-07). Carriage returns go too, which turns CRLF into LF.
 */
export function sanitizeReplyText(text: string): string {
  let out = ''
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[index] + text[index + 1]
        index += 1
      }
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue
    if (code === 0x0a || code === 0x09) {
      out += text[index]
      continue
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue
    out += text[index]
  }
  return out
}

/** Cuts text to at most `max` code points, ending a cut text with the truncation mark. */
export function truncateReply(text: string, max: number = REPLY_MAX_CHARS): string {
  const points = Array.from(text)
  if (points.length <= max) return text
  return points.slice(0, max - 1).join('').trimEnd() + TRUNCATION_MARK
}

export type FailReply = {
  /** The text to show and store. */
  reply: string
  /** True when the final text still leaks the canary; the outcome becomes `leak_blocked`. */
  leaked: boolean
}

/**
 * The reply for a `fail`: the model's text, sanitized, cut to 600
 * characters, and re-scanned for the canary. A hit returns the fixed leak
 * copy. Empty text returns fixed copy.
 */
export function buildFailReply(modelText: string, canary: string): FailReply {
  const text = truncateReply(sanitizeReplyText(modelText).trim())
  if (detectCanaryLeak(text, canary).leaked) return { reply: FIXED_REPLIES.leak_blocked, leaked: true }
  if (text === '') return { reply: FIXED_REPLIES.fail_without_text, leaked: false }
  return { reply: text, leaked: false }
}
