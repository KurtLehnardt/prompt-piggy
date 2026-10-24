import 'server-only'

/**
 * OpenAI prices in US dollars per 1M tokens (docs/ARCHITECTURE.md sections
 * 8.8 and 9.4). spend.ts sizes reservations and settles spend from this table.
 *
 * The Decisions price is its own API price, separate from the same model's
 * Responses price, so entries are keyed by API and model.
 *
 * Every input token is priced at the uncached input rate, cached or not. That
 * overstates spend slightly and never understates it.
 *
 * PP-33 fills in the published prices, each with its source URL and date,
 * before the event. getPrice() fails closed: a configured model without an
 * entry throws, so nothing can run with an unknown cost.
 */

export type PricedApi = 'decisions' | 'responses'

export type ModelPrice = {
  inputUsdPer1M: number
  outputUsdPer1M: number
}

export const MODEL_PRICES: Readonly<Record<PricedApi, Readonly<Record<string, Readonly<ModelPrice>>>>> = Object.freeze({
  decisions: Object.freeze({
    // Verified: $0.10 per 1M uncached input tokens and no output charge
    // (developers.openai.com/api/docs/guides/decisions, 2026-10-24).
    'gpt-6-luna': Object.freeze({ inputUsdPer1M: 0.1, outputUsdPer1M: 0 }),
  }),
  responses: Object.freeze({
    // UNVERIFIED: read from developers.openai.com/api/docs/pricing on 2026-10-24; PP-33 confirms.
    'gpt-6-luna': Object.freeze({ inputUsdPer1M: 0.1, outputUsdPer1M: 0.5 }),
    // UNVERIFIED: read from developers.openai.com/api/docs/pricing on 2026-10-24; PP-33 confirms.
    'gpt-6.1-sol': Object.freeze({ inputUsdPer1M: 2, outputUsdPer1M: 10 }),
    // UNVERIFIED: read from developers.openai.com/api/docs/pricing on 2026-10-24; PP-33 confirms.
    'gpt-6-astra': Object.freeze({ inputUsdPer1M: 10, outputUsdPer1M: 50 }),
  }),
})

/** A configured model with no price. The message names the API and model only. */
export class PriceNotConfiguredError extends Error {
  readonly api: PricedApi
  readonly model: string

  constructor(api: PricedApi, model: string) {
    super(`No ${api} price is configured for model ${model}; add it to src/lib/ops/pricing.ts.`)
    this.name = 'PriceNotConfiguredError'
    this.api = api
    this.model = model
  }
}

/** Integer micro-dollars per 1M tokens. */
export type MicroPrice = {
  inputMicrosPer1M: number
  outputMicrosPer1M: number
}

/** Returns a model's price in integer micro-dollars per 1M tokens, or throws PriceNotConfiguredError. */
export function getPrice(api: PricedApi, model: string): MicroPrice {
  const table = MODEL_PRICES[api]
  const price = Object.hasOwn(table, model) ? table[model] : undefined
  if (!price) throw new PriceNotConfiguredError(api, model)
  return {
    inputMicrosPer1M: Math.round(price.inputUsdPer1M * 1_000_000),
    outputMicrosPer1M: Math.round(price.outputUsdPer1M * 1_000_000),
  }
}
