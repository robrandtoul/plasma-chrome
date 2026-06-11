// Thin wrapper around the Anthropic SDK for the two pipeline calls.
// Model is env-overridable so we can trial tiers without code changes.

import Anthropic from '@anthropic-ai/sdk'
import { CLASSIFY_SCHEMA, DRAFT_SCHEMA } from './schema'
import type { ClassifyResult, DraftResult } from './types'

export const DEFAULT_MODEL = 'claude-opus-4-8'

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

async function structuredCall<T>(
  system: string,
  user: string,
  schema: object,
  maxTokens: number,
): Promise<{ result: T; usage: CallUsage }> {
  const client = getClient()
  const response = await client.messages.create({
    model: modelId(),
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema } },
  } as Anthropic.MessageCreateParamsNonStreaming)
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
  return structuredCall<ClassifyResult>(system, user, CLASSIFY_SCHEMA, 4000)
}

export async function callDraft(system: string, user: string): Promise<{ result: DraftResult; usage: CallUsage }> {
  return structuredCall<DraftResult>(system, user, DRAFT_SCHEMA, 8000)
}
