// Shared types for the AI draft pipeline (see docs/ai-draft-pipeline-spec.md).
// The same core runs under two callers: the local backtest harness (Phase 1)
// and, later, the drafting edge function (Phase 2).

import { CATEGORY_VALUES, CONFIDENCE_VALUES, CURRENCY_VALUES, NON_CUSTOMER_KIND_VALUES } from './schema.ts'

// Single source of truth for the wire enums is schema.ts — these types derive
// from the same tuples the JSON schemas spread, so drift cannot compile.
export type Currency = (typeof CURRENCY_VALUES)[number]
export type Category = (typeof CATEGORY_VALUES)[number]
export type Confidence = (typeof CONFIDENCE_VALUES)[number]
export type NonCustomerKind = (typeof NON_CUSTOMER_KIND_VALUES)[number]

// Categories the drafter is allowed to write for in Phase 1. Everything else
// is classified (triage signal) but never drafted — silence is a feature.
export const PILOT_CATEGORIES: ReadonlySet<Category> = new Set([
  'quote_request',
  'lead_time',
  'capability_question',
  'sample_request',
  'order_details_collection',
])

export interface ThreadMessage {
  role: 'customer' | 'staff' | 'note'
  createdAt: string
  author: string
  body: string
}

// One backtest fixture = one historical conversation (schema in backtest/README.md).
export interface FixtureConversation {
  conversationId: number
  subject: string
  createdAt: string
  status: string
  tags: string[]
  customerFirstName: string
  customerEmail: string
  slice: string
  heuristicCategory: Category | string | null
  thread: ThreadMessage[]
}

export interface ClassifyResult {
  is_genuine_customer_email: boolean
  // 'genuine' for a real customer email; otherwise which kind of non-customer
  // email it is (spam / supplier / automated_notification / other).
  non_customer_kind: NonCustomerKind
  category: Category
  confidence: Confidence
  summary: string
  mentioned_materials: string[]
  mentioned_quantities: number[]
  currency_hint: Currency | 'unknown'
}

export interface FigureUsed {
  amount: number
  currency: Currency
  source: string
}

export interface DraftResult {
  should_draft: boolean
  abstain_reason: string | null
  draft_body: string | null
  // Structured note fields (composeNote renders them for the reviewer).
  note_summary: string | null
  assumptions: string[]
  checks: string[]
  action: string | null
  figures_used: FigureUsed[]
  links_used: string[]
}

// A money figure the pipeline is allowed to quote, with provenance for the
// note. `kind` constrains how the guardrail may compose figures into sums:
// a tier (price-grid total) may combine with ONE add-on (an option surcharge
// for the same material+quantity, or a house-rule charge like personalisation)
// — never tier+tier or addon+addon, which would make the acceptance set so
// dense that hallucinated figures pass.
export interface GroundingFigure {
  amount: number
  currency: Currency
  description: string
  kind: 'tier' | 'addon'
  // For option surcharges: ties the add-on to its base tier row.
  matKey?: string
  quantity?: number
}

export interface MaterialLeadTime {
  code: string
  display_name: string
  category: string | null
  lead_time_min_days: number
  lead_time_max_days: number
}

export interface GroundingMaterialVariant {
  code: string
  display_name: string
  variant_type: string
  ink_count: number | null
  tiers: { quantity: number; total_price: number }[]
}

export interface GroundingMaterial {
  code: string
  display_name: string
  variants: GroundingMaterialVariant[]
  option_surcharges: { option_code: string; quantity: number; surcharge: number }[]
  minQuantity: number | null
}

export interface GroundingData {
  // Full per-currency price catalogue, used for guardrail reconciliation.
  byCurrency: Record<Currency, GroundingMaterial[]>
  leadTimes: MaterialLeadTime[]
  // Flat figure sets per currency (pence-rounded amounts) for the price gate.
  figures: GroundingFigure[]
  fetchedAt: string
}

export type GuardrailVerdict =
  | { ok: true }
  | { ok: false; reasons: string[] }

export interface PipelineResult {
  conversationId: number | string
  classification: ClassifyResult
  grounded: boolean
  draft: DraftResult | null
  guardrails: GuardrailVerdict | null
  // 'drafted' — draft produced and passed guardrails.
  // 'abstained' — model declined, or category/confidence gate stopped it.
  // 'blocked' — draft produced but a guardrail rejected it.
  // 'skipped' — not a genuine customer email.
  outcome: 'drafted' | 'abstained' | 'blocked' | 'skipped'
  abstainOrBlockReason: string | null
  // Advisory only (never blocks): unreconciled figures/links inside the
  // internal note, so reviewers know the note's workings are unvalidated.
  noteWarnings: string[]
  usage: {
    inputTokens: number
    outputTokens: number
    cacheWriteTokens: number
    cacheReadTokens: number
  }
  // The triage (classify) call's usage on its own, so the panel can price it at
  // the triage model's rate (which may be cheaper than the draft model). Absent
  // when no classify call ran (deterministic pre-filter / artwork-form pre-gate).
  triageUsage?: {
    inputTokens: number
    outputTokens: number
    cacheWriteTokens: number
    cacheReadTokens: number
  }
}
