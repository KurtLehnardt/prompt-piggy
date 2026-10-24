/**
 * Mocked US dollars, always held as integer cents (docs/ARCHITECTURE.md
 * section 9.4, CH-1). These helpers only convert to and from display text;
 * they never compute a balance, a price, or a payout.
 */

const DOLLARS = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0, useGrouping: true })

/** Throws unless the value is a safe integer number of cents. */
export function assertCents(cents: number): void {
  if (!Number.isSafeInteger(cents)) {
    throw new TypeError('Money amounts must be integer cents.')
  }
}

/**
 * Formats integer cents as US dollars: 100 -> "$1.00", 5 -> "$0.05",
 * 2000 -> "$20.00", 123456 -> "$1,234.56", -40 -> "-$0.40". It uses integer
 * arithmetic only, so no floating-point rounding can change an amount, and it
 * throws for a non-integer, NaN, or an unsafe integer.
 */
export function formatCents(cents: number): string {
  assertCents(cents)
  const sign = cents < 0 ? '-' : ''
  const magnitude = Math.abs(cents)
  const dollars = Math.floor(magnitude / 100)
  const remainder = magnitude % 100
  return `${sign}$${DOLLARS.format(dollars)}.${String(remainder).padStart(2, '0')}`
}

const DOLLAR_INPUT = /^\$?(\d{1,9})(?:\.(\d{1,2}))?$/

/**
 * Parses a dollar amount typed by a player, such as "5", "5.5", "$0.01", or
 * "20.00", into integer cents. Returns null for anything else, including
 * negative amounts, more than two decimal places, and thousands separators.
 * The server re-checks every amount.
 */
export function parseDollarsToCents(input: string): number | null {
  const match = DOLLAR_INPUT.exec(input.trim())
  if (!match) return null
  const dollars = Number(match[1])
  const fraction = (match[2] ?? '').padEnd(2, '0')
  return dollars * 100 + Number(fraction)
}
