// Pipeline orchestrator: thread in, (draft + note + verdict) out.
// Two callers share this: the backtest harness (Phase 1) and the drafting
// edge function (Phase 2). See docs/ai-draft-pipeline-spec.md.

import { callClassify, callDraft } from './anthropic'
import { buildAllowedFigures, runGuardrails, threadUrlSet } from './guardrails'
import { sliceGrounding } from './grounding'
import {
  buildClassifySystem,
  buildClassifyUser,
  buildDraftSystem,
  buildDraftUser,
} from './prompts'
import type { ClassifyResult, GroundingData, PipelineResult, ThreadMessage } from './types'
import { PILOT_CATEGORIES } from './types'
import { normaliseBody } from './htmlText'

// The website's artwork-request form has a fixed structure; submissions are
// Graphics work and the auto-responder already acknowledged them, so they
// are routed deterministically — no AI call, no draft (review item 8).
// Keyed on the MESSAGE, never the subject: the "Artwork request from…"
// subject persists for the whole conversation, including later turns that
// SHOULD draft.
const ARTWORK_FORM_RES = [
  /Card Specifications[\s\S]{0,3000}Customer Details/,
  /api\.typeform\.com\/responses\/files/,
]

export function isArtworkFormSubmission(thread: ThreadMessage[]): boolean {
  const lastCustomer = [...thread].reverse().find((m) => m.role === 'customer')
  if (!lastCustomer) return false
  const body = normaliseBody(lastCustomer.body)
  return ARTWORK_FORM_RES.some((re) => re.test(body))
}

export interface PipelineInput {
  conversationId: number | string
  subject: string
  customerFirstName: string
  // The thread as it stood when a reply was needed (backtest: cut just before
  // the first staff reply; live: the whole thread so far).
  thread: ThreadMessage[]
}

export async function runPipeline(
  input: PipelineInput,
  grounding: GroundingData,
): Promise<PipelineResult> {
  const usage = { inputTokens: 0, outputTokens: 0 }

  // 0. Deterministic pre-gate: artwork-form submissions route to Graphics
  // without any AI involvement.
  if (isArtworkFormSubmission(input.thread)) {
    const classification: ClassifyResult = {
      is_genuine_customer_email: true,
      category: 'artwork',
      confidence: 'high',
      summary: 'Artwork-request form submission (deterministic pre-gate)',
      mentioned_materials: [],
      mentioned_quantities: [],
      currency_hint: 'unknown',
    }
    return {
      conversationId: input.conversationId,
      classification,
      grounded: false,
      draft: null,
      guardrails: null,
      outcome: 'abstained',
      abstainOrBlockReason:
        'artwork-request form submission — route to Graphics (auto-responder already acknowledged)',
      noteWarnings: [],
      usage,
    }
  }

  // 1. Classify.
  const classify = await callClassify(
    buildClassifySystem(),
    buildClassifyUser(input.thread, input.subject),
  )
  usage.inputTokens += classify.usage.inputTokens
  usage.outputTokens += classify.usage.outputTokens
  const classification = classify.result

  if (!classification.is_genuine_customer_email) {
    return {
      conversationId: input.conversationId,
      classification,
      grounded: false,
      draft: null,
      guardrails: null,
      outcome: 'skipped',
      abstainOrBlockReason: 'not a genuine customer email',
      noteWarnings: [],
      usage,
    }
  }

  // 2. Category/confidence gate — pilot categories at medium+ confidence
  // reach the drafter; artwork also passes through, but only for the
  // two-line Graphics handoff the house rules describe (review item 12).
  // Everything else: silence is a feature.
  const draftable =
    PILOT_CATEGORIES.has(classification.category) || classification.category === 'artwork'
  if (!draftable || classification.confidence === 'low') {
    return {
      conversationId: input.conversationId,
      classification,
      grounded: false,
      draft: null,
      guardrails: null,
      outcome: 'abstained',
      abstainOrBlockReason: draftable
        ? `low classifier confidence (${classification.category})`
        : `category outside pilot scope (${classification.category})`,
      noteWarnings: [],
      usage,
    }
  }

  // 3. Ground + draft.
  const slice = sliceGrounding(
    grounding,
    classification.mentioned_materials,
    classification.currency_hint,
  )
  const draftCall = await callDraft(
    buildDraftSystem(classification.category, slice),
    buildDraftUser(input.thread, input.subject, classification, input.customerFirstName),
  )
  usage.inputTokens += draftCall.usage.inputTokens
  usage.outputTokens += draftCall.usage.outputTokens
  const draft = draftCall.result

  if (!draft.should_draft || !draft.draft_body) {
    return {
      conversationId: input.conversationId,
      classification,
      grounded: true,
      draft,
      guardrails: null,
      outcome: 'abstained',
      abstainOrBlockReason: draft.abstain_reason ?? 'model abstained without a reason',
      noteWarnings: [],
      usage,
    }
  }

  // 4. Hard gates on the rendered draft text. Echo-only links (proof URLs)
  // must already exist in the inbound thread.
  const allowed = buildAllowedFigures(grounding, input.thread, slice)
  const threadUrls = threadUrlSet(input.thread)
  const verdict = runGuardrails(draft.draft_body, allowed, threadUrls)

  // Advisory pass over the internal note: warnings only, never blocking —
  // legitimate working notes contain arithmetic outside the gate's
  // transforms (unit prices, per-card breakdowns).
  const noteVerdict = draft.note_body ? runGuardrails(draft.note_body, allowed, threadUrls) : { ok: true as const }

  return {
    conversationId: input.conversationId,
    classification,
    grounded: true,
    draft,
    guardrails: verdict,
    outcome: verdict.ok ? 'drafted' : 'blocked',
    abstainOrBlockReason: verdict.ok ? null : verdict.reasons.join('; '),
    noteWarnings: noteVerdict.ok ? [] : noteVerdict.reasons,
    usage,
  }
}
