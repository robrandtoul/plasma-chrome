// AI draft edit-miner (Phase 3c of docs/ai-draft-pipeline-spec.md; the spec for
// what it should find is docs/ai-draft-edit-review-2026-07.md, a manual pass of
// the same job).
//
// The thin half: authenticate, fetch, call the model once per category group,
// and file whatever survives the gates as PENDING proposals. All the decisions
// live in ../_shared/aiDrafts/miner.ts, which is pure and unit-tested
// (`pnpm test:ai-drafts-miner`).
//
// What it never does: write to ai_draft_house_rules or ai_draft_exemplars.
// Proposals go into the queue and an admin clicking Approve runs
// apply_ai_draft_proposal, which is the only path into the live briefing. That
// gate is the whole safety model, so nothing here is allowed to shortcut it.
//
// TWO LOCKS BEFORE ANYTHING IS WRITTEN:
//   1. proofs.settings.ai_draft_miner_enabled must be true (migration 000353;
//      false on every row until an admin turns it on), and
//   2. the request must say "dry_run": false.
// Anything else — flag off, flag missing, settings unreadable, body silent —
// computes the proposals and RETURNS them without inserting. A miner that
// starts filing by accident is exactly the failure we are designing out, so
// every uncertain path resolves to "show, don't write".
//
// Invocation is manual (service-role POST). No cron: whether this should run on
// a schedule is a decision for after Rob has read a run or two.
//
// Auth: service-role only — the same gate as ai-draft / send-nudges (the exact
// injected key, or a platform-verified JWT carrying the service_role claim).

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { logAudit } from '../_shared/audit.ts'
import { anthropicApiKey } from '../_shared/aiDrafts/env.ts'
import { modelId } from '../_shared/aiDrafts/anthropic.ts'
import {
  MINABLE_EDIT_CLASSES,
  MINER_SCHEMA,
  buildMinerSystem,
  buildMinerUser,
  groupByCategory,
  parseMinerResponse,
  planProposals,
  type CategoryGroup,
  type ExistingProposal,
  type HouseRuleRow,
  type MinerDraftRow,
  type ParseOutcome,
} from '../_shared/aiDrafts/miner.ts'

const DEFAULT_LOOKBACK_DAYS = 30
const MAX_LOOKBACK_DAYS = 365
// A hard ceiling on how many ledger rows one run pulls, so a first run over a
// long window can't fetch the entire table into memory.
const MAX_ROWS = 400
const DEFAULT_MAX_GROUPS = 8

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Role claim from a JWT payload without signature verification — safe here
// because the platform has already verified the JWT (verify_jwt = true).
function bearerRole(token: string): string | null {
  try {
    const payload = token.split('.')[1]
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    return typeof decoded?.role === 'string' ? decoded.role : null
  } catch {
    return null
  }
}

// ── Model call ──────────────────────────────────────────────────────────────
//
// Deliberately local rather than added to _shared/aiDrafts/anthropic.ts: that
// file is shared with the drafting pipeline and is being edited elsewhere, and
// this is the only caller of a third call shape. If the miner sticks around,
// folding this into anthropic.ts as a `callMine` sibling of callClassify /
// callDraft is the obvious tidy-up.

const API_URL = 'https://api.anthropic.com/v1/messages'
const API_VERSION = '2023-06-01'
const MAX_TOKENS = 16_000
const MAX_RETRIES = 3
// Mirrors the gate in anthropic.ts: a model that isn't matched runs without
// adaptive thinking rather than erroring.
const ADAPTIVE_THINKING_MODELS = /^claude-(fable-5|opus-5|opus-4-[6-9]|sonnet-5|sonnet-4-6)/

interface Usage {
  input: number
  output: number
  cache_write: number
  cache_read: number
}

const ZERO_USAGE: Usage = { input: 0, output: 0, cache_write: 0, cache_read: 0 }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function callModel(
  stableSystem: string,
  user: string,
  model: string,
): Promise<{ result: unknown; usage: Usage }> {
  const apiKey = anthropicApiKey()
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const body = {
    model,
    max_tokens: MAX_TOKENS,
    // The rules block is identical for every group in a run, so it carries a
    // cache breakpoint — the six calls of a run land well inside the hour.
    system: [{
      type: 'text',
      text: stableSystem,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    }],
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema: MINER_SCHEMA } },
    ...(ADAPTIVE_THINKING_MODELS.test(model) ? { thinking: { type: 'adaptive' } } : {}),
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
      const msg = await response.json() as {
        content: { type: string; text?: string }[]
        stop_reason: string | null
        usage: {
          input_tokens: number
          output_tokens: number
          cache_creation_input_tokens?: number
          cache_read_input_tokens?: number
        }
      }
      if (msg.stop_reason === 'max_tokens') throw new Error('response truncated at max_tokens')
      if (msg.stop_reason === 'refusal') throw new Error('model refused this request')
      const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
      return {
        // Parsed here, validated in miner.ts — this is untrusted text either way.
        result: JSON.parse(text) as unknown,
        usage: {
          input: msg.usage.input_tokens,
          output: msg.usage.output_tokens,
          cache_write: msg.usage.cache_creation_input_tokens ?? 0,
          cache_read: msg.usage.cache_read_input_tokens ?? 0,
        },
      }
    }
    const text = await response.text()
    lastError = `anthropic ${response.status}: ${text.slice(0, 300)}`
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
      const retryAfter = Number(response.headers.get('retry-after'))
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1500 * 2 ** attempt
      await sleep(Math.min(backoff, 30_000))
      continue
    }
    break
  }
  throw new Error(lastError)
}

// ── Handler ─────────────────────────────────────────────────────────────────

type AdminClient = ReturnType<typeof createClient>

// PostgREST's code for "column does not exist". The ONLY error we are allowed
// to work around by dropping a column from the select: a timeout or a broken
// connection must never be mistaken for "this database is older than we
// thought", or a transient blip would silently mine the mismatched pairs the
// feedback_match_quality filter exists to exclude — and report it as though the
// column were absent.
const UNDEFINED_COLUMN = '42703'

/**
 * Pull the ledger window.
 *
 * Two columns are newer than this function and may not be on the database yet:
 * `feedback_match_quality` (migration 000348) and `customer_message` (000349).
 * We ask for both, and on a 42703 fall back through the combinations until one
 * works, so a database with one but not the other still gets the one it has.
 * Which columns made it is reported in the run summary — a missing column must
 * read as "we cannot tell", never as "nothing to exclude" told confidently.
 */
async function fetchLedger(
  admin: AdminClient,
  sinceIso: string,
): Promise<{ rows: MinerDraftRow[]; matchQualityAvailable: boolean; customerMessageAvailable: boolean }> {
  const base =
    'id, helpscout_conversation_id, category, edit_class, edit_similarity, draft_body, sent_body, created_at'
  // The edit-class list comes from the miner so the SQL filter and isMinable()
  // can never drift apart.
  const query = (columns: string) =>
    admin
      .from('ai_drafts')
      .select(columns)
      .in('edit_class', [...MINABLE_EDIT_CLASSES])
      .not('draft_body', 'is', null)
      .not('sent_body', 'is', null)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS)

  // Best first. Each fallback drops exactly one optional column, so a 42703 on
  // the pair tells us which of the two is missing by which fallback succeeds.
  const attempts = [
    { matchQuality: true, customerMessage: true },
    { matchQuality: true, customerMessage: false },
    { matchQuality: false, customerMessage: true },
    { matchQuality: false, customerMessage: false },
  ]

  for (const attempt of attempts) {
    const columns = [
      base,
      ...(attempt.matchQuality ? ['feedback_match_quality'] : []),
      ...(attempt.customerMessage ? ['customer_message'] : []),
    ].join(', ')
    const res = await query(columns)
    if (!res.error) {
      return {
        rows: (res.data ?? []) as unknown as MinerDraftRow[],
        matchQualityAvailable: attempt.matchQuality,
        customerMessageAvailable: attempt.customerMessage,
      }
    }
    // Anything that is not "no such column" is a real failure — surface it
    // rather than quietly degrading the run.
    if (res.error.code !== UNDEFINED_COLUMN) {
      throw new Error(`ledger read failed: ${res.error.message}`)
    }
    console.warn('[ai-draft-miner] optional column missing, retrying:', res.error.message)
  }

  // Unreachable: the last attempt asks only for columns that have always
  // existed, so a 42703 there means the ledger itself has changed shape.
  throw new Error('ledger read failed: no usable column set')
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  if (!serviceKey || !supabaseUrl) return json({ error: 'missing supabase env' }, 500)

  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const authorised = bearer !== '' &&
    (timingSafeEqual(bearer, serviceKey) || bearerRole(bearer) === 'service_role')
  if (!authorised) return json({ error: 'forbidden' }, 403)

  const admin = createClient(supabaseUrl, serviceKey, {
    db: { schema: 'proofs' },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  try {
    const body = await req.json().catch(() => ({})) as {
      dry_run?: boolean
      since?: string
      lookback_days?: number
      max_groups?: number
      model?: string
    }

    // ── Lock 1: the settings flag ────────────────────────────────────────────
    // Unreadable settings, or a database without the column yet, both land on
    // "not enabled" — which forces dry run rather than failing the request, so
    // Rob can still see what a run would file.
    let enabled = false
    let gateReason: string | null = null
    let configuredModel: string | null = null

    const settings = await admin
      .from('settings')
      .select('ai_draft_miner_enabled, ai_drafts_model')
      .limit(1)
      .single()
    if (settings.error) {
      gateReason = `settings read failed (${settings.error.message}) — dry run only`
      console.warn('[ai-draft-miner]', gateReason)
      // Still try for the model on its own; the miner flag column may simply
      // not exist yet while ai_drafts_model does.
      const modelOnly = await admin.from('settings').select('ai_drafts_model').limit(1).single()
      configuredModel = ((modelOnly.data?.ai_drafts_model as string | null) ?? '').trim() || null
    } else {
      enabled = settings.data?.ai_draft_miner_enabled === true
      configuredModel = ((settings.data?.ai_drafts_model as string | null) ?? '').trim() || null
      if (!enabled) gateReason = 'ai_draft_miner_enabled is off — dry run only'
    }

    // ── Lock 2: dry_run defaults to true ─────────────────────────────────────
    // Writing takes an explicit "dry_run": false AND the flag on.
    const askedToWrite = body.dry_run === false
    const dryRun = !askedToWrite || !enabled

    // ── Window ───────────────────────────────────────────────────────────────
    // No stored "last run" marker on purpose: a run that files nothing would
    // still have to advance it, and the dedupe below already makes a re-scan of
    // the same window harmless. Pass `since` to be precise.
    const lookbackDays = Math.min(
      Math.max(Number(body.lookback_days) || DEFAULT_LOOKBACK_DAYS, 1),
      MAX_LOOKBACK_DAYS,
    )
    const sinceIso = typeof body.since === 'string' && !Number.isNaN(Date.parse(body.since))
      ? new Date(body.since).toISOString()
      : new Date(Date.now() - lookbackDays * 86_400_000).toISOString()

    // ── Inputs ───────────────────────────────────────────────────────────────
    const { rows, matchQualityAvailable, customerMessageAvailable } = await fetchLedger(
      admin,
      sinceIso,
    )

    const rulesRes = await admin
      .from('ai_draft_house_rules')
      .select('id, sort_order, rule_text')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
    if (rulesRes.error) throw new Error(`house rules read failed: ${rulesRes.error.message}`)
    const rules = (rulesRes.data ?? []) as unknown as HouseRuleRow[]
    // Without the current rules the model cannot tell an amendment from a new
    // rule, which is the one thing this miner exists to get right. Refuse
    // rather than file forty duplicates of rules we already have.
    if (rules.length === 0) {
      return json({ error: 'no active house rules — refusing to mine without the current briefing' }, 500)
    }

    // decided_at drives the cooling-off period on a rejected suggestion (see
    // the do-not-nag section of miner.ts); created_at is the fallback clock for
    // a row decided by hand rather than through the apply RPC.
    const existingRes = await admin
      .from('ai_draft_proposals')
      .select('kind, status, target_rule_id, proposed_text, decided_at, created_at')
      .neq('status', 'superseded')
    if (existingRes.error) throw new Error(`proposals read failed: ${existingRes.error.message}`)
    const existing = (existingRes.data ?? []) as unknown as ExistingProposal[]

    // ── Group and mine ───────────────────────────────────────────────────────
    const maxGroups = Math.min(Math.max(Number(body.max_groups) || DEFAULT_MAX_GROUPS, 1), 20)
    const groups: CategoryGroup[] = groupByCategory(rows).slice(0, maxGroups)
    const model = (body.model ?? '').trim() || configuredModel || modelId()

    const stableSystem = buildMinerSystem(rules)
    const parsed: ParseOutcome[] = []
    const usage: Usage = { ...ZERO_USAGE }
    const groupSummaries: Record<string, unknown>[] = []

    for (const group of groups) {
      try {
        const call = await callModel(stableSystem, buildMinerUser(group), model)
        usage.input += call.usage.input
        usage.output += call.usage.output
        usage.cache_write += call.usage.cache_write
        usage.cache_read += call.usage.cache_read
        const outcome = parseMinerResponse(call.result, group, rules)
        parsed.push(outcome)
        groupSummaries.push({
          category: group.category,
          pairs: group.pairs.length,
          total_rows: group.totalRows,
          candidates: outcome.candidates.length,
          rejected: outcome.dropped.length,
        })
      } catch (err) {
        // One bad group must not lose the rest of the run.
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[ai-draft-miner] group ${group.category} failed:`, message)
        groupSummaries.push({
          category: group.category,
          pairs: group.pairs.length,
          total_rows: group.totalRows,
          error: message.slice(0, 300),
        })
      }
    }

    // ── Merge, gate, dedupe ──────────────────────────────────────────────────
    const batchId = crypto.randomUUID()
    const plan = planProposals({ parsed, existing, batchId })

    // ── File (or don't) ──────────────────────────────────────────────────────
    let inserted = 0
    if (!dryRun && plan.rows.length > 0) {
      const { data, error } = await admin
        .from('ai_draft_proposals')
        .insert(plan.rows)
        .select('id')
      if (error) throw new Error(`proposal insert failed: ${error.message}`)
      inserted = data?.length ?? 0
    }

    // Audited whenever the miner was ARMED, including the run that decided
    // nothing. "It ran and found nothing" and "it never ran" look identical
    // otherwise, which is the difference between a working miner and a broken
    // one. Dry runs stay out of the audit log on purpose: they write nothing
    // anywhere, and the full result is in the response for whoever asked.
    if (!dryRun) {
      await logAudit(admin, {
        actorLabel: 'AI draft miner (system)',
        action: 'ai_draft.miner_run',
        targetType: 'ai_draft_proposals',
        targetId: batchId,
        metadata: {
          batch_id: batchId,
          since: sinceIso,
          rows_scanned: rows.length,
          groups: groupSummaries,
          proposals_filed: inserted,
          dropped: plan.dropped,
          model,
          usage,
        },
      })
    }

    return json({
      ok: true,
      dry_run: dryRun,
      wrote: inserted > 0,
      gate: {
        setting: 'ai_draft_miner_enabled',
        enabled,
        reason: gateReason,
        // Spelled out because "dry_run": true is the default and it surprises
        // people the first time.
        how_to_write: 'set ai_draft_miner_enabled = true and POST {"dry_run": false}',
      },
      batch_id: batchId,
      window: { since: sinceIso, until: new Date().toISOString(), lookback_days: lookbackDays },
      match_quality_column: matchQualityAvailable ? 'present' : 'absent (nothing excluded on it)',
      // No customer messages means no honest exemplar, so the kind sits out the
      // run rather than inventing one. Expected until migration 000349 has been
      // applied and fresh drafts have accumulated behind it.
      customer_message_column: customerMessageAvailable
        ? 'present'
        : 'absent (exemplar_add cannot be proposed)',
      model,
      rows_scanned: rows.length,
      groups: groupSummaries,
      proposals_filed: inserted,
      // Always returned, so a dry run is fully inspectable before it is armed.
      proposals: plan.rows,
      dropped: plan.dropped,
      usage,
    })
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    console.error('[ai-draft-miner] crashed:', msg, err instanceof Error ? err.stack : '')
    return json({ error: 'crash', detail: msg }, 500)
  }
})
