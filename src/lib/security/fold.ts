import { deepFreeze } from '@/lib/config/deep-freeze'

/**
 * Text folding shared by the canary leak detector and the Dynamic Validator's
 * normalize() (docs/ARCHITECTURE.md sections 8.1 and 8.3, R1-S4, R1-21).
 *
 * fold() applies, in this order:
 *
 *   1. Unicode NFKC, which turns fullwidth forms, mathematical alphanumerics,
 *      circled and enclosed letters, superscripts, and ligatures into their
 *      plain equivalents.
 *   2. Removal of the zero-width characters U+200B to U+200F, U+2060, and
 *      U+FEFF.
 *   3. A fixed map of look-alike letters and digits (Cyrillic, Greek, Latin
 *      small capitals and other IPA letters, Armenian, and Cherokee) to ASCII.
 *
 * These are the same tables the validator's normalize() uses. A sync test
 * pins them once PP-08 lands. fold() only rewrites text for matching; it never
 * decides anything by itself, so ordinary phone input (accents, emoji, ZWJ
 * sequences, whole messages in one non-Latin script) passes through it
 * harmlessly.
 *
 * Every key in the confusables map is NFKC-stable (a test checks this), so
 * the map still applies after step 1, and every value is ASCII. The module is
 * pure, holds no state, and exports only frozen values (HC3).
 */

export const FOLD_NORMALIZATION = 'NFKC'

/** U+200B to U+200F, U+2060, and U+FEFF (docs/ARCHITECTURE.md section 8.1). */
export const ZERO_WIDTH_CODE_POINTS = deepFreeze([
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff,
] as const)

/**
 * Look-alike characters mapped to ASCII. Keys are single code points written
 * as escapes, so the table reads unambiguously in review.
 */
export const CONFUSABLES: Readonly<Record<string, string>> = deepFreeze({
  // Cyrillic capitals
  '\u0405': 'S',
  '\u0406': 'I',
  '\u0408': 'J',
  '\u0410': 'A',
  '\u0412': 'B',
  '\u0415': 'E',
  '\u0417': '3',
  '\u041A': 'K',
  '\u041C': 'M',
  '\u041D': 'H',
  '\u041E': 'O',
  '\u0420': 'P',
  '\u0421': 'C',
  '\u0422': 'T',
  '\u0423': 'Y',
  '\u0425': 'X',
  '\u04AE': 'Y',
  '\u04C0': 'I',
  '\u04E0': '3',
  '\u051A': 'Q',
  '\u051C': 'W',
  // Cyrillic small letters
  '\u0430': 'a',
  '\u0435': 'e',
  '\u043A': 'k',
  '\u043E': 'o',
  '\u0440': 'p',
  '\u0441': 'c',
  '\u0443': 'y',
  '\u0445': 'x',
  '\u0455': 's',
  '\u0456': 'i',
  '\u0458': 'j',
  '\u04BB': 'h',
  '\u04CF': 'l',
  '\u0501': 'd',
  '\u051B': 'q',
  '\u051D': 'w',
  // Greek capitals
  '\u037F': 'J',
  '\u0391': 'A',
  '\u0392': 'B',
  '\u0395': 'E',
  '\u0396': 'Z',
  '\u0397': 'H',
  '\u0399': 'I',
  '\u039A': 'K',
  '\u039C': 'M',
  '\u039D': 'N',
  '\u039F': 'O',
  '\u03A1': 'P',
  '\u03A4': 'T',
  '\u03A5': 'Y',
  '\u03A7': 'X',
  // Greek small letters
  '\u03B1': 'a',
  '\u03B3': 'y',
  '\u03B9': 'i',
  '\u03BA': 'k',
  '\u03BD': 'v',
  '\u03BF': 'o',
  '\u03C1': 'p',
  '\u03C5': 'u',
  '\u03C7': 'x',
  '\u03F3': 'j',
  // Latin letters outside ASCII that read as ASCII letters or digits
  '\u0131': 'i',
  '\u01B7': '3',
  '\u0222': '8',
  '\u0237': 'j',
  '\u0251': 'a',
  '\u0261': 'g',
  '\u0262': 'g',
  '\u0269': 'i',
  '\u026A': 'i',
  '\u0274': 'n',
  '\u0280': 'r',
  '\u028F': 'y',
  '\u0299': 'b',
  '\u029C': 'h',
  '\u029F': 'l',
  '\u1D00': 'a',
  '\u1D04': 'c',
  '\u1D05': 'd',
  '\u1D07': 'e',
  '\u1D0A': 'j',
  '\u1D0B': 'k',
  '\u1D0D': 'm',
  '\u1D0F': 'o',
  '\u1D18': 'p',
  '\u1D1B': 't',
  '\u1D1C': 'u',
  '\u1D20': 'v',
  '\u1D21': 'w',
  '\u1D22': 'z',
  '\uA731': 's',
  // Armenian
  '\u0555': 'O',
  '\u0570': 'h',
  '\u0578': 'n',
  '\u057D': 'u',
  '\u0585': 'o',
  // Cherokee capitals
  '\u13A2': 'T',
  '\u13AA': 'A',
  '\u13AB': 'J',
  '\u13AC': 'E',
  '\u13B3': 'W',
  '\u13B7': 'M',
  '\u13BB': 'H',
  '\u13C0': 'G',
  '\u13C3': 'Z',
  '\u13D9': 'V',
  '\u13DA': 'S',
  '\u13DE': 'L',
  '\u13DF': 'C',
  '\u13E2': 'P',
  '\u13E6': 'K',
  '\u13F4': 'B',
})

/** The tables as one frozen value, for the validator sync test. */
export const FOLD_TABLES = deepFreeze({
  normalization: FOLD_NORMALIZATION,
  zeroWidthCodePoints: ZERO_WIDTH_CODE_POINTS,
  confusables: CONFUSABLES,
})

/** True for the zero-width code points that fold() removes. */
export function isZeroWidth(codePoint: number): boolean {
  return (ZERO_WIDTH_CODE_POINTS as readonly number[]).includes(codePoint)
}

/** The ASCII replacement for one look-alike character, or the character itself. */
export function foldChar(char: string): string {
  return Object.prototype.hasOwnProperty.call(CONFUSABLES, char) ? CONFUSABLES[char] : char
}

/** Removes the zero-width characters and maps look-alikes, without normalizing. */
export function foldConfusables(text: string): string {
  let out = ''
  for (const char of text) {
    if (isZeroWidth(char.codePointAt(0) as number)) continue
    out += foldChar(char)
  }
  return out
}

/** NFKC, then zero-width removal, then the confusables map. Case is kept. */
export function fold(text: string): string {
  if (typeof text !== 'string') throw new TypeError('fold() needs a string.')
  return foldConfusables(text.normalize(FOLD_NORMALIZATION))
}

Object.freeze(isZeroWidth)
Object.freeze(foldChar)
Object.freeze(foldConfusables)
Object.freeze(fold)
