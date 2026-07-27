// What a Claude API call costs, for the Admin → Analytics spend figures.
//
// Rates are published per MILLION tokens and are in USD — Anthropic bills in
// USD regardless of where the business is, so USD is the honest primary figure
// and any GBP shown alongside is a conversion, not the invoice.
//
// ⚠ RATES GO STALE. They were taken from the Anthropic pricing reference on
// the date below; there is no API that returns them, so this table is the only
// place they live. If a figure here disagrees with the invoice, the invoice
// wins and this table should be corrected — same stance as the split-name
// surcharge table in CLAUDE.md.
export const PRICING_CHECKED_ON = '2026-07-27'

export interface ModelRate {
  /** USD per million input tokens. */
  inputPerMTok: number
  /** USD per million output tokens. */
  outputPerMTok: number
  /**
   * Promotional rate that replaces the standard one until (and including) this
   * date. Anthropic launched Sonnet 5 with an introductory price; without this
   * the panel would overstate Sonnet spend during the promo and understate it
   * the day after. Absent on models with no promotion.
   */
  intro?: { inputPerMTok: number; outputPerMTok: number; through: string }
}

// Only models the artwork check can actually be pointed at (the Admin →
// Artwork check picker). An unknown model is deliberately NOT guessed — see
// estimateRunCost.
export const MODEL_RATES: Record<string, ModelRate> = {
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-sonnet-5': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    intro: { inputPerMTok: 2, outputPerMTok: 10, through: '2026-08-31' },
  },
}

// Prompt-caching multipliers, applied to the model's INPUT rate.
//
// The write multiplier depends on the cache TTL, and the artwork check
// deliberately uses the default 5-minute cache (`cache_control: {type:
// 'ephemeral'}` with no ttl in _shared/artworkCheck/anthropic.ts) — the AI
// draft pipeline is the one that opted into 1h. If the check ever moves to a
// 1-hour TTL this becomes 2×, so the two must be changed together.
export const CACHE_WRITE_MULTIPLIER = 1.25
export const CACHE_READ_MULTIPLIER = 0.1

export interface TokenCounts {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_tokens?: number | null
  cache_write_tokens?: number | null
}

const n = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Effective rate for a model on a given day, applying any promotional pricing.
 *
 * `on` is a plain ISO date so the comparison is a string compare against the
 * promo's end date — no timezone arithmetic, and the boundary is inclusive
 * ("through" means the promo covers that day).
 */
export function rateFor(model: string, on: string): ModelRate | null {
  const rate = MODEL_RATES[model]
  if (!rate) return null
  if (rate.intro && on <= rate.intro.through) {
    return { inputPerMTok: rate.intro.inputPerMTok, outputPerMTok: rate.intro.outputPerMTok }
  }
  return { inputPerMTok: rate.inputPerMTok, outputPerMTok: rate.outputPerMTok }
}

/**
 * USD cost of a set of token counts, or null when the model isn't in the table.
 *
 * Null rather than 0 is the important part: an unrecognised model (a new one,
 * or the '(unrecorded)' bucket for pre-ledger runs) must read as "we can't
 * price this" on screen, not as "this was free" — a silent 0 would quietly
 * understate the total and nobody would notice.
 */
export function estimateRunCost(model: string, tokens: TokenCounts, on: string): number | null {
  const rate = rateFor(model, on)
  if (!rate) return null
  const perInputToken = rate.inputPerMTok / 1_000_000
  const perOutputToken = rate.outputPerMTok / 1_000_000
  return (
    n(tokens.input_tokens) * perInputToken +
    n(tokens.output_tokens) * perOutputToken +
    n(tokens.cache_write_tokens) * perInputToken * CACHE_WRITE_MULTIPLIER +
    n(tokens.cache_read_tokens) * perInputToken * CACHE_READ_MULTIPLIER
  )
}

export interface SpendTotal {
  /** USD across every model that could be priced. */
  usd: number
  /** Models present in the data with no rate — surfaced, never silently zeroed. */
  unpricedModels: string[]
  /** Runs attributed to those unpriced models. */
  unpricedRuns: number
}

/** Sum spend across per-model token buckets. */
export function totalSpend(
  rows: (TokenCounts & { model: string; runs?: number | null })[],
  on: string,
): SpendTotal {
  let usd = 0
  const unpricedModels: string[] = []
  let unpricedRuns = 0
  for (const row of rows) {
    const cost = estimateRunCost(row.model, row, on)
    if (cost == null) {
      if (!unpricedModels.includes(row.model)) unpricedModels.push(row.model)
      unpricedRuns += n(row.runs)
      continue
    }
    usd += cost
  }
  return { usd, unpricedModels, unpricedRuns }
}

/** Money for display. Sub-cent totals read as "<$0.01" rather than "$0.00". */
export function fmtUsd(v: number): string {
  if (v > 0 && v < 0.01) return '<$0.01'
  return `$${v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function fmtGbp(v: number): string {
  if (v > 0 && v < 0.01) return '<£0.01'
  return `£${v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
