// Thin wrapper around the Anthropic SDK for the two pipeline calls.
// Model is env-overridable (AI_DRAFT_MODEL) so tiers can be trialled without
// code changes — adaptive thinking is only sent to models that accept it
// (Fable 5, Opus 4.6+, Sonnet 4.6); on other models it is omitted, which is
// valid everywhere.

import Anthropic from '@anthropic-ai/sdk'
import { CLASSIFY_SCHEMA, DRAFT_SCHEMA } from './schema'
import type { ClassifyResult, DraftResult } from './types'

export const DEFAULT_MODEL = 'claude-opus-4-8'

const ADAPTIVE_THINKING_MODELS = /^claude-(fable-5|opus-4-[6-9]|sonnet-4-6)/

let cachedClient: Anthropic | null = null

export function getClient(): Anthropic {
  if (!cachedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set. Add it to .env (see docs/ai-draft-pipeline-spec.md, Rob checklist step 1).',
      )
    }
    cachedClient = new Anthropic({ apiKey })
  }
  return cachedClient
}

export function modelId(): string {
  return process.env.AI_DRAFT_MODEL || DEFAULT_MODEL
}

export interface CallUsage {
  inputTokens: number
  outputTokens: number
}

function extractJson<T>(response: Anthropic.Message): T {
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  return JSON.parse(text) as T
}

// max_tokens includes adaptive-thinking tokens; 16000 gives the structured
// output ample headroom and costs nothing when unused (billing is per
// generated token). Above ~16k the SDK wants streaming.
const MAX_TOKENS = 16_000

async function structuredCall<T>(
  system: string,
  user: string,
  schema: Record<string, unknown>,
  effort?: 'low' | 'medium' | 'high',
): Promise<{ result: T; usage: CallUsage }> {
  const client = getClient()
  const model = modelId()
  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema }, ...(effort ? { effort } : {}) },
    ...(ADAPTIVE_THINKING_MODELS.test(model) ? { thinking: { type: 'adaptive' as const } } : {}),
  })
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`response truncated at max_tokens (${MAX_TOKENS}) — structured output incomplete`)
  }
  if (response.stop_reason === 'refusal') {
    throw new Error('model refused this request (stop_reason: refusal)')
  }
  const result = extractJson<T>(response)
  return {
    result,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  }
}

export async function callClassify(system: string, user: string): Promise<{ result: ClassifyResult; usage: CallUsage }> {
  // Triage is simple; medium effort keeps thinking spend proportionate.
  return structuredCall<ClassifyResult>(system, user, CLASSIFY_SCHEMA, 'medium')
}

export async function callDraft(system: string, user: string): Promise<{ result: DraftResult; usage: CallUsage }> {
  return structuredCall<DraftResult>(system, user, DRAFT_SCHEMA)
}
