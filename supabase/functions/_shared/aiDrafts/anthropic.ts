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

// NOTE: these gates match on model id, so a new model family needs adding here
// as well as to the admin dropdowns — a model that isn't matched silently runs
// WITHOUT adaptive thinking or effort, which is a quiet quality regression
// rather than an error. `opus-5` / `sonnet-5` are separate alternatives because
// the `4-x` patterns can't reach them.
const ADAPTIVE_THINKING_MODELS = /^claude-(fable-5|opus-5|opus-4-[6-9]|sonnet-5|sonnet-4-6)/
// effort is supported on Opus 4.5+, Opus 5, Sonnet 4.6, Sonnet 5, Fable 5 —
// NOT Haiku 4.5 or Sonnet 4.5 (they 400 on it). Gated so a cheaper-model
// override stays valid.
const EFFORT_MODELS = /^claude-(fable-5|opus-5|opus-4-([5-9])|sonnet-5|sonnet-4-6)/

export function modelId(): string {
  return draftModel() || DEFAULT_MODEL
}

// A system prompt is one or two text blocks; the first may be cacheable (the
// stable briefing prefix), so it carries a prompt-cache breakpoint.
export interface SystemPart {
  text: string
  cache?: boolean
}

export interface CallUsage {
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
}

interface ApiMessage {
  content: { type: string; text?: string }[]
  stop_reason: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

// Build the API `system` field from parts. A cacheable part gets a
// cache_control breakpoint with the 1-hour TTL: inbound mail is spaced
// ~8–20 minutes apart on live, so default 5-minute entries usually expired
// unread and every run re-paid the write premium. The 1h write costs 2x
// base input (vs 1.25x for 5m) and needs the prefix re-read within the
// hour to pay off — live spacing gives ~77–92% of runs a same-hour repeat.
function buildSystemField(parts: SystemPart[]): { type: 'text'; text: string; cache_control?: { type: 'ephemeral'; ttl: '1h' } }[] {
  return parts.map((p) => ({
    type: 'text' as const,
    text: p.text,
    ...(p.cache ? { cache_control: { type: 'ephemeral' as const, ttl: '1h' as const } } : {}),
  }))
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
  system: SystemPart[],
  user: string,
  schema: Record<string, unknown>,
  effort?: 'low' | 'medium' | 'high',
  modelOverride?: string,
): Promise<{ result: T; usage: CallUsage }> {
  // A blank/whitespace override falls back to the default model. Effort and
  // adaptive-thinking are gated by the resolved model below, so a cheaper
  // override (e.g. Haiku, which 400s on effort) just drops those params.
  const model = (modelOverride ?? '').trim() || modelId()
  const response = await postWithRetry({
    model,
    max_tokens: MAX_TOKENS,
    system: buildSystemField(system),
    messages: [{ role: 'user', content: user }],
    output_config: {
      format: { type: 'json_schema', schema },
      ...(effort && EFFORT_MODELS.test(model) ? { effort } : {}),
    },
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
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    },
  }
}

export async function callClassify(
  system: SystemPart[],
  user: string,
  modelOverride?: string,
): Promise<{ result: ClassifyResult; usage: CallUsage }> {
  // Triage is simple; medium effort keeps thinking spend proportionate. The
  // model is admin-overridable (settings.ai_drafts_triage_model) — triage runs
  // on every inbound incl. spam, so a cheaper model here is the main cost lever.
  return structuredCall<ClassifyResult>(
    system,
    user,
    CLASSIFY_SCHEMA as unknown as Record<string, unknown>,
    'medium',
    modelOverride,
  )
}

export async function callDraft(
  system: SystemPart[],
  user: string,
  modelOverride?: string,
): Promise<{ result: DraftResult; usage: CallUsage }> {
  // No effort hint: drafting is the quality-critical call, so it runs at the
  // API's default. The model is admin-overridable (settings.ai_drafts_model);
  // empty/null falls back to AI_DRAFT_MODEL then the compiled default.
  return structuredCall<DraftResult>(
    system,
    user,
    DRAFT_SCHEMA as unknown as Record<string, unknown>,
    undefined,
    modelOverride,
  )
}
