// Live briefing for the drafter: the house rules + exemplars, read from the
// admin-editable DB tables (migration 000225) with the compiled TS constants as
// a hard fail-safe. ONLY rules + exemplars are DB-backed; the tone guide,
// approved-links list and the supplier/secrecy/forbidden-phrase guardrails stay
// in code and are never proposable.
//
// Why a fallback, and why it's loud: the drafter reads these on the live path
// via its service-role client. A missing grant / dropped table / empty result
// must degrade to "the code briefing" (exactly what shipped), NEVER to "no
// briefing" — a drafter with no house rules would quote freely and leak. The
// fallback is logged to audit_log so a *permanent* silent fallback (e.g. a grant
// that never landed, so your approved edits quietly stop taking effect) is
// visible rather than invisible.
//
// The backtest harness never calls this — runPipeline defaults `briefing` to
// DEFAULT_BRIEFING (the constants), so the laptop run stays anon-only and
// byte-reproducible. Only the edge worker passes a fetched briefing.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { HOUSE_RULES } from './briefing/houseRules.ts'
import { EXEMPLARS, type Exemplar } from './briefing/exemplars.ts'
import type { Category } from './types.ts'
import { logAudit } from '../audit.ts'

export interface Briefing {
  houseRules: string[]
  exemplars: Exemplar[]
}

// The immutable fail-safe: exactly what is compiled into the bundle, and the
// byte-identical source the DB tables are seeded from (guarded by
// scripts/briefing-seed.ts).
export const DEFAULT_BRIEFING: Briefing = { houseRules: HOUSE_RULES, exemplars: EXEMPLARS }

// Read the active briefing from the DB (ordered), falling back to the compiled
// constants on ANY error or empty result. `client` must be the service-role,
// proofs-schema client (the worker's `admin`). Never throws.
export async function fetchBriefing(client: SupabaseClient): Promise<Briefing> {
  try {
    const [rulesRes, exRes] = await Promise.all([
      client
        .from('ai_draft_house_rules')
        .select('rule_text')
        .eq('is_active', true)
        .order('sort_order', { ascending: true }),
      client
        .from('ai_draft_exemplars')
        .select('category, customer_text, reply_text')
        .eq('is_active', true)
        .order('sort_order', { ascending: true }),
    ])

    // Drop malformed rows defensively so one bad row can't inject "null" into
    // the prompt or a hollow exemplar.
    const rules = ((rulesRes.data ?? []) as { rule_text?: unknown }[])
      .map((r) => r.rule_text)
      .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    const exemplars = ((exRes.data ?? []) as { category?: unknown; customer_text?: unknown; reply_text?: unknown }[])
      .filter(
        (e) =>
          typeof e.category === 'string' &&
          typeof e.customer_text === 'string' &&
          typeof e.reply_text === 'string',
      )

    // Hard fallback to the compiled constants when the DB is unreadable (either
    // query errored) or there are NO house rules. Zero house rules is a SAFETY
    // regression — the drafter would quote and leak unconstrained — so it falls
    // back. Zero exemplars is only a voice/quality matter (the rules still
    // constrain the facts), so the DB rules are kept even when an admin has
    // cleared every exemplar — we never silently override their edits.
    if (rulesRes.error || exRes.error || rules.length === 0) {
      await logBriefingFallback(client, {
        rules_error: rulesRes.error?.message ?? null,
        exemplars_error: exRes.error?.message ?? null,
        rules_count: rules.length,
        exemplars_count: exemplars.length,
      })
      return DEFAULT_BRIEFING
    }

    return {
      houseRules: rules,
      exemplars: exemplars.map((e) => ({
        category: (e as { category: string }).category as Category,
        customer: (e as { customer_text: string }).customer_text,
        reply: (e as { reply_text: string }).reply_text,
      })),
    }
  } catch (err) {
    await logBriefingFallback(client, { thrown: (err as Error).message })
    return DEFAULT_BRIEFING
  }
}

async function logBriefingFallback(client: SupabaseClient, metadata: Record<string, unknown>): Promise<void> {
  // A guaranteed signal even if the audit_log write below also fails: the
  // audit row is the durable record, but a console line ensures the fallback is
  // never wholly evidence-free in the edge runtime log.
  console.warn('[ai-draft] briefing fell back to compiled constants', JSON.stringify(metadata))
  await logAudit(client, {
    actorLabel: 'AI draft (system)',
    action: 'ai_draft.briefing_fallback',
    targetType: 'ai_draft_briefing',
    metadata: { ...metadata, used: 'compiled_ts_constants' },
  }).catch(() => {})
}
