// Automated follow-up (nudge) sender. Spec: docs/followup-automation-spec.md.
//
// Invoked by pg_cron on the merged stock project (job 'proofs-send-nudges',
// 0 9,15 * * 1-5 UTC — a morning run at 09:00 GMT / 10:00 BST and an
// afternoon run at 15:00 GMT / 16:00 BST, both in-hours year-round) via
// net.http_post with the service-role key as Bearer, same pattern as the
// existing outsourced-tracking-refresh / notify-scan-cron jobs. The platform
// JWT check (verify_jwt = true, the default) runs first; the handler then
// requires the Bearer to BE the service-role key (timing-safe compare), so
// neither anon nor designer JWTs can trigger a run.
//
// Three architecture rules from the spec, all enforced here:
//   #1 The sender is the authority — every guard is re-evaluated in this
//      run, immediately before any send. The nightly output and the review
//      queue are candidate lists, never authorisation.
//   #2 Claim first, send second — the proof_nudges row is INSERTed in state
//      'sending' under the unique claim index BEFORE the Help Scout POST,
//      then flipped to sent/failed. Stale 'sending' rows are never retried
//      automatically; they count toward caps and surface to a human.
//   #3 Never nudge past a customer reply — hard-skip when the customer's
//      last reply is newer than our last outbound touch, regardless of the
//      grace window; belt-and-braces re-check against the live thread trail.
//
// Modes: live iff settings.auto_nudges_enabled AND settings.replies_enabled
// (the master gate), AND no stale open run, AND inside the London send
// window. Anything else runs dry: the full pipeline executes — including the
// Help Scout conversation gates, so recipient-mismatch counts are real — but
// nothing posts, and every ledger row is state 'dry_run'. Phase 1 IS the
// dry run; Phase 2 flips auto_nudges_enabled.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (platform-provided),
// HELPSCOUT_APP_ID, HELPSCOUT_APP_SECRET, HELPSCOUT_DEFAULT_USER_ID,
// PROOF_VIEWER_BASE_URL (same secrets proof-action / send-helpscout-reply
// already use — nothing new to configure).

import { createClient } from 'jsr:@supabase/supabase-js@2'
import {
  createStaffConversation,
  fetchConversationWithThreads,
  getAccessToken,
  HsError,
  postStaffReply,
  type HsConversationWithThreads,
} from '../_shared/helpscout.ts'
import { messageBodyToHtml } from '../_shared/messageHtml.ts'
import {
  NUDGE_DEFAULT_BODIES,
  renderTemplate,
  templateProblem,
  type TemplateContext,
} from '../_shared/replyTemplates.ts'
import {
  bundleChaseable,
  bundleNudgeNumber,
  capRows,
  decideForBundle,
  decideForProof,
  EW_BANK_HOLIDAYS_FALLBACK,
  groupSendables,
  isLondonMondayMorning,
  isWithinSendWindow,
  londonDate,
  nudgeNumberFor,
  nudgeTemplateIds,
  simulateDryLedger,
  type AutomationRuleConfig,
  type CandidateFacts,
  type LedgerRow,
  type NudgeConfig,
} from '../_shared/nudgeDecision.ts'

// The chase rules this sender can auto-send. A rule only actually sends when
// its automation mode resolves to 'auto' (decideForProof drops everything
// else); a rule left in 'review'/'off' still has its candidates computed but
// each is dropped here and handled by the dashboard Outbox's review queue
// instead. Each proof is in exactly one rule's population per run (it either
// has a non-bot view or it doesn't), so the two never double-send the same
// proof — and groupSendables() still dedupes across rules by customer email.
interface NudgeRuleSpec {
  code: string
  templateId: string
  // Subject for reminder #2+, which opens a NEW Help Scout conversation (spec
  // section 6): deliberately fresh wording, no "Re:" — if the original thread
  // is in the customer's spam folder, a reply there measures the spam folder,
  // not the customer.
  freshSubject: string
}
const NUDGE_RULES: NudgeRuleSpec[] = [
  {
    code: 'sent_never_viewed',
    templateId: 'nudge_sent_never_viewed',
    freshSubject: 'Your card proof from PlasmaDesign',
  },
  {
    code: 'viewed_not_actioned',
    templateId: 'nudge_viewed_not_actioned',
    freshSubject: 'Your card proof from PlasmaDesign',
  },
]
const NUDGE_RULE_BY_CODE = new Map(NUDGE_RULES.map((r) => [r.code, r]))

// Whole-bundle reminders (migration 000317). A bundle's due cards collapse into
// ONE reminder on the bundle's own Help Scout thread, pointing at the bundle
// review link. The cadence mirrors a single card's current live dials (000313):
// up to 3 reminders, 3 working days apart with the same progressive stretch.
const BUNDLE_RULE_CODE = 'bundle'
const BUNDLE_TEMPLATE_ID = 'nudge_bundle'
const BUNDLE_FRESH_SUBJECT = 'Your card proofs from PlasmaDesign'
const BUNDLE_MAX_NUDGES = 3
const BUNDLE_REPEAT_DAYS = 3
// An open run row older than this is treated as crashed (gates live sends);
// younger means a run is genuinely in flight (this invocation aborts).
const OPEN_RUN_STALE_MS = 10 * 60 * 1000
// Webhook deadman threshold: live sends require a Help Scout reply stamp
// somewhere in the system newer than this. Matches the Outbox panel's
// WEBHOOK_FRESH_HOURS so the sender's gate and the amber warning agree.
const WEBHOOK_DEADMAN_MS = 72 * 3_600_000

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Constant-time string compare (same shape as helpscout-webhook's gate).
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Role claim of an ALREADY-PLATFORM-VERIFIED JWT. Safe to trust precisely
// because config.toml pins verify_jwt = true for this function: the gateway
// has validated the signature before the handler runs, so decoding the
// payload here is reading a verified claim, not trusting client input.
// (If verify_jwt were ever turned off, this gate would become forgeable —
// the config comment carries the same warning.) Needed because a project
// can hold more than one legitimately-minted service-role JWT, so a byte
// compare against the injected env key is too brittle (the first live
// trigger failed exactly that way).
function bearerRole(bearer: string): string | null {
  const parts = bearer.split('.')
  if (parts.length !== 3) return null
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const payload = JSON.parse(atob(padded)) as { role?: unknown }
    return typeof payload.role === 'string' ? payload.role : null
  } catch {
    return null
  }
}

// gov.uk bank-holidays feed, england-and-wales division. Best-effort with a
// short timeout; the embedded fallback list keeps a gov.uk outage from
// stopping the morning run.
async function fetchBankHolidays(): Promise<ReadonlySet<string>> {
  try {
    const resp = await fetch('https://www.gov.uk/bank-holidays.json', {
      signal: AbortSignal.timeout(5000),
    })
    if (resp.ok) {
      const data = await resp.json() as {
        'england-and-wales'?: { events?: Array<{ date?: string }> }
      }
      const dates = (data['england-and-wales']?.events ?? [])
        .map((e) => e.date)
        .filter((d): d is string => typeof d === 'string')
      if (dates.length > 0) return new Set(dates)
    }
  } catch (err) {
    console.warn('[send-nudges] gov.uk holidays fetch failed, using fallback', err)
  }
  return new Set(EW_BANK_HOLIDAYS_FALLBACK)
}

// Row shape coming back from compute_nudge_candidates().
interface CandidateRow {
  proof_id: string
  version_id: string
  version_number: number | null
  version_created_at: string
  rule_code: string
  anchor_at: string | null
  helpscout_conversation_id: string | null
  helpscout_conversation_url: string | null
  contact_full_name: string | null
  contact_email: string | null
  company_name: string | null
  designer_id: string | null
  designer_helpscout_user_id: number | null
  send_evidence_at: string | null
  last_customer_reply_at: string | null
  last_staff_reply_at: string | null
  snoozed: boolean
  auto_nudge_disabled: boolean
  has_followup_tag: boolean
  currency: string | null
}

type Candidate = CandidateFacts & { row: CandidateRow }

function toFacts(row: CandidateRow): Candidate {
  return {
    proofId: row.proof_id,
    versionId: row.version_id,
    // Defensive defaults so a deploy that lands before migration 000244 (the
    // old candidate function, without rule_code / anchor_at) still processes
    // the sent_never_viewed population correctly instead of skipping it: a
    // missing rule_code reads as sent_never_viewed, and its anchor falls back
    // to the send evidence (exactly the old anchor).
    ruleCode: row.rule_code ?? 'sent_never_viewed',
    conversationId: row.helpscout_conversation_id,
    contactEmail: row.contact_email,
    anchorAt: row.anchor_at ?? row.send_evidence_at,
    sendEvidenceAt: row.send_evidence_at,
    lastCustomerReplyAt: row.last_customer_reply_at,
    lastStaffReplyAt: row.last_staff_reply_at,
    snoozed: row.snoozed,
    autoNudgeDisabled: row.auto_nudge_disabled,
    hasFollowUpTag: row.has_followup_tag === true,
    // Pre-000314 candidate rows have no currency column → null → the USD
    // afternoon-deferral simply doesn't fire (old behaviour). Order-safe
    // whichever of the migration / this deploy lands first.
    currency: row.currency ?? null,
    // Tagged below, after decideForProof, for cards in a sent bundle with ≥2
    // outstanding cards (migration 000317). Null means "chase per-card".
    bundleId: null,
    row,
  }
}

interface LedgerInsert {
  proof_id: string
  proof_version_id: string
  rule_code: string
  template_id: string | null
  source: 'auto'
  state: 'sending' | 'sent' | 'failed' | 'skipped' | 'dry_run'
  outcome: string
  // One-line human-readable explanation for outcomes a human must resolve
  // (migration 000228). Rendered under the Outbox "Needs you"/"Failed" rows.
  detail?: string | null
  helpscout_conversation_id: string | null
  // The set a bundle-level reminder covers (migration 000317). Null for every
  // per-card reminder; the bundle cap/cooldown counts sent rows by this column.
  proof_set_id?: string | null
  rendered_body?: string | null
}

// Inference-typed so the proofs schema pin survives into every .from() call
// (an explicit SupabaseClient annotation would collapse it back to "public").
function makeAdmin(supabaseUrl: string, serviceKey: string) {
  return createClient(supabaseUrl, serviceKey, {
    db: { schema: 'proofs' },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
type Admin = ReturnType<typeof makeAdmin>

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  if (!serviceKey || !supabaseUrl) return json({ error: 'missing supabase env' }, 500)

  // Only service-role credentials may trigger a run: either the exact
  // injected key, or any platform-verified JWT carrying the service_role
  // claim (the cron job's vault-stored key is a differently-minted
  // service-role JWT, so byte equality alone is not enough).
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const authorised = bearer !== '' &&
    (timingSafeEqual(bearer, serviceKey) || bearerRole(bearer) === 'service_role')
  if (!authorised) {
    return json({ error: 'forbidden' }, 403)
  }

  const admin = makeAdmin(supabaseUrl, serviceKey)

  try {
    return await run(admin)
  } catch (err) {
    // Never an opaque EDGE_FUNCTION_ERROR: log + structured body.
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    console.error('[send-nudges] crashed:', msg, err instanceof Error ? err.stack : '')
    return json({ error: 'crash', detail: msg }, 500)
  }
})

async function run(admin: Admin): Promise<Response> {
  const now = new Date()

  // ── Settings + config ──────────────────────────────────────────────────────
  const { data: settings, error: settingsErr } = await admin
    .from('settings')
    .select('auto_nudges_enabled, replies_enabled')
    .eq('id', 1)
    .single()
  if (settingsErr) return json({ error: `settings: ${settingsErr.message}` }, 500)

  const { data: siteSettings, error: siteErr } = await admin
    .from('site_settings')
    .select('needs_attention_rules')
    .eq('id', 1)
    .single()
  if (siteErr) return json({ error: `site_settings: ${siteErr.message}` }, 500)

  const rules = (siteSettings?.needs_attention_rules ?? {}) as Record<string, unknown>
  const automationBlock = (rules['automation'] ?? {}) as Record<string, unknown>
  const graceDays = Number((rules['helpscout_reply_grace_days'] as number | undefined) ?? 3)
  const lifetimeMax = Number((automationBlock['lifetime_max'] as number | undefined) ?? 6)

  const bankHolidays = await fetchBankHolidays()

  // One NudgeConfig per chase rule. Each candidate is judged against its own
  // rule's dials; a rule whose mode isn't 'auto' has all its candidates
  // dropped by decideForProof (the dashboard review queue covers those).
  // Fail closed: mode must be the explicit string 'auto'.
  const cfgByRule = new Map<string, NudgeConfig>()
  for (const rule of NUDGE_RULES) {
    const ruleCfg = (rules[rule.code] ?? {}) as Record<string, unknown>
    const auto = (automationBlock[rule.code] ?? {}) as AutomationRuleConfig
    cfgByRule.set(rule.code, {
      ruleEnabled: ruleCfg['enabled'] === true,
      thresholdDays: Number(ruleCfg['threshold_days'] ?? 3),
      calendar: ruleCfg['calendar'] === true,
      automation: {
        mode: auto.mode === 'auto' ? 'auto' : (auto.mode === 'review' ? 'review' : 'off'),
        repeat_days: Number(auto.repeat_days ?? 3),
        max_nudges: Number(auto.max_nudges ?? 2),
      },
      lifetimeMax,
      graceDays,
      bankHolidays,
    })
  }

  // ── Mode resolution ────────────────────────────────────────────────────────
  let mode: 'live' | 'dry_run' = 'dry_run'
  let modeNote = ''
  if (settings?.auto_nudges_enabled !== true) {
    modeNote = 'dry run: auto_nudges_enabled is off'
  } else if (settings?.replies_enabled !== true) {
    modeNote = 'dry run: replies are paused (master gate)'
  } else {
    mode = 'live'
  }

  // Open-run gate. ANY unfinished run row — however old — means a batch
  // crashed mid-flight and a human has not yet looked: live sending stays
  // paused until the row is cleared via the resolve_nudge_run RPC (the Outbox
  // warning carries the button). Checking only the newest row would let the
  // gate self-heal after one demoted cycle, which is exactly what the spec
  // forbids. A FRESH open row means another invocation is in flight right
  // now: abort outright.
  const { data: openRuns } = await admin
    .from('nudge_runs')
    .select('id, started_at')
    .is('finished_at', null)
    .order('started_at', { ascending: false })
  for (const open of openRuns ?? []) {
    const age = now.getTime() - Date.parse(open.started_at)
    if (age < OPEN_RUN_STALE_MS) {
      return json({ error: 'a run is already in progress', run_id: open.id }, 409)
    }
  }
  if ((openRuns ?? []).length > 0 && mode === 'live') {
    mode = 'dry_run'
    modeNote =
      `dry run: ${openRuns!.length} crashed run(s) await review (oldest ${openRuns![openRuns!.length - 1].id}) — ` +
      'clear them from the Outbox before live sends resume'
  }

  // Webhook deadman gate (adversarial review 2026-06-12, finding 1). The
  // grace window and the staff-reply half of the customer-reply hard-skip
  // are only as fresh as the helpscout-webhook stamps; if the webhook dies
  // silently, the sender would chase customers we are actively talking to
  // in Help Scout. The customer-reply side has a belt-and-braces re-check
  // against the live thread trail, but staff replies have none — so live
  // sends require a reply stamp somewhere in the system within the deadman
  // window. Staleness demotes to dry_run (mirroring the Outbox's amber
  // webhook warning); dry runs proceed as normal since they send nothing.
  if (mode === 'live') {
    const [staffRes, custRes] = await Promise.all([
      admin.from('proofs')
        .select('helpscout_last_reply_at')
        .not('helpscout_last_reply_at', 'is', null)
        .order('helpscout_last_reply_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      admin.from('proofs')
        .select('helpscout_last_customer_reply_at')
        .not('helpscout_last_customer_reply_at', 'is', null)
        .order('helpscout_last_customer_reply_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])
    const newestStamp = Math.max(
      staffRes.data?.helpscout_last_reply_at
        ? Date.parse(staffRes.data.helpscout_last_reply_at as string)
        : -Infinity,
      custRes.data?.helpscout_last_customer_reply_at
        ? Date.parse(custRes.data.helpscout_last_customer_reply_at as string)
        : -Infinity,
    )
    if (!(newestStamp > now.getTime() - WEBHOOK_DEADMAN_MS)) {
      mode = 'dry_run'
      modeNote = newestStamp > -Infinity
        ? `dry run: newest Help Scout reply stamp is ${Math.round((now.getTime() - newestStamp) / 3_600_000)}h old — check the webhook before live sends resume`
        : 'dry run: no Help Scout reply stamps recorded — check the webhook before live sends resume'
    }
  }

  // Send window applies to LIVE only — a dry run at any hour still fills the
  // Outbox (useful for manual testing).
  if (mode === 'live' && !isWithinSendWindow(now, bankHolidays)) {
    mode = 'dry_run'
    modeNote = 'dry run: outside the London send window'
  }

  // Monday-morning deferral: the weekend-matured batch — the biggest of the
  // week — re-engaged markedly worse at Monday 10:00 than any other slot, so
  // it goes out on the afternoon run instead (see isLondonMondayMorning).
  // Dry-running rather than aborting keeps the Outbox picture complete, and
  // dry rows never block the afternoon's live claims (the claim index only
  // covers sending/sent).
  if (mode === 'live' && isLondonMondayMorning(now)) {
    mode = 'dry_run'
    modeNote =
      'dry run: Monday-morning batch held for the afternoon run (weekend backlog re-engages better later in the day)'
  }

  // ── Heartbeat: the run row is the pipeline's FIRST write ───────────────────
  const { data: runRow, error: runErr } = await admin
    .from('nudge_runs')
    .insert({ mode, note: modeNote || null })
    .select('id, started_at')
    .single()
  if (runErr || !runRow) return json({ error: `nudge_runs insert: ${runErr?.message}` }, 500)
  const runId = runRow.id as string

  let sent = 0
  let skipped = 0
  const errors: Array<Record<string, unknown>> = []
  let candidateCount = 0

  // Everything below always lands in the finally-style run-row update.
  try {
    // ── Facts ────────────────────────────────────────────────────────────────
    const { data: candRows, error: candErr } = await admin.rpc('compute_nudge_candidates')
    if (candErr) throw new Error(`compute_nudge_candidates: ${candErr.message}`)
    const candidates = ((candRows ?? []) as CandidateRow[]).map(toFacts)
    candidateCount = candidates.length

    // Paged read: PostgREST silently truncates at 1000 rows, and silently
    // truncated cap maths means EXTRA customer emails (the 000148 lesson —
    // never trust an unbounded select).
    let ledger: LedgerRow[] = []
    if (candidates.length > 0) {
      const PAGE = 1000
      for (let from = 0; ; from += PAGE) {
        const { data: page, error: ledgerErr } = await admin
          .from('proof_nudges')
          .select('proof_id, proof_version_id, rule_code, source, state, outcome, created_at')
          .in('proof_id', candidates.map((c) => c.proofId))
          .order('created_at', { ascending: true })
          .range(from, from + PAGE - 1)
        if (ledgerErr) throw new Error(`proof_nudges read: ${ledgerErr.message}`)
        const rows = (page ?? []) as Array<Record<string, unknown>>
        ledger.push(...rows.map((r) => ({
          proofId: r.proof_id as string,
          versionId: (r.proof_version_id as string | null),
          ruleCode: r.rule_code as string,
          source: r.source as 'auto' | 'manual',
          state: r.state as string,
          outcome: (r.outcome as string | null),
          createdAt: r.created_at as string,
        })))
        if (rows.length < PAGE) break
      }
    }

    // Dry-run cadence simulation: prior would-send rows count as sent so the
    // dry week demonstrates spacing, the cap, and exhaustion night-over-night
    // exactly as the live system would behave (spec, Phase 1 acceptance).
    if (mode === 'dry_run') ledger = simulateDryLedger(ledger)

    // ── Decisions (the tested module) ───────────────────────────────────────
    const eligible: Candidate[] = []
    const skips: Array<{ c: Candidate; outcome: string }> = []
    for (const c of candidates) {
      const cfg = cfgByRule.get(c.ruleCode)
      if (!cfg) continue // a candidate for a rule this sender doesn't handle
      const d = decideForProof(c, ledger, cfg, now)
      if (d.action === 'send') eligible.push(c)
      else if (d.action === 'skip') skips.push({ c, outcome: d.outcome })
      // drops are silent by design (below threshold / rule off / mode≠auto).
    }

    // ── Bundle grouping (migration 000317) ───────────────────────────────────
    // A card in a chaseable bundle with ≥2 still-outstanding cards is tagged
    // with its set id, so groupSendables collapses the bundle's due cards into
    // ONE reminder rather than suppressing them as siblings. Chaseable
    // (bundleChaseable) = the bundle was SENT, or it was never sent as a bundle
    // but every outstanding card already went out individually — that second
    // shape used to suppress forever (two due cards, one customer, and the
    // "human sends one combined message" hand-off never visibly happened). On
    // the first live bundle send for such a set the sender stamps sent_at, so
    // it is a normal sent bundle from then on. A bundle down to its last
    // outstanding card stays untagged and chases per-card on its own link
    // (Rob, 2026-07-15). Best-effort: any failure leaves cards untagged, which
    // is exactly the pre-000317 behaviour (siblings suppressed → a human sends).
    const setInfoById = new Map<
      string,
      { id: string; token: string; conversationId: string | null; sentAt: string | null }
    >()
    const bundleLedgerBySet = new Map<string, LedgerRow[]>()
    if (eligible.length > 0) {
      try {
        const { data: memberRows } = await admin
          .from('proofs')
          .select('id, proof_set_id')
          .in('id', eligible.map((c) => c.proofId))
          .not('proof_set_id', 'is', null)
        const setByProof = new Map<string, string>()
        for (const r of memberRows ?? []) {
          setByProof.set(r.id as string, r.proof_set_id as string)
        }
        const setIds = [...new Set(setByProof.values())]
        if (setIds.length > 0) {
          const { data: setRows } = await admin
            .from('proof_sets')
            .select('id, token, sent_at, helpscout_conversation_id')
            .in('id', setIds)
          for (const s of setRows ?? []) {
            setInfoById.set(s.id as string, {
              id: s.id as string,
              token: s.token as string,
              conversationId: (s.helpscout_conversation_id as string | null),
              sentAt: (s.sent_at as string | null),
            })
          }
          if (setInfoById.size > 0) {
            const allSetIds = [...setInfoById.keys()]
            // Outstanding = still in_progress and not set aside by the customer.
            const { data: outstanding } = await admin
              .from('proofs')
              .select('id, proof_set_id')
              .in('proof_set_id', allSetIds)
              .eq('status', 'in_progress')
              .is('set_discarded_at', null)
            const outstandingBySet = new Map<string, string[]>()
            for (const r of outstanding ?? []) {
              const setId = r.proof_set_id as string
              const list = outstandingBySet.get(setId) ?? []
              list.push(r.id as string)
              outstandingBySet.set(setId, list)
            }
            // Send evidence per outstanding card's current version — the
            // unsent-set arm of bundleChaseable needs to know every card
            // already went out individually before the bundle link may lead
            // the chase.
            const outstandingIds = [...outstandingBySet.values()].flat()
            const evidenceByProof = new Map<string, string | null>()
            if (outstandingIds.length > 0) {
              const { data: versions } = await admin
                .from('proof_versions')
                .select('proof_id, last_reply_sent_at')
                .eq('is_current', true)
                .in('proof_id', outstandingIds)
              for (const v of versions ?? []) {
                evidenceByProof.set(v.proof_id as string, (v.last_reply_sent_at as string | null))
              }
            }
            const chaseableSetIds = new Set<string>()
            for (const [setId, info] of setInfoById) {
              const members = outstandingBySet.get(setId) ?? []
              const evidence = members.map((id) => evidenceByProof.get(id) ?? null)
              if (bundleChaseable(info.sentAt, evidence)) chaseableSetIds.add(setId)
            }
            for (const c of eligible) {
              const setId = setByProof.get(c.proofId)
              if (setId && chaseableSetIds.has(setId)) c.bundleId = setId
            }
            // Bundle ledger (rule_code='bundle') for the per-set cap + cooldown.
            const taggedSetIds = [...new Set(
              eligible.map((c) => c.bundleId).filter((v): v is string => !!v),
            )]
            if (taggedSetIds.length > 0) {
              const { data: bl } = await admin
                .from('proof_nudges')
                .select('proof_set_id, source, state, outcome, created_at')
                .in('proof_set_id', taggedSetIds)
                .eq('rule_code', BUNDLE_RULE_CODE)
              for (const r of bl ?? []) {
                const setId = r.proof_set_id as string
                const list = bundleLedgerBySet.get(setId) ?? []
                list.push({
                  proofId: setId,
                  versionId: null,
                  ruleCode: BUNDLE_RULE_CODE,
                  source: r.source as 'auto' | 'manual',
                  state: r.state as string,
                  outcome: (r.outcome as string | null),
                  createdAt: r.created_at as string,
                })
                bundleLedgerBySet.set(setId, list)
              }
              // Dry-run cadence simulation, mirroring the per-card ledger: a
              // prior would-send bundle row counts as sent so the dry week shows
              // the bundle cooldown/cap exactly as live would.
              if (mode === 'dry_run') {
                for (const [k, v] of bundleLedgerBySet) {
                  bundleLedgerBySet.set(k, simulateDryLedger(v))
                }
              }
            }
          }
        }
      } catch (err) {
        console.warn('[send-nudges] bundle grouping lookup failed, chasing per-card', err)
      }
    }

    const grouped = groupSendables(eligible)

    // ── Template bodies (DB rows, falling back to the seeded defaults) ──────
    // One fetch of every nudge_* row; the body for each send is then resolved
    // per reminder position via nudgeTemplateIds — base body for reminder 1,
    // `_2` for the middle of the sequence, `_final` (the "we'll stop nudging
    // you" close) for the last allowed reminder — so a customer never
    // receives the same reminder twice. A missing/blanked row falls through
    // the chain; worst case is the base body, the pre-sequence behaviour.
    const dbBodies = new Map<string, string>()
    {
      const { data: tplRows } = await admin
        .from('reply_templates')
        .select('id, body')
        .like('id', 'nudge_%')
      for (const t of tplRows ?? []) {
        if (typeof t.body === 'string' && t.body.trim() !== '') {
          dbBodies.set(t.id as string, t.body)
        }
      }
    }
    const resolveTemplate = (
      baseId: string,
      nudgeNumber: number,
      maxNudges: number,
    ): { id: string; body: string } => {
      for (const id of nudgeTemplateIds(baseId, nudgeNumber, maxNudges)) {
        const body = dbBodies.get(id) ?? NUDGE_DEFAULT_BODIES[id]
        if (body && body.trim() !== '') return { id, body }
      }
      return { id: baseId, body: NUDGE_DEFAULT_BODIES[baseId] }
    }

    const insertLedgerRow = async (row: LedgerInsert): Promise<string | null> => {
      const { data, error } = await admin
        .from('proof_nudges')
        // sent_date is the London civil date, not the column's UTC default:
        // decisions run on London days, and a 23:30-UTC summer run would
        // otherwise log under the wrong day and double-log one London day.
        .insert({ ...row, sent_date: londonDate(now) })
        .select('id')
        .maybeSingle()
      if (error) {
        // 23505 = the claim/dedupe indexes: another run already wrote this
        // row today.
        if (error.code === '23505') return null
        throw new Error(`proof_nudges insert: ${error.message}`)
      }
      return (data?.id as string) ?? null
    }

    const logState = mode === 'live' ? 'skipped' : 'dry_run'

    // ── Guard skips + sibling suppressions ──────────────────────────────────
    for (const { c, outcome } of skips) {
      const id = await insertLedgerRow({
        proof_id: c.proofId,
        proof_version_id: c.versionId,
        rule_code: c.ruleCode,
        template_id: null,
        source: 'auto',
        state: logState,
        outcome,
        helpscout_conversation_id: c.conversationId,
      })
      if (id) skipped++
    }
    for (const c of grouped.suppressed) {
      const id = await insertLedgerRow({
        proof_id: c.proofId,
        proof_version_id: c.versionId,
        rule_code: c.ruleCode,
        template_id: null,
        source: 'auto',
        state: logState,
        outcome: 'suppressed_sibling',
        helpscout_conversation_id: c.conversationId,
      })
      if (id) skipped++
    }

    // ── The send loop ────────────────────────────────────────────────────────
    // Per-card chases and whole-bundle chases share ONE send path: the Help
    // Scout gates (existence / status / recipient / live trail), the claim-first
    // write, the post, and the send-evidence re-stamp are identical — only the
    // conversation, the {url}, the template family, and (for a bundle) the set
    // of covered cards differ. A SendJob carries those differences.
    if (grouped.send.length > 0 || grouped.bundles.length > 0) {
      const appId = Deno.env.get('HELPSCOUT_APP_ID')?.trim()
      const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')?.trim()
      if (!appId || !appSecret) throw new Error('Help Scout credentials not configured')
      let token = await getAccessToken(appId, appSecret)

      const baseUrl = (Deno.env.get('PROOF_VIEWER_BASE_URL')?.trim() ?? '').replace(/\/+$/, '')
      const defaultUserId = Number(Deno.env.get('HELPSCOUT_DEFAULT_USER_ID')?.trim() ?? '')

      // One reminder to send — a per-card chase or a whole-bundle chase.
      interface SendJob {
        kind: 'card' | 'bundle'
        // Ledger proof_id + audit target (the bundle's most-overdue card).
        proofId: string
        versionId: string
        conversationId: string // HS conversation to fetch + post to
        contactEmail: string | null
        ruleCode: string // 'sent_never_viewed' | 'viewed_not_actioned' | 'bundle'
        templateBaseId: string
        freshSubject: string
        nudgeNumber: number
        maxNudges: number
        link: string // {url} — a /p/ card link or a /bundle/ review link
        proofSetId: string | null
        // Bundle whose set was never formally "sent": stamp proof_sets.sent_at
        // after a successful live send — the reminder itself just introduced
        // the review link, so the set is genuinely sent from that moment.
        markSetSentOnSend?: boolean
        // Current versions to re-stamp with send evidence on a successful send
        // (all the bundle's due cards; the single card for a per-card chase).
        stampVersions: Array<{ proofId: string; versionId: string }>
        // Non-rep bundle cards to log as 'folded_into_bundle' (empty for a card).
        foldMembers: Array<{ proofId: string; versionId: string; ruleCode: string }>
        // Greeting + template context.
        contactFullName: string | null
        companyName: string | null
        versionNumber: number | string | null
        designerHelpscoutUserId: number | null
        // Outbound-touch inputs for the belt-and-braces customer-reply re-check.
        sendEvidenceAt: string | null
        lastStaffReplyAt: string | null
        priorTouch: LedgerRow[]
      }

      // Set on an HS 429 so both builder loops stop the run (eligible work goes
      // out on the next run). A shared flag replaces the old inline `break`.
      let haltForRateLimit = false

      const processReminder = async (job: SendJob): Promise<void> => {
        const { id: templateId, body: templateBody } = resolveTemplate(
          job.templateBaseId,
          job.nudgeNumber,
          job.maxNudges,
        )
        // Visible to the catch below: a claim that exists when an HsError
        // surfaces can be flipped to 'failed' (postStaffReply's HsError means
        // HS definitively rejected the POST — nothing was sent). Only ambiguous
        // failures (network throws, where the POST may have landed) leave the
        // claim in 'sending' for human verification.
        let claimId: string | null = null
        try {
          // One GET serves four checks: existence, status, recipient, trail.
          let conv: HsConversationWithThreads | null
          try {
            conv = await fetchConversationWithThreads(token, job.conversationId)
          } catch (err) {
            // One 401 retry: tokens can expire mid-batch.
            if (err instanceof HsError && err.status === 401) {
              token = await getAccessToken(appId, appSecret)
              conv = await fetchConversationWithThreads(token, job.conversationId)
            } else {
              throw err
            }
          }

          const logSkip = async (outcome: string, detail?: string) => {
            const id = await insertLedgerRow({
              proof_id: job.proofId,
              proof_version_id: job.versionId,
              rule_code: job.ruleCode,
              template_id: null,
              source: 'auto',
              state: logState,
              outcome,
              detail: detail ?? null,
              helpscout_conversation_id: job.conversationId,
              proof_set_id: job.proofSetId,
            })
            if (id) skipped++
          }

          // Fold rows: the bundle's OTHER due cards are covered by this one
          // reminder, so they get an informational skipped/dry row rather than
          // silence. No conversation id (so the convo-daily index ignores them);
          // never a sending/sent state, so they never count toward any cap.
          const logFolded = async () => {
            for (const m of job.foldMembers) {
              await insertLedgerRow({
                proof_id: m.proofId,
                proof_version_id: m.versionId,
                rule_code: m.ruleCode,
                template_id: null,
                source: 'auto',
                state: logState,
                outcome: 'folded_into_bundle',
                detail: 'Covered by the single bundle reminder sent to this customer.',
                helpscout_conversation_id: null,
                proof_set_id: job.proofSetId,
              })
            }
          }

          if (!conv) {
            await logSkip(
              'skipped_conversation_missing',
              `The linked Help Scout conversation (id ${job.conversationId}) couldn't be found — it may have been deleted or merged. Re-link this proof to the correct conversation.`,
            )
            return
          }
          const status = (conv.status ?? '').toLowerCase()
          if (status === 'closed' || status === 'spam') {
            await logSkip(
              'skipped_closed_conversation',
              `The linked Help Scout conversation is ${status === 'spam' ? 'marked as spam' : 'closed'}, so no reminder was sent. Reopen it in Help Scout if the customer still needs chasing.`,
            )
            return
          }

          // Recipient match: the email HS will actually send to vs the proof's
          // contact. Either side missing is a mismatch — fail toward a human.
          const hsEmail = (conv.primaryCustomer?.email ?? '').trim().toLowerCase()
          const contactEmail = (job.contactEmail ?? '').trim().toLowerCase()
          if (!hsEmail || !contactEmail || hsEmail !== contactEmail) {
            // Spell out the specific clash so the panel can show what to fix —
            // the Help Scout side is only known here, live, and isn't stored.
            let mismatchDetail: string
            if (!hsEmail && !contactEmail) {
              mismatchDetail = `Neither the Help Scout conversation nor this proof's contact has an email address, so there's no way to tell who a reminder would reach. Add the customer's email in both places.`
            } else if (!hsEmail) {
              mismatchDetail = `The linked Help Scout conversation has no customer email, so we can't confirm who a reminder would reach. This proof's contact is ${contactEmail}. Check the conversation in Help Scout.`
            } else if (!contactEmail) {
              mismatchDetail = `This proof's contact has no email address to match against Help Scout (which would email ${hsEmail}). Add the contact's email in Admin → Customers.`
            } else {
              mismatchDetail = `Help Scout will email ${hsEmail}, but this proof's contact is ${contactEmail}. Update the contact's email in Admin → Customers so the two match.`
            }
            await logSkip('recipient_mismatch', mismatchDetail)
            return
          }

          // Belt-and-braces for architecture rule #3: the live thread trail
          // catches a customer reply the webhook never delivered. For a bundle,
          // priorTouch is the bundle's own reminder history, so a reply on the
          // bundle thread newer than our last bundle touch still holds it back.
          const lastOutbound = Math.max(
            job.sendEvidenceAt ? Date.parse(job.sendEvidenceAt) : -Infinity,
            job.lastStaffReplyAt ? Date.parse(job.lastStaffReplyAt) : -Infinity,
            ...job.priorTouch.map((r) => Date.parse(r.createdAt)),
          )
          const newestCustomerThread = (conv._embedded?.threads ?? [])
            .filter((t) => t.createdBy?.type === 'customer' && t.createdAt)
            .map((t) => Date.parse(t.createdAt!))
            .reduce((a, b) => Math.max(a, b), -Infinity)
          if (newestCustomerThread > lastOutbound) {
            await logSkip(
              'skipped_customer_replied',
              `The customer replied on the Help Scout thread after our last message, so the reminder was held back. Open the conversation and reply to them directly.`,
            )
            return
          }

          // Render — {first_name} from the HS primaryCustomer so greeting and
          // recipient cannot diverge (they are equal-emailed by now anyway).
          // First token only: some Help Scout customer records carry a full
          // name in the first-name field, and "Hi Yasin Ludvigsen" reads like
          // a bot where "Hi Yasin" doesn't. A card link carries
          // ?from=reminder-N so record_proof_view attributes the open (000315);
          // a bundle link is left untouched — the bundle page tracks its own opens.
          const ctx: TemplateContext = {
            first_name: ((conv.primaryCustomer?.first ?? '').trim().split(/\s+/)[0] ?? '') ||
              (job.contactFullName ?? '').trim().split(/\s+/)[0] || '',
            full_name: job.contactFullName ?? '',
            company: job.companyName,
            version_number: job.versionNumber ?? '',
            url: job.link,
            designer_first_name: '',
          }
          // Gate against the TEMPLATE (pre-render): the renderer blanks
          // unknown tokens silently, so a post-render check can never fire.
          const problem = templateProblem(templateBody, ctx)
          if (problem) {
            await logSkip(
              `render_failed: ${problem}`,
              `The reminder couldn't be filled in (${problem}). Check the reminder template in Admin → Templates.`,
            )
            return
          }
          const rendered = renderTemplate(templateBody, ctx)
          // HTML form for the actual Help Scout send — escaped, {url}
          // wrapped in an <a> tag, newlines as <br>. Keeps the bare URL
          // from being auto-linked by Help Scout in a way that folds
          // trailing copy into the href (the iPhone-404 bug). The plain
          // `rendered` is still what we store on the ledger for display.
          // See _shared/messageHtml.ts.
          const renderedHtml = messageBodyToHtml(rendered)

          // Reminder #2+ opens a NEW conversation with a fresh subject
          // (spec section 6) — the deliverability lever, and the nudge-1
          // vs nudge-2 response split doubles as the spam signal in the
          // analytics. The subject is deliberately the SAME constant for
          // every fresh conversation (Rob, 2026-07-13): reminder #1 is a
          // reply and cannot change subject anyway, and varying the fresh
          // ones would fragment the customer's inbox threading. Falls back
          // to the same thread if HS ever returns a conversation without a
          // mailbox id — better in-thread than not at all.
          const freshConversation = job.nudgeNumber >= 2 && typeof conv.mailboxId === 'number'

          if (mode === 'dry_run') {
            const id = await insertLedgerRow({
              proof_id: job.proofId,
              proof_version_id: job.versionId,
              rule_code: job.ruleCode,
              template_id: templateId,
              source: 'auto',
              state: 'dry_run',
              outcome: freshConversation ? 'would_send_new_conversation' : 'would_send',
              helpscout_conversation_id: job.conversationId,
              proof_set_id: job.proofSetId,
              rendered_body: rendered,
            })
            if (id) sent++ // counted as a would-send in the run stats
            await logFolded()
            return
          }

          // ── LIVE: claim first (architecture rule #2) ──────────────────────
          claimId = await insertLedgerRow({
            proof_id: job.proofId,
            proof_version_id: job.versionId,
            rule_code: job.ruleCode,
            template_id: templateId,
            source: 'auto',
            state: 'sending',
            outcome: 'sending',
            helpscout_conversation_id: job.conversationId,
            proof_set_id: job.proofSetId,
            rendered_body: rendered,
          })
          if (!claimId) {
            console.warn('[send-nudges] claim conflict, already handled today', { proofId: job.proofId, kind: job.kind })
            return
          }

          // Sender identity: version designer → conversation assignee → default.
          const senderId = job.designerHelpscoutUserId ??
            conv.assignee?.id ??
            (Number.isInteger(defaultUserId) && defaultUserId > 0 ? defaultUserId : null)
          if (!senderId) {
            await admin.from('proof_nudges')
              .update({
                state: 'failed',
                outcome: 'failed: no sender identity (set HELPSCOUT_DEFAULT_USER_ID)',
                detail: `No Help Scout sender could be determined for this reminder (no version designer, no conversation assignee, and no default sender configured). Assign the conversation in Help Scout, or set a default sender.`,
              })
              .eq('id', claimId)
            errors.push({ proof_id: job.proofId, error: 'no sender identity' })
            return
          }

          const customerId = conv.primaryCustomer?.id
          if (!customerId) {
            await admin.from('proof_nudges')
              .update({
                state: 'failed',
                outcome: 'failed: conversation has no primary customer',
                detail: `The linked Help Scout conversation has no customer attached, so there was no one to email. Add the customer to the conversation in Help Scout.`,
              })
              .eq('id', claimId)
            errors.push({ proof_id: job.proofId, error: 'no primary customer' })
            return
          }

          // Reminder #1 replies into the existing thread (deliberately no
          // status flip: reopening / re-queueing conversations is a
          // designer-initiated semantic, not the bot's). Reminder #2+
          // creates a fresh conversation in the same mailbox; the new
          // conversation id replaces the original on the ledger row so the
          // webhook can stamp reply activity from it back onto the proof.
          let threadId = 0
          let newConversationId: string | null = null
          if (freshConversation) {
            newConversationId = await createStaffConversation(token, {
              mailboxId: conv.mailboxId!,
              subject: job.freshSubject,
              customerId,
              userId: senderId,
              text: renderedHtml,
            })
          } else {
            threadId = await postStaffReply(token, job.conversationId, {
              text: renderedHtml,
              userId: senderId,
              customerId,
              // A chase asks the customer to act, so the conversation belongs in
              // their queue, not the team's Active list — same pending semantic
              // as send-helpscout-reply and the reminder #2+ fresh conversation.
              status: 'pending',
            })
          }

          await admin.from('proof_nudges')
            .update({
              state: 'sent',
              outcome: freshConversation ? 'sent_new_conversation' : 'sent',
              helpscout_thread_id: threadId || null,
              ...(newConversationId ? { helpscout_conversation_id: newConversationId } : {}),
            })
            .eq('id', claimId)
          sent++

          // Send evidence for the next cycle + the proof detail page, stamped on
          // every card this reminder covered (all the bundle's due cards, or the
          // single card). last_reply_sent_by is explicitly NULLed (migration
          // 000215): an automated reminder re-stamps last_reply_sent_at, and
          // leaving a previous manual sender's id in place would attribute this
          // nudge to the wrong designer on the Activity timeline. NULL renders
          // unattributed.
          const stampedAt = new Date().toISOString()
          for (const v of job.stampVersions) {
            await admin.from('proof_versions')
              .update({ last_reply_sent_at: stampedAt, last_reply_sent_by: null })
              .eq('id', v.versionId)
              .eq('proof_id', v.proofId)
          }
          if (job.kind === 'bundle' && job.proofSetId && job.markSetSentOnSend) {
            // First bundle send for a never-sent set (see bundleChaseable's
            // unsent arm). The `is null` guard keeps a genuine designer send
            // that raced this run as the authoritative sent_at.
            await admin.from('proof_sets')
              .update({ sent_at: stampedAt })
              .eq('id', job.proofSetId)
              .is('sent_at', null)
          }
          await logFolded()

          // Audit trail (the ledger row is the canonical record; this makes
          // the send visible in the admin audit view alongside human sends).
          await admin.from('audit_log').insert({
            actor_id: null,
            actor_label: 'Automated reminder',
            action: 'proof.auto_nudge_sent',
            target_type: 'proof',
            target_id: job.proofId,
            metadata: {
              rule_code: job.ruleCode,
              template_id: templateId,
              nudge_id: claimId,
              helpscout_thread_id: threadId || null,
              nudge_number: job.nudgeNumber,
              new_conversation_id: newConversationId,
              proof_set_id: job.proofSetId,
              covered_proof_ids: job.kind === 'bundle'
                ? job.stampVersions.map((v) => v.proofId)
                : null,
              automated: true,
            },
          })
        } catch (err) {
          // An HsError from postStaffReply means HS rejected the POST —
          // definitively unsent, so the claim flips to 'failed' rather than
          // squatting in 'sending' (which would burn the cap slot and demand
          // pointless human verification).
          if (claimId && err instanceof HsError) {
            await admin.from('proof_nudges')
              .update({
                state: 'failed',
                outcome: `failed: hs_${err.status}`,
                detail: `Help Scout rejected the reminder (error ${err.status}), so nothing was sent. Open the conversation in Help Scout to check it.`,
              })
              .eq('id', claimId)
              .eq('state', 'sending')
          }
          if (err instanceof HsError && err.status === 429) {
            // Rate limited: stop the remainder — eligible work goes next run.
            errors.push({ error: 'hs_429_rate_limited, run stopped early' })
            console.error('[send-nudges] HS 429, stopping run early')
            haltForRateLimit = true
            return
          }
          const detail = err instanceof Error ? err.message : String(err)
          errors.push({ proof_id: job.proofId, error: detail })
          console.error('[send-nudges] item failed', { proofId: job.proofId, kind: job.kind, detail })
          // A claim left in 'sending' after a NON-HsError is deliberate: the
          // POST may have landed, so it counts toward the cap and surfaces
          // for human verification (resolve_stuck_nudge); never auto-retried.
        }
      }

      // Per-card jobs: standalone proofs + any bundle down to its last card.
      for (const c of grouped.send) {
        if (haltForRateLimit) break
        const rule = NUDGE_RULE_BY_CODE.get(c.ruleCode)!
        // Which reminder this is (1-based) decides the template body, the
        // fresh-conversation switch, and the link attribution tag. In dry-run
        // mode the simulated ledger advances it night-over-night.
        const nudgeNumber = nudgeNumberFor(c, ledger, c.ruleCode)
        const maxNudges = cfgByRule.get(c.ruleCode)?.automation.max_nudges ?? 2
        await processReminder({
          kind: 'card',
          proofId: c.proofId,
          versionId: c.versionId,
          conversationId: c.conversationId!,
          contactEmail: c.contactEmail,
          ruleCode: c.ruleCode,
          templateBaseId: rule.templateId,
          freshSubject: rule.freshSubject,
          nudgeNumber,
          maxNudges,
          link: baseUrl ? `${baseUrl}/p/${c.proofId}?from=reminder-${nudgeNumber}` : '',
          proofSetId: null,
          stampVersions: [{ proofId: c.proofId, versionId: c.versionId }],
          foldMembers: [],
          contactFullName: c.row.contact_full_name,
          companyName: c.row.company_name,
          versionNumber: c.row.version_number,
          designerHelpscoutUserId: c.row.designer_helpscout_user_id,
          sendEvidenceAt: c.sendEvidenceAt,
          lastStaffReplyAt: c.lastStaffReplyAt,
          priorTouch: capRows(ledger).filter((r) => r.proofId === c.proofId),
        })
      }

      // Bundle jobs: ONE reminder per bundle whose due cards were collapsed
      // (migration 000317). Its cap + cooldown are per-set (decideForBundle),
      // separate from any single card's, and it posts on the bundle's own thread
      // with the bundle review link.
      for (const bg of grouped.bundles) {
        if (haltForRateLimit) break
        const set = setInfoById.get(bg.bundleId)
        // The set must exist and have somewhere to post. A missing conversation
        // (older sets predate the field) falls back to the rep's own thread.
        const conversationId = set?.conversationId ?? bg.rep.conversationId
        if (!set || !conversationId) continue
        const bundleLedger = bundleLedgerBySet.get(bg.bundleId) ?? []
        const decision = decideForBundle(
          bundleLedger,
          { maxNudges: BUNDLE_MAX_NUDGES, repeatDays: BUNDLE_REPEAT_DAYS, bankHolidays },
          now,
          bg.rep.currency ?? null,
        )
        if (decision.action !== 'send') {
          const id = await insertLedgerRow({
            proof_id: bg.rep.proofId,
            proof_version_id: bg.rep.versionId,
            rule_code: BUNDLE_RULE_CODE,
            template_id: null,
            source: 'auto',
            state: logState,
            outcome: decision.action === 'skip' ? decision.outcome : 'dropped',
            helpscout_conversation_id: conversationId,
            proof_set_id: bg.bundleId,
          })
          if (id) skipped++
          continue
        }
        const nudgeNumber = bundleNudgeNumber(bundleLedger)
        await processReminder({
          kind: 'bundle',
          proofId: bg.rep.proofId,
          versionId: bg.rep.versionId,
          conversationId,
          contactEmail: bg.rep.contactEmail,
          ruleCode: BUNDLE_RULE_CODE,
          templateBaseId: BUNDLE_TEMPLATE_ID,
          freshSubject: BUNDLE_FRESH_SUBJECT,
          nudgeNumber,
          maxNudges: BUNDLE_MAX_NUDGES,
          link: baseUrl ? `${baseUrl}/bundle/${set.id}?token=${set.token}` : '',
          proofSetId: bg.bundleId,
          markSetSentOnSend: set.sentAt == null,
          stampVersions: bg.members.map((m) => ({ proofId: m.proofId, versionId: m.versionId })),
          foldMembers: bg.members
            .filter((m) => m.proofId !== bg.rep.proofId)
            .map((m) => ({ proofId: m.proofId, versionId: m.versionId, ruleCode: m.ruleCode })),
          contactFullName: bg.rep.row.contact_full_name,
          companyName: bg.rep.row.company_name,
          versionNumber: bg.rep.row.version_number,
          designerHelpscoutUserId: bg.rep.row.designer_helpscout_user_id,
          sendEvidenceAt: bg.rep.sendEvidenceAt,
          lastStaffReplyAt: bg.rep.lastStaffReplyAt,
          priorTouch: capRows(bundleLedger),
        })
      }
    }

    return json({
      ok: true,
      run_id: runId,
      mode,
      candidates: candidateCount,
      sent,
      skipped,
      errors: errors.length,
    })
  } catch (fatal) {
    // A throw anywhere above still reaches the finally (the run row closes
    // with honest counts) — but the failure itself must be IN the row, not
    // just the function logs, or the Outbox heartbeat reads healthy over a
    // run that died half-way.
    const detail = fatal instanceof Error ? fatal.message : String(fatal)
    errors.push({ fatal: detail })
    console.error('[send-nudges] run failed', detail)
    return json({ error: detail, run_id: runId }, 500)
  } finally {
    await admin.from('nudge_runs')
      .update({
        finished_at: new Date().toISOString(),
        candidates_computed: candidateCount,
        sent,
        skipped,
        errors: errors.length > 0 ? errors : null,
      })
      .eq('id', runId)
  }
}
