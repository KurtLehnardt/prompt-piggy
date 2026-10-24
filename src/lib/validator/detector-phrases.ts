import { deepFreeze } from '@/lib/config/deep-freeze'

/**
 * The fixed detector catalog of the Dynamic Validator (docs/ARCHITECTURE.md
 * section 6.2; HC1, HC-A1, T24, T26).
 *
 * Everything here is a code constant reviewed in pull requests. Nothing that
 * a player, the Hardening Engine, or the database can influence extends it.
 * Levels 4 and 5 add operator phrases from `level_secrets` at call time, and
 * those are matched as token sequences by keywords.ts, never compiled into a
 * regular expression.
 *
 * This is the only file in src/lib/validator that holds regular expressions.
 * Each one is a fixed literal without the `g` or `y` flag, so it keeps no
 * `lastIndex` state between calls, and each one is frozen. None is built from
 * data, and none has nested or overlapping quantifiers, so matching is linear
 * in the input length.
 */

/** Bumped whenever a detector, a phrase, or the normalization changes. */
export const DETECTOR_VERSION = 1

/** The phrase families: the detector families matched as token sequences. */
export const PHRASE_FAMILIES = deepFreeze([
  'roleplay',
  'authority',
  'override',
  'tool',
  'deferred',
  'hypothetical',
] as const)

export type PhraseFamily = (typeof PHRASE_FAMILIES)[number]

/**
 * A phrase token that matches any number: a run of digits or a number word
 * from NUMBER_WORDS ("after 3 messages", "after five turns").
 */
export const NUMBER_WILDCARD = '#'

export const NUMBER_WORDS = deepFreeze([
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen', 'twenty', 'some', 'several',
] as const)

/**
 * The base phrases of each family, in normalized form: lowercase ASCII words
 * separated by single spaces. They are tokenized the same way as the message
 * (apostrophes, hyphens, and slashes split tokens), so "json-rpc" matches
 * "JSON-RPC", "json rpc", and "json/rpc", and "tools/call" matches
 * "tools call". The first entries of each family are the section 6.2 catalog,
 * verbatim; the rest are close variants.
 *
 * "bank manager" and "branch manager" are deliberately absent from the
 * AUTHORITY family: a branch-manager claim is the level 1 loophole (section
 * 8.3), and the loophole fixtures pin this.
 */
export const BASE_PHRASES = deepFreeze({
  roleplay: [
    'pretend you are',
    'act as',
    'you are now',
    'roleplay as',
    'developer mode',
    'jailbreak mode',
    'pretend to be',
    'pretend you re',
    'role play as',
    'you re now',
    'from now on you are',
    'dan mode',
    'god mode',
    'unrestricted mode',
  ],
  authority: [
    'i am the administrator',
    'root user',
    'admin override',
    'openai staff',
    'security team',
    'law enforcement',
    'i m the administrator',
    'i am the admin',
    'i m the admin',
    'i am an administrator',
    'i am your administrator',
    'i am your developer',
    'i am the developer',
    'i am your creator',
    'openai employee',
    'openai team',
    'system administrator',
    'superuser',
    'sudo',
  ],
  override: [
    'ignore previous',
    'disregard all',
    'new instructions',
    'forget your rules',
    'ignore all previous',
    'ignore the previous instructions',
    'ignore your instructions',
    'ignore your rules',
    'ignore all instructions',
    'ignore all rules',
    'ignore prior instructions',
    'ignore all prior',
    'ignore all your',
    'ignore your previous',
    'disregard your previous',
    'forget your previous',
    'ignore the above',
    'disregard previous',
    'disregard your instructions',
    'disregard your rules',
    'disregard the above',
    'forget your instructions',
    'forget all previous',
    'forget everything above',
    'override your instructions',
    'override your rules',
    'updated instructions',
  ],
  tool: [
    'approvetransfer',
    'function call',
    'tool call',
    'invoke the tool',
    'mcp',
    'json rpc',
    'tools call',
    'functioncall',
    'toolcall',
    'tool use',
    'call the tool',
    'call the function',
    'invoke the function',
  ],
  deferred: [
    'from now on',
    'after # messages',
    'next time',
    'remember this',
    'in the future',
    'when you see the word',
    'after # turns',
    'after # replies',
    'after # attempts',
    'after a few messages',
    'after a few turns',
    'from this point on',
    'from here on',
    'for all future',
    'the next user',
    'the next customer',
    'when i say the word',
    'whenever i say',
  ],
  hypothetical: [
    'hypothetically',
    'in a story',
    'for a novel',
    'imagine that',
    'for testing purposes',
    'in a hypothetical',
    'hypothetical scenario',
    'hypothetical world',
    'imagine you are',
    'for a story',
    'in a fictional',
    'in a novel',
    'for test purposes',
    'purely fictional',
  ],
} as const satisfies Record<PhraseFamily, readonly string[]>)

/**
 * DELIMITER patterns (section 6.2): chat-template tokens, opening or closing
 * system, developer, tool, or prompt-section tags, `[INST]`, `<<SYS>>`,
 * `### system` headers, fenced `system` blocks, a JSON `"role": "system"`
 * pair, and lines that start with `system:`, `developer:`, or `tool:`.
 *
 * They run on the normalized text (lowercase, newlines kept) of the message
 * and of each decoded run.
 */
export const DELIMITER_PATTERNS = deepFreeze([
  /<\|[a-z_]{1,32}\|>/,
  /<\/?\s{0,3}(?:system|developer|tool|assistant|user|instructions?|customer_message[a-z0-9_]{0,40}|untrusted_[a-z0-9_]{1,40}|im_start|im_end)\b[^<>\n]{0,64}>/,
  /\[\/?(?:inst|sys|system)\]/,
  /<<\/?sys>>/,
  /(?:^|\n)[ \t]{0,8}#{1,6}[ \t]{0,8}(?:system|developer|instructions?|assistant|tool)\b/,
  /```[ \t]{0,8}(?:system|developer|tool)\b/,
  /["'“”‘’]role["'“”‘’][ \t]{0,8}:[ \t]{0,8}["'“”‘’](?:system|developer|tool)\b/,
  /(?:^|\n)[ \t]{0,8}(?:system|developer|tool)[ \t]{0,8}:/,
].map((pattern) => Object.freeze(pattern)))

/** A letter, a combining mark, or a digit in any script. */
export const WORD_CHAR = Object.freeze(/[\p{L}\p{M}\p{N}]/u)

/** A combining mark (removed by normalize after NFKD). */
export const COMBINING_MARK = Object.freeze(/\p{M}/u)

/** A default-ignorable code point (soft hyphen, variation selectors, and the like). */
export const DEFAULT_IGNORABLE = Object.freeze(/\p{Default_Ignorable_Code_Point}/u)

/** Any whitespace character. */
export const WHITESPACE = Object.freeze(/\s/u)

/** An ASCII letter. */
export const ASCII_LETTER = Object.freeze(/[A-Za-z]/)

/** A letter of any script. */
export const ANY_LETTER = Object.freeze(/\p{L}/u)

/** A letter or mark of the Latin script (ASCII or not). */
export const LATIN_LETTER = Object.freeze(/\p{Script=Latin}/u)

/**
 * A letter from a script with look-alikes of Latin letters. A word that mixes
 * one of these with ASCII letters is the classic homoglyph evasion.
 */
export const CONFUSABLE_SCRIPT_LETTER = Object.freeze(
  /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}]/u
)

/** An emoji pictograph, which may follow or precede a zero-width joiner. */
export const EXTENDED_PICTOGRAPHIC = Object.freeze(/\p{Extended_Pictographic}/u)

/** An emoji skin-tone modifier, which may sit between a pictograph and a joiner. */
export const EMOJI_MODIFIER = Object.freeze(/\p{Emoji_Modifier}/u)
