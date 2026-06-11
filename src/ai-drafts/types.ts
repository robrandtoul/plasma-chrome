// Shared types for the AI draft pipeline (see docs/ai-draft-pipeline-spec.md).
// The same core runs under two callers: the local backtest harness (Phase 1)
// and, later, the drafting edge function (Phase 2).

export type Currency = 'GBP' | 'EUR' | 'USD'

export type Category =
  | 'quote_request'
  | 'lead_time'
  | 'capability_question'
  | 'sample_request'
  | 'order_details_collection'
  | 'order_status'
  | 'invoice_copy'
  | 'artwork'
  | 'complaint'
  | 'other'

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
  category: Category
  confidence: 'high' | 'medium' | 'low'
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
  note_body: string | null
  figures_used: FigureUsed[]
  links_used: string[]
}

// A money figure the pipeline is allowed to quote, with provenance for the note.
export interface GroundingFigure {
  amount: number
  currency: Currency
  description: string
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
  usage: { inputTokens: number; outputTokens: number }
}
