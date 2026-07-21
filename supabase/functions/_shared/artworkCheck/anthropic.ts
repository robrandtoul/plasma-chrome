// Anthropic Messages API client for the artwork check — the aiDrafts client
// (../aiDrafts/anthropic.ts) with ONE net-new capability: multimodal user
// content. The aiDrafts calls send `content` as a string; this check needs a
// content ARRAY mixing text blocks (thread + QR + context) with base64 PDF
// document blocks (the print files). Kept as its own module rather than
// widening the live drafting client — the drafting pipeline stays untouched.
//
// Same conventions: raw fetch (runs under Deno and Node), structured output
// via output_config json_schema, adaptive thinking, 429/5xx retry honouring
// retry-after, prompt cache breakpoint on the stable system prefix.

import { ARTWORK_CHECK_SCHEMA } from './schema.ts'
import type { ModelReport, ReportUsage } from './types.ts'

declare const Deno: { env: { get(name: string): string | undefined } } | undefined

function readEnv(name: string): string | undefined {
  const fromDeno = typeof Deno !== 'undefined' ? Deno.env.get(name) : undefined
  if (fromDeno) return fromDeno
  return typeof process !== 'undefined' && process.env ? process.env[name] : undefined
}

export const DEFAULT_MODEL = 'claude-opus-4-8'

export function modelId(): string {
  return readEnv('ARTWORK_CHECK_MODEL') || DEFAULT_MODEL
}

const API_URL = 'https://api.anthropic.com/v1/messages'
const API_VERSION = '2023-06-01'

const ADAPTIVE_THINKING_MODELS = /^claude-(fable-5|opus-4-[6-9]|sonnet-4-6)/

// User content blocks: labelled text + base64 PDF documents. `title` names the
// file so findings can reference which card/file they came from.
export type ContentBlock =
  | { type: 'text'; text: string }
  | {
    type: 'document'
    source: { type: 'base64'; media_type: 'application/pdf'; data: string }
    title?: string
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

// Structured output + adaptive thinking headroom; the report itself is small.
const MAX_TOKENS = 16_000

const MAX_RETRIES = 3

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function postWithRetry(body: Record<string, unknown>): Promise<ApiMessage> {
  const apiKey = readEnv('ANTHROPIC_API_KEY')
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set (Supabase secret for the edge function).')
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

export async function callArtworkCheck(
  system: string,
  content: ContentBlock[],
): Promise<{ result: ModelReport; usage: ReportUsage }> {
  const model = modelId()
  const response = await postWithRetry({
    model,
    max_tokens: MAX_TOKENS,
    // One stable system block with a prompt-cache breakpoint — the rules are
    // identical across orders, so runs within the cache window re-read them at
    // ~0.1x. The per-order material/context all lives in the user content.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
    output_config: { format: { type: 'json_schema', schema: ARTWORK_CHECK_SCHEMA } },
    ...(ADAPTIVE_THINKING_MODELS.test(model) ? { thinking: { type: 'adaptive' } } : {}),
  })
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`response truncated at max_tokens (${MAX_TOKENS}) — report incomplete`)
  }
  if (response.stop_reason === 'refusal') {
    throw new Error('model refused this request (stop_reason: refusal)')
  }
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
  return {
    result: JSON.parse(text) as ModelReport,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_write_tokens: response.usage.cache_creation_input_tokens ?? 0,
      cache_read_tokens: response.usage.cache_read_input_tokens ?? 0,
    },
  }
}

// Base64 without the call-stack hazard of String.fromCharCode(...bytes) on
// multi-megabyte files (spread would overflow; chunked apply stays flat).
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
  }
  return btoa(binary)
}
