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
//
// Since migration 000351 the briefing also carries a VERSION, which the worker
// stamps onto ai_drafts.briefing_version. That is what turns the Drafts panel's
// acceptance chart from a drifting line into a before/after: approve a rule
// change, and the drafts written after it are countable separately from the
// ones written before. The version is read best-effort and can never affect
// which briefing is used — see fetchBriefingVersion at the bottom.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { HOUSE_RULES } from './briefing/houseRules.ts'
import { EXEMPLARS, type Exemplar } from './briefing/exemplars.ts'
import type { Category } from './types.ts'
import { logAudit } from '../audit.ts'

export interface Briefing {
  houseRules: string[]
  exemplars: Exemplar[]
  // Which briefing this is, so the ledger can stamp it (ai_drafts.
  // briefing_version, migration 000351) and acceptance can be compared before
  // and after a rule change instead of eyeballed on one drifting trend line.
  //   >= 1  the live DB briefing — settings.ai_draft_briefing_version
  //   0     the compiled fallback below. NOT the DB briefing, and must never be
  //         recorded as though it were: once an admin has edited anything, the
  //         code briefing is nobody's live briefing.
  //   null  the DB briefing was used but its version could not be read.
  //         Honest "don't know" — never guessed at the current number.
  version: number | null
}

// Reserved marker for the compiled fallback. Sorts below every real version,
// which is exactly where it belongs.
export const FALLBACK_BRIEFING_VERSION = 0

// The immutable fail-safe: exactly what is compiled into the bundle, and the
// byte-identical source the DB tables are seeded from (guarded by
// scripts/briefing-seed.ts).
export const DEFAULT_BRIEFING: Briefing = {
  houseRules: HOUSE_RULES,
  exemplars: EXEMPLARS,
  version: FALLBACK_BRIEFING_VERSION,
}

// Read the active briefing from the DB (ordered), falling back to the compiled
// constants on ANY error or empty result. `client` must be the service-role,
// proofs-schema client (the worker's `admin`). Never throws.
export async function fetchBriefing(client: SupabaseClient): Promise<Briefing> {
  try {
    const [rulesRes, exRes, version] = await Promise.all([
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
      // Which briefing this is. Read in parallel so it costs no extra latency,
      // and read SEPARATELY (fetchBriefingVersion never throws or rejects) so
      // an unreadable version scalar can never drag the whole briefing into the
      // fallback — throwing away an admin's live rules over a bit of metadata
      // would be a safety regression in the opposite direction.
      fetchBriefingVersion(client),
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
        // What we WOULD have used, so an audit reader can see which briefing
        // the fallback displaced.
        db_version: version,
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
      version,
    }
  } catch (err) {
    await logBriefingFallback(client, { thrown: (err as Error).message })
    return DEFAULT_BRIEFING
  }
}

// The current briefing version from the settings singleton. Best-effort by
// design: returns null on ANY problem (missing column before migration 000351
// lands, a lost grant, a network blip) so the caller stamps an honest
// "unknown" rather than a wrong number, and the briefing itself is unaffected.
// Never throws — the caller awaits it inside a Promise.all alongside the two
// briefing reads.
//
// Why a failure is AUDITED and not just console.warn'd: null on ai_drafts.
// briefing_version means two different things — "written before we started
// stamping" (fine, historical) and "we could not read the version" (broken).
// The panel cannot tell them apart from the row alone, so a permanently broken
// read — a grant that never landed, a migration that never got applied — would
// render as a handful of ordinary-looking old rows and go unnoticed for weeks,
// quietly emptying the before/after comparison of its evidence. Same reasoning
// as the briefing fallback below, so it gets the same treatment: a durable
// audit row an admin can actually find in Admin → Activity.
//
// It logs once per occurrence, which on a broken read means one row per draft.
// That is the intended alarm, not an oversight — this should be loud and easy
// to spot, and when nothing is wrong it costs nothing at all.
async function fetchBriefingVersion(client: SupabaseClient): Promise<number | null> {
  try {
    const { data, error } = await client
      .from('settings')
      .select('ai_draft_briefing_version')
      .eq('id', 1)
      .maybeSingle()
    if (error) {
      await logVersionUnreadable(client, { error: error.message })
      return null
    }
    const v = (data as { ai_draft_briefing_version?: unknown } | null)?.ai_draft_briefing_version
    if (typeof v === 'number' && Number.isFinite(v)) return v
    // Read fine, but there was no usable number in it: no settings row, or the
    // column is missing/NULL. Still a broken read from the panel's point of
    // view, so it is reported the same way rather than passing as historical.
    await logVersionUnreadable(client, {
      error: null,
      settings_row_found: data != null,
      value_seen: v === undefined ? 'column absent' : JSON.stringify(v),
    })
    return null
  } catch (err) {
    await logVersionUnreadable(client, { thrown: (err as Error)?.message ?? String(err) })
    return null
  }
}

// The durable "we could not tell which briefing this was" signal. Mirrors
// logBriefingFallback: console line first so there is a trace even if the
// audit insert itself fails, then the audit row. Never throws.
async function logVersionUnreadable(client: SupabaseClient, metadata: Record<string, unknown>): Promise<void> {
  console.warn('[ai-draft] briefing version unreadable (briefing itself unaffected)', JSON.stringify(metadata))
  await logAudit(client, {
    actorLabel: 'AI draft (system)',
    action: 'ai_draft.briefing_version_unreadable',
    targetType: 'ai_draft_briefing',
    metadata: {
      ...metadata,
      // Spelled out for whoever finds this row months later without context.
      effect: 'draft stamped with briefing_version = null (unknown), briefing itself unaffected',
    },
  }).catch(() => {})
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
