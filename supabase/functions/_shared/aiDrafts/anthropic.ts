// Anthropic Messages API client for the two pipeline calls — raw fetch, no
// SDK, so the identical code runs under Node (tsx backtest harness) and the
// Supabase Edge runtime (Deno). Structured outputs via output_config.format;
// adaptive thinking only on models that accept it. Retries 429/5xx with
// backoff, honouring retry-after. Model env-overridable via AI_DRAFT_MODEL.

import { anthropicApiKey, draftModel } from './env.ts'
import { CLASSIFY_SCHEMA, DRAFT_SCHEMA } from './schema.ts'
import type { ClassifyResult, DraftResult } from './types.ts'

export const DEFAULT_MODEL = 'claude-opus-4-8'

const API_URL = 'https://api.anthropic.com/v1/messages'
const API_VERSION = '2023-06-01'

const ADAPTIVE_THINKING_MODELS = /^claude-(fable-5|opus-4-[6-9]|sonnet-4-6)/

export function modelId(): string {
  return draftModel() || DEFAULT_MODEL
}

export interface CallUsage {
  inputTokens: number
  outputTokens: number
}

interface ApiMessage {
  content: { type: string; text?: string }[]
  stop_reason: string | null
  usage: { input_tokens: number; output_tokens: number }
}

// max_tokens includes adaptive-thinking tokens; 16000 gives the structured
// output ample headroom and costs nothing when unused. Above ~16k streaming
// would be needed.
const MAX_TOKENS = 16_000

const MAX_RETRIES = 3

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function postWithRetry(body: Record<string, unknown>): Promise<ApiMessage> {
  const apiKey = anthropicApiKey()
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set (.env locally; Supabase secret for the edge function).',
    )
  }
  let lastError = ''
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
    })
    if (response.ok) {
      return (await response.json()) as ApiMessage
    }
    const text = await response.text()
    lastError = `anthropic ${response.status}: ${text.slice(0, 300)}`
    // Retry only what is retryable; other 4xx is a request bug.
    if (response.status === 429 || response.status >= 500) {
      if (attempt < MAX_RETRIES) {
        const retryAfter = Number(response.headers.get('retry-after'))
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1500 * 2 ** attempt
        await sleep(Math.min(backoff, 30_000))
        continue
      }
    }
    break
  }
  throw new Error(lastError)
}

async function structuredCall<T>(
  system: string,
  user: string,
  schema: Record<string, unknown>,
  effort?: 'low' | 'medium' | 'high',
): Promise<{ result: T; usage: CallUsage }> {
  const model = modelId()
  const response = await postWithRetry({
    model,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema }, ...(effort ? { effort } : {}) },
    ...(ADAPTIVE_THINKING_MODELS.test(model) ? { thinking: { type: 'adaptive' } } : {}),
  })
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`response truncated at max_tokens (${MAX_TOKENS}) — structured output incomplete`)
  }
  if (response.stop_reason === 'refusal') {
    throw new Error('model refused this request (stop_reason: refusal)')
  }
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
  return {
    result: JSON.parse(text) as T,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  }
}

export async function callClassify(system: string, user: string): Promise<{ result: ClassifyResult; usage: CallUsage }> {
  // Triage is simple; medium effort keeps thinking spend proportionate.
  return structuredCall<ClassifyResult>(
    system,
    user,
    CLASSIFY_SCHEMA as unknown as Record<string, unknown>,
    'medium',
  )
}

export async function callDraft(system: string, user: string): Promise<{ result: DraftResult; usage: CallUsage }> {
  return structuredCall<DraftResult>(system, user, DRAFT_SCHEMA as unknown as Record<string, unknown>)
}
