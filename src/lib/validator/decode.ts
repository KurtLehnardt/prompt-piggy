import { Buffer } from 'node:buffer'
import { deepFreeze } from '@/lib/config/deep-freeze'
import { fold } from '@/lib/security/fold'
import { WHITESPACE } from '@/lib/validator/detector-phrases'
import type { DecodedRun, DecodeKind } from '@/lib/validator/types'

/**
 * Bounded decode probes (docs/ARCHITECTURE.md sections 6.2 and 8.1; T26).
 *
 * decodeProbes() looks for base64 (standard and URL-safe), hex, URL-encoded,
 * and decimal-character-code runs in the folded message, in the order they
 * appear, and decodes at most DECODE_LIMITS.maxRuns of them. A run counts only
 * when it decodes to at least DECODE_LIMITS.minPrintable printable characters
 * (valid UTF-8 without control characters), which is also the condition of
 * the `decode` detector. Each decoded run is cut at DECODE_LIMITS.maxDecodedBytes,
 * and at most DECODE_LIMITS.maxCandidates candidate runs are tried, so the
 * work is linear in the input and a decode bomb cannot grow it. Invalid input
 * never throws: a run that does not decode is skipped.
 *
 * reversedText() is the fifth probe: the message read backwards, searched by
 * the phrase detectors and by long keywords like any decoded form.
 *
 * Decoding is one level deep. A decoded run is not decoded again.
 */

export const DECODE_LIMITS = deepFreeze({
  /** At most this many decoded runs per message. */
  maxRuns: 3,
  /** Each decoded run is cut at this many bytes (4 KB). */
  maxDecodedBytes: 4096,
  /** A run must decode to at least this many printable characters. */
  minPrintable: 12,
  /** At most this many candidate runs are tried per message. */
  maxCandidates: 64,
  /** The shortest base64 run tried: 16 characters encode 12 bytes. */
  minBase64Chars: 16,
  /** The shortest hex run tried: 24 digits encode 12 bytes. */
  minHexChars: 24,
  /** A URL-encoded run needs at least this many %XX escapes. */
  minUrlEscapes: 3,
  /** A decimal run needs at least this many character codes. */
  minDecimalCodes: 12,
})

type Candidate = { start: number; kind: DecodeKind | 'base64_or_hex'; text: string }

const MAX_BASE64_CHARS = Math.ceil(DECODE_LIMITS.maxDecodedBytes / 3) * 4
const MAX_HEX_CHARS = DECODE_LIMITS.maxDecodedBytes * 2

function isBase64Char(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2f ||
    code === 0x2d ||
    code === 0x5f
  )
}

function isHexChar(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66)
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39
}

/**
 * Decodes bytes as UTF-8 and returns the text when it is valid, has at least
 * minPrintable characters, and contains no control character other than tab,
 * line feed, and carriage return. Otherwise null.
 */
function printableText(bytes: Uint8Array): string | null {
  const cut = bytes.subarray(0, DECODE_LIMITS.maxDecodedBytes)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(cut)
  } catch {
    // A cut in the middle of a multi-byte character, or invalid UTF-8.
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(cut.subarray(0, Math.max(0, cut.length - 3)))
    } catch {
      return null
    }
  }
  let count = 0
  for (const char of text) {
    const code = char.codePointAt(0) as number
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      count += 1
      continue
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0xfffd) return null
    count += 1
  }
  return count >= DECODE_LIMITS.minPrintable ? text : null
}

function decodeBase64(run: string): string | null {
  let body = run.slice(0, MAX_BASE64_CHARS)
  while (body.endsWith('=')) body = body.slice(0, -1)
  if (body.length % 4 === 1) body = body.slice(0, -1)
  return printableText(new Uint8Array(Buffer.from(body, 'base64')))
}

function decodeHex(run: string): string | null {
  const body = run.slice(0, MAX_HEX_CHARS)
  const even = body.length - (body.length % 2)
  return printableText(new Uint8Array(Buffer.from(body.slice(0, even), 'hex')))
}

function decodeUrl(run: string): string | null {
  const bytes: number[] = []
  const encoder = new TextEncoder()
  for (let index = 0; index < run.length && bytes.length < DECODE_LIMITS.maxDecodedBytes; ) {
    const code = run.charCodeAt(index)
    if (
      code === 0x25 &&
      index + 2 < run.length &&
      isHexChar(run.charCodeAt(index + 1)) &&
      isHexChar(run.charCodeAt(index + 2))
    ) {
      bytes.push(Number.parseInt(run.slice(index + 1, index + 3), 16))
      index += 3
      continue
    }
    const char = String.fromCodePoint(run.codePointAt(index) as number)
    for (const byte of encoder.encode(char)) bytes.push(byte)
    index += char.length
  }
  return printableText(Uint8Array.from(bytes))
}

function decodeDecimal(codes: readonly number[]): string | null {
  const bytes = Uint8Array.from(codes.slice(0, DECODE_LIMITS.maxDecodedBytes))
  return printableText(bytes)
}

/** Counts the %XX escapes in a run. */
function urlEscapes(run: string): number {
  let count = 0
  for (let index = 0; index + 2 < run.length; index += 1) {
    if (run.charCodeAt(index) === 0x25 && isHexChar(run.charCodeAt(index + 1)) && isHexChar(run.charCodeAt(index + 2))) {
      count += 1
      index += 2
    }
  }
  return count
}

/** Base64 and hex runs: maximal runs of the base64 alphabet, with up to two '=' of padding. */
function alphabetRuns(text: string, out: Candidate[]): void {
  let index = 0
  while (index < text.length && out.length < DECODE_LIMITS.maxCandidates * 4) {
    if (!isBase64Char(text.charCodeAt(index))) {
      index += 1
      continue
    }
    const start = index
    while (index < text.length && isBase64Char(text.charCodeAt(index))) index += 1
    let end = index
    while (end < text.length && end - index < 2 && text.charCodeAt(end) === 0x3d) end += 1
    const run = text.slice(start, end)
    if (run.length >= Math.min(DECODE_LIMITS.minBase64Chars, DECODE_LIMITS.minHexChars)) {
      out.push({ start, kind: 'base64_or_hex', text: run })
    }
    index = end
  }
}

/** URL-encoded runs: whitespace-delimited chunks with enough %XX escapes. */
function urlRuns(text: string, out: Candidate[]): void {
  let index = 0
  while (index < text.length && out.length < DECODE_LIMITS.maxCandidates * 4) {
    if (WHITESPACE.test(text[index])) {
      index += 1
      continue
    }
    const start = index
    while (index < text.length && !WHITESPACE.test(text[index])) index += 1
    const chunk = text.slice(start, index)
    if (chunk.includes('%') && urlEscapes(chunk) >= DECODE_LIMITS.minUrlEscapes) {
      out.push({ start, kind: 'url', text: chunk })
    }
  }
}

/**
 * Decimal character-code runs: numbers of 1 to 3 digits separated by spaces,
 * commas, or semicolons. The run's text is kept as the comma-joined codes.
 */
function decimalRuns(text: string, out: Candidate[]): void {
  let index = 0
  let codes: number[] = []
  let start = -1
  const flush = () => {
    if (codes.length >= DECODE_LIMITS.minDecimalCodes) out.push({ start, kind: 'decimal', text: codes.join(',') })
    codes = []
    start = -1
  }
  while (index < text.length && out.length < DECODE_LIMITS.maxCandidates * 4) {
    const code = text.charCodeAt(index)
    if (isDigit(code)) {
      const numberStart = index
      while (index < text.length && isDigit(text.charCodeAt(index))) index += 1
      const digits = index - numberStart
      const value = digits <= 3 ? Number(text.slice(numberStart, index)) : -1
      if (value < 0 || value > 255) {
        flush()
        continue
      }
      if (start < 0) start = numberStart
      codes.push(value)
      continue
    }
    if (code === 0x20 || code === 0x2c || code === 0x3b || code === 0x09) {
      index += 1
      continue
    }
    flush()
    index += 1
  }
  flush()
}

function decodeCandidate(candidate: Candidate): DecodedRun | null {
  switch (candidate.kind) {
    case 'url': {
      const text = decodeUrl(candidate.text)
      return text === null ? null : { kind: 'url', text }
    }
    case 'decimal': {
      const text = decodeDecimal(candidate.text.split(',').map(Number))
      return text === null ? null : { kind: 'decimal', text }
    }
    default: {
      const run = candidate.text
      let allHex = run.length >= DECODE_LIMITS.minHexChars
      for (let index = 0; allHex && index < run.length; index += 1) {
        if (!isHexChar(run.charCodeAt(index))) allHex = false
      }
      if (allHex) {
        const hex = decodeHex(run)
        if (hex !== null) return { kind: 'hex', text: hex }
      }
      if (run.length < DECODE_LIMITS.minBase64Chars) return null
      const base64 = decodeBase64(run)
      return base64 === null ? null : { kind: 'base64', text: base64 }
    }
  }
}

/**
 * The decoded runs of a message, in order of appearance, at most
 * DECODE_LIMITS.maxRuns. Never throws for a string; returns [] for anything else.
 */
export function decodeProbes(input: string): DecodedRun[] {
  if (typeof input !== 'string' || input.length === 0) return []
  let text: string
  try {
    text = fold(input)
  } catch {
    return []
  }
  const candidates: Candidate[] = []
  alphabetRuns(text, candidates)
  urlRuns(text, candidates)
  decimalRuns(text, candidates)
  candidates.sort((a, b) => a.start - b.start)

  const runs: DecodedRun[] = []
  let tried = 0
  for (const candidate of candidates) {
    if (runs.length >= DECODE_LIMITS.maxRuns || tried >= DECODE_LIMITS.maxCandidates) break
    tried += 1
    try {
      const decoded = decodeCandidate(candidate)
      if (decoded !== null) runs.push(decoded)
    } catch {
      // Malformed input is skipped, never thrown.
    }
  }
  return runs
}

/** The text read backwards, by code point. */
export function reversedText(text: string): string {
  if (typeof text !== 'string') return ''
  return Array.from(text).reverse().join('')
}

Object.freeze(decodeProbes)
Object.freeze(reversedText)
