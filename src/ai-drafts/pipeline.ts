// Pipeline orchestrator: thread in, (draft + note + verdict) out.
// Two callers share this: the backtest harness (Phase 1) and the drafting
// edge function (Phase 2). See docs/ai-draft-pipeline-spec.md.

import { callClassify, callDraft } from './anthropic'
import { buildAllowedFigures, runGuardrails } from './guardrails'
import { sliceGrounding } from './grounding'
import {
  buildClassifySystem,
  buildClassifyUser,
  buildDraftSystem,
  buildDraftUser,
} from './prompts'
import type { GroundingData, PipelineResult, ThreadMessage } from './types'
import { PILOT_CATEGORIES } from './types'

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
      usage,
    }
  }

  // 2. Category/confidence gate — only pilot categories at medium+ confidence
  // reach the drafter. Silence is a feature.
  const inPilot = PILOT_CATEGORIES.has(classification.category)
  if (!inPilot || classification.confidence === 'low') {
    return {
      conversationId: input.conversationId,
      classification,
      grounded: false,
      draft: null,
      guardrails: null,
      outcome: 'abstained',
      abstainOrBlockReason: inPilot
        ? `low classifier confidence (${classification.category})`
        : `category outside pilot scope (${classification.category})`,
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
      usage,
    }
  }

  // 4. Hard gates on the rendered draft text.
  const allowed = buildAllowedFigures(grounding, input.thread)
  const verdict = runGuardrails(draft.draft_body, allowed)

  return {
    conversationId: input.conversationId,
    classification,
    grounded: true,
    draft,
    guardrails: verdict,
    outcome: verdict.ok ? 'drafted' : 'blocked',
    abstainOrBlockReason: verdict.ok ? null : verdict.reasons.join('; '),
    usage,
  }
}
