import { deepFreeze } from '@/lib/config/deep-freeze'

/**
 * Caps on every rule set and Hardening Engine proposal (docs/ARCHITECTURE.md
 * section 6.3; HARDENING_CONSTRAINTS.md, orchestrator addition HC-A1).
 *
 * `block_keywords` are derived from attacker text, so they are data for
 * deterministic matching only: they are capped by length, character set, token
 * count, and number of entries, and they never reach an LLM prompt. The SQL
 * mirror `public.rule_set_payload_ok` (migration 00002) uses the same numbers,
 * and a sync test (PP-08) compares them with this file.
 */
export const CAPS = deepFreeze({
  /** `schema_version` is exactly this value. */
  schemaVersion: 1,
  /** Minimum length of a keyword, in characters, after normalization. */
  keywordMin: 8,
  /** Maximum length of a keyword, in characters, after normalization. */
  keywordMax: 48,
  /** A keyword has at least this many tokens. */
  keywordMinTokens: 2,
  /** A keyword has at most this many tokens. */
  keywordMaxTokens: 4,
  /** A content token has at least this many characters (section 6.3, R1-01). */
  contentTokenMin: 4,
  /** A Hardening Engine proposal adds at most this many keywords. */
  keywordsPerProposal: 3,
  /** A rule set (one level) holds at most this many keywords. */
  keywordsPerRuleSet: 32,
  /** A rule set's canonical JSON is at most this many UTF-8 bytes. */
  ruleSetBytes: 4096,
} as const)

/**
 * The charset and shape of a keyword: 2 to 4 tokens of ASCII lowercase letters
 * and digits, separated by single spaces, apostrophes, or hyphens. The `{1,3}`
 * repeat is `keywordMinTokens - 1` to `keywordMaxTokens - 1`.
 *
 * Only the source string is exported. A shared RegExp object carries mutable
 * `lastIndex` state, and zod resets it on every check, so each module that
 * needs one builds its own private instance from this string.
 */
export const KEYWORD_PATTERN = "^[a-z0-9]+(?:[ '-][a-z0-9]+){1,3}$"

/** The characters that separate keyword tokens. */
export const KEYWORD_TOKEN_SEPARATORS = deepFreeze([' ', "'", '-'] as const)
