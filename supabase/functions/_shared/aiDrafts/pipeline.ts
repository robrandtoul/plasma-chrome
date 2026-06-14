// Pipeline orchestrator: thread in, (draft + note + verdict) out.
// Two callers share this: the backtest harness (Phase 1) and the drafting
// edge function (Phase 2). See docs/ai-draft-pipeline-spec.md.

import { callClassify, callDraft, type CallUsage } from './anthropic.ts'
import { buildAllowedFigures, runGuardrails, threadUrlSet } from './guardrails.ts'
import { sliceGrounding } from './grounding.ts'
import { DEFAULT_BRIEFING, type Briefing } from './briefing.ts'
import {
  buildClassifySystem,
  buildClassifyUser,
  buildDraftSystemStable,
  buildDraftSystemVariable,
  buildDraftUser,
} from './prompts.ts'
import type { ClassifyResult, GroundingData, PipelineResult, ThreadMessage } from './types.ts'
import { PILOT_CATEGORIES } from './types.ts'
import { normaliseBody } from './htmlText.ts'

// Deterministic notification pre-filter: unmistakably-automated mail (payment
// receipts, shipping pings, order alerts) is skipped before any AI call. High
// precision by design — a real customer never sends from a no-reply address
// nor writes these exact subjects. Still LOGGED (the edge function records a
// skipped ledger row) so shadow can prove it never catches a real customer.
const NOTIFICATION_SENDER_RE =
  /^(no-?reply|do-?not-?reply|donotreply|notifications?|mailer|bounce|postmaster|automated|support@chargedesk|receipts?)/i
const NOTIFICATION_DOMAIN_RE =
  /@(.*\.)?(squarespace|worldpay|stripe|dpd|fedex|mailchimp|chargedesk|zapier|aircall)\.(com|net|co\.uk)$/i
const NOTIFICATION_SUBJECT_RE =
  /(payment of .* received|you'?ve paid|transaction confirmation|payment received|new order has arrived|we'?re expecting your parcel|out for delivery|your parcel|worldpay (card )?transaction)/i

export function isAutomatedNotification(
  subject: string,
  senderEmail: string | undefined,
  thread: ThreadMessage[],
): boolean {
  // A conversation with any staff reply is a real exchange, never a notification.
  if (thread.some((m) => m.role === 'staff')) return false
  const email = (senderEmail ?? '').trim().toLowerCase()
  const local = email.split('@')[0] ?? ''
  if (email && (NOTIFICATION_SENDER_RE.test(local) || NOTIFICATION_DOMAIN_RE.test(email))) return true
  if (NOTIFICATION_SUBJECT_RE.test(subject ?? '')) return true
  return false
}

function addUsage(acc: PipelineResult['usage'], u: CallUsage): void {
  acc.inputTokens += u.inputTokens
  acc.outputTokens += u.outputTokens
  acc.cacheWriteTokens += u.cacheWriteTokens
  acc.cacheReadTokens += u.cacheReadTokens
}

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
  // Primary customer email — feeds the deterministic notification pre-filter
  // (optional; the backtest fixtures don't carry it and don't need it).
  senderEmail?: string
  // The thread as it stood when a reply was needed (backtest: cut just before
  // the first staff reply; live: the whole thread so far).
  thread: ThreadMessage[]
}

export async function runPipeline(
  input: PipelineInput,
  grounding: GroundingData,
  // The live worker passes the DB-fetched briefing; the backtest omits it and
  // gets the compiled constants, keeping the laptop run byte-reproducible.
  briefing: Briefing = DEFAULT_BRIEFING,
): Promise<PipelineResult> {
  const usage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }

  // 0a. Deterministic notification pre-filter: skip before any AI call.
  if (isAutomatedNotification(input.subject, input.senderEmail, input.thread)) {
    return {
      conversationId: input.conversationId,
      classification: {
        is_genuine_customer_email: false,
        non_customer_kind: 'automated_notification',
        category: 'other',
        confidence: 'high',
        summary: 'Automated notification (deterministic pre-filter)',
        mentioned_materials: [],
        mentioned_quantities: [],
        currency_hint: 'unknown',
      },
      grounded: false,
      draft: null,
      guardrails: null,
      outcome: 'skipped',
      abstainOrBlockReason: 'automated notification — skipped before AI (deterministic pre-filter)',
      noteWarnings: [],
      usage,
    }
  }

  // 0b. Deterministic pre-gate: artwork-form submissions route to Graphics
  // without any AI involvement.
  if (isArtworkFormSubmission(input.thread)) {
    const classification: ClassifyResult = {
      is_genuine_customer_email: true,
      non_customer_kind: 'genuine',
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
    [{ text: buildClassifySystem(), cache: true }],
    buildClassifyUser(input.thread, input.subject),
  )
  addUsage(usage, classify.usage)
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
    [
      { text: buildDraftSystemStable(briefing.houseRules, briefing.exemplars), cache: true },
      { text: buildDraftSystemVariable(classification.category, slice) },
    ],
    buildDraftUser(input.thread, input.subject, classification, input.customerFirstName),
  )
  addUsage(usage, draftCall.usage)
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
  const allowed = buildAllowedFigures(grounding, input.thread, slice, briefing.houseRules)
  const threadUrls = threadUrlSet(input.thread)
  // Only the customer's OWN messages may seed the off-list URL echo exception —
  // never staff replies or internal notes (which hold supplier / internal links).
  const customerUrls = threadUrlSet(input.thread.filter((m) => m.role === 'customer'))
  const verdict = runGuardrails(draft.draft_body, allowed, threadUrls, customerUrls)

  // Advisory: any self-reported figure that does not reconcile against the
  // allowed set — surfaced to the reviewer, never blocking (the hard gate
  // already ran on the draft body).
  const noteWarnings = (draft.figures_used ?? [])
    .filter((f) => !allowed.accepts(f.currency, Math.round(f.amount * 100)))
    .map((f) => `self-reported figure ${f.amount} ${f.currency} (${f.source}) does not reconcile`)

  return {
    conversationId: input.conversationId,
    classification,
    grounded: true,
    draft,
    guardrails: verdict,
    outcome: verdict.ok ? 'drafted' : 'blocked',
    abstainOrBlockReason: verdict.ok ? null : verdict.reasons.join('; '),
    noteWarnings,
    usage,
  }
}
