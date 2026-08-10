// artwork-check — the pre-print artwork sanity check (docs/artwork-check-spec.md).
//
// Invoked from OrderReviewPage between "folder linked" and the place-order
// Confirm. Gathers what the customer supplied (the Help Scout thread — read in
// FULL via pagination, raw bodies), the stored QR contents, and the recipient
// roster; reads the actual Dropbox PRINT files (hi-res .ai/.pdf — the thing
// that prints, not the proof JPEGs); reconciles them in one multimodal call;
// and stores the advisory report on the order. It never sends anything and
// never blocks on its own — a human always confirms the send.
//
// Modes (proofs.settings.artwork_check_mode):
//   off    — no-op (default).
//   shadow — full run, report stored on the order, page shows nothing.
//   live   — the advisory card renders on the review page.
// settings.artwork_check_required additionally makes RUNNING the check a
// precondition for place-order confirm (the verdict stays advisory) — that
// gate is enforced in place-order, not here.
//
// Caching: the latest report lives on orders.artwork_check, so re-opening the
// review page is instant; { force: true } re-runs (artwork can change between
// visits). An errored run is persisted too (verdict 'error') so a transient
// Help Scout / Dropbox outage can't strand an order behind the mandatory-run
// gate.
//
// Auth: verify_jwt = true. Designer/admin session JWT (the review page), or
// the service-role key (shadow backtests / scripts).

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { fetchAllConversationThreads, fetchAttachmentData, getAccessToken, HsError, type HsThreadWithAttachments } from '../_shared/helpscout.ts'
import { downloadSharedLinkFile, getDropboxAccessToken, listSharedLinkEntries } from '../_shared/dropbox.ts'
import { isCutThroughMaterial, looksLikePdf, pickPrintFiles } from '../_shared/artworkCheck/printFiles.ts'
import {
  analyseOrderArtwork,
  applyCutThroughFindings,
  buildCutThroughContext,
  dedupeMirroredFaces,
  summariseCutThrough,
  type CutThroughFace,
} from '../_shared/artworkCheck/cutThrough.ts'
import {
  attachmentDateLabel,
  pickAttachments,
  routeAttachment,
  routedToBlocks,
  type RoutedAttachment,
} from '../_shared/artworkCheck/attachments.ts'
import {
  APPROVED_IMAGE_MAX_BYTES,
  approvedImageBudget,
  pickApprovedImages,
  PROOF_IMAGES_TOTAL_MAX_BYTES,
} from '../_shared/artworkCheck/approvedProof.ts'
import { decodeQrsFromImage } from '../_shared/artworkCheck/qrDecode.ts'
import { fitImageForModel } from '../_shared/artworkCheck/imageResize.ts'
import {
  buildInvestigationContext,
  INVESTIGATION_FINAL_INSTRUCTION,
  INVESTIGATION_IMAGE_MAX_BYTES,
  INVESTIGATION_SCHEMA,
  INVESTIGATION_SYSTEM_PROMPT,
  INVESTIGATION_TOTAL_MAX_BYTES,
  investigationKey,
  matchCardToRecipient,
  pickInvestigationImages,
  resolveReportFlag,
  type Investigation,
  type InvestigationTimelineEntry,
  type VersionImageRowLite,
  type VersionRowLite,
} from '../_shared/artworkCheck/investigate.ts'
import { ACK_REASONS, ackKey, ackTargetExists, parseAckTarget } from '../_shared/artworkCheck/acks.ts'
import { callStructured } from '../_shared/artworkCheck/anthropic.ts'
import { threadToText } from '../_shared/artworkCheck/threadText.ts'
import {
  buildContextText,
  buildInputs,
  buildProofContextText,
  buildProofInputs,
  FINAL_INSTRUCTION,
  PROOF_FINAL_INSTRUCTION,
  PROOF_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  type CheckContext,
  type ProofCheckContext,
  type QrContext,
} from '../_shared/artworkCheck/prompts.ts'
import { bytesToBase64, callArtworkCheck, modelId, type ContentBlock } from '../_shared/artworkCheck/anthropic.ts'
import {
  buildErrorReport,
  buildReport,
  countCheckedFields,
  countDefects,
  countFlags,
} from '../_shared/artworkCheck/report.ts'
import type { ArtworkCheckReport } from '../_shared/artworkCheck/types.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Role claim without signature verification — safe because the platform has
// already verified the JWT (verify_jwt = true). Same as ai-draft.
function bearerRole(token: string): string | null {
  try {
    const payload = token.split('.')[1]
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    return typeof decoded?.role === 'string' ? decoded.role : null
  } catch {
    return null
  }
}

// Designer/admin session (the review page) or service role (shadow scripts).
// The caller's identity is RETURNED, not discarded: the 000357 run ledger
// records who asked for each check, which is the whole basis of the Admin →
// Analytics "by whom" reporting. userId is null for service-role callers.
async function requireCaller(req: Request): Promise<{ admin: SupabaseClient; userId: string | null } | Response> {
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.toLowerCase().startsWith('bearer ')) return json({ ok: false, error: 'Unauthorized' }, 401)
  const jwt = authHeader.replace(/^[Bb]earer\s+/, '').trim()
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!url || !serviceKey) return json({ ok: false, error: 'missing supabase env' }, 500)
  const admin = createClient(url, serviceKey, { db: { schema: 'proofs' }, auth: { persistSession: false, autoRefreshToken: false } })
  if (timingSafeEqual(jwt, serviceKey) || bearerRole(jwt) === 'service_role') return { admin, userId: null }
  const anon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY') ?? '')
  const { data: userData, error: userErr } = await anon.auth.getUser(jwt)
  if (userErr || !userData?.user) return json({ ok: false, error: 'Unauthorized' }, 401)
  const { data: profile } = await admin.from('profiles').select('role, deactivated_at').eq('id', userData.user.id).single()
  if (!profile || profile.deactivated_at) return json({ ok: false, error: 'Forbidden' }, 403)
  if (profile.role !== 'admin' && profile.role !== 'designer') return json({ ok: false, error: 'Forbidden' }, 403)
  return { admin, userId: userData.user.id }
}

// How this run was triggered, for the 000357 ledger's `source`. The
// distinction that matters: only 'designer' means a human chose to run the
// check. The order review page auto-runs on open under the designer's own
// JWT, so without the client's explicit marker every page visit would read as
// deliberate use and inflate the per-person figures.
type RunSource = 'designer' | 'auto_page' | 'auto_folder_link' | 'service'
function resolveRunSource(userId: string | null, bodyTrigger: unknown): RunSource {
  const trigger = typeof bodyTrigger === 'string' ? bodyTrigger : ''
  if (!userId) return trigger === 'auto_folder_link' ? 'auto_folder_link' : 'service'
  return trigger === 'auto' ? 'auto_page' : 'designer'
}

// settings.artwork_check_mode / _required, tolerant of the columns not
// existing yet (deployable before migration 000336 — same idiom as
// place-order's loadHandoffMode). The required gate only means anything in
// live mode: a shadow/off check isn't a precondition a reviewer can see.
//
// proof_check_enabled (000343, the pre-send proof-check gate) is read in a
// SEPARATE query, deliberately: supabase-js reports an unknown column as an
// error (data null), so bundling it into the main select would silently read
// the ORDER check's mode as off on a pre-000343 database. Two reads keep the
// function deployable before the migration — the proof mode just reads as off.
async function loadCheckSettings(admin: SupabaseClient): Promise<{ mode: 'off' | 'shadow' | 'live'; required: boolean; proofEnabled: boolean; model: string | null }> {
  let mode: 'off' | 'shadow' | 'live' = 'off'
  let required = false
  let model: string | null = null
  let proofEnabled = false
  try {
    const { data } = await admin.from('settings').select('artwork_check_mode, artwork_check_required, artwork_check_model').limit(1).maybeSingle()
    const raw = (data as { artwork_check_mode?: string | null; artwork_check_required?: boolean | null; artwork_check_model?: string | null } | null)
    mode = raw?.artwork_check_mode === 'shadow' ? 'shadow' : raw?.artwork_check_mode === 'live' ? 'live' : 'off'
    model = typeof raw?.artwork_check_model === 'string' && raw.artwork_check_model.trim() ? raw.artwork_check_model.trim() : null
    required = mode === 'live' && raw?.artwork_check_required === true
  } catch { /* defaults stand */ }
  try {
    const { data } = await admin.from('settings').select('proof_check_enabled').limit(1).maybeSingle()
    proofEnabled = (data as { proof_check_enabled?: boolean | null } | null)?.proof_check_enabled === true
  } catch { /* pre-000343 → proof mode off */ }
  return { mode, required, proofEnabled, model }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)

  const runStartedAt = Date.now()
  const check = await requireCaller(req)
  if (check instanceof Response) return check
  const { admin, userId } = check

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400)
  }
  const runSource = resolveRunSource(userId, body.trigger)
  const orderId = String(body.order_id ?? '').trim()
  const proofVersionId = String(body.proof_version_id ?? '').trim()
  const force = body.force === true
  if (!orderId && !proofVersionId) return json({ ok: false, error: 'order_id or proof_version_id is required' }, 400)
  if (orderId && proofVersionId) return json({ ok: false, error: 'Pass either order_id or proof_version_id, not both.' }, 400)

  const { mode, required, proofEnabled, model: settingModel } = await loadCheckSettings(admin)
  // The model this run uses everywhere (the call, the stored report's `model`,
  // error reports): the admin pick, else the env / compiled default.
  const runModel = settingModel || modelId()

  // ── Resolve the check target ───────────────────────────────────────────────
  // Two targets share one function: an ORDER (the 000336 pre-print check —
  // Dropbox print files vs the thread) or a PROOF VERSION (the 000343 pre-send
  // check — the version's own proof images vs the thread, run by a designer
  // BEFORE the customer sees the proof). Investigation, the cached fast path
  // and persistence all work off this resolution; the gather paths split below.
  type OrderRow = {
    id: string
    proof_id: string
    dropbox_folder_url: string | null
    material_id: string | null
    material_option_id: string | null
    stock_order_number: number | null
    project_name: string | null
    person_quantities: unknown
    artwork_check: unknown
    artwork_checked_at: string | null
    artwork_check_running_at: string | null
  }
  type VersionTargetRow = {
    id: string
    proof_id: string
    version_number: number
    is_current: boolean
    material_id: string | null
    material_display: string | null
    // Unused in proof mode (nothing is ordered yet, so every finish is under
    // review) — carried so this row still satisfies VersionRow below.
    material_options: string[] | null
    names: string[] | null
    artwork_check: unknown
    materials: { code: string; display_name: string | null } | null
  }
  let order: OrderRow | null = null
  let versionTarget: VersionTargetRow | null = null

  if (orderId) {
    if (mode === 'off') return json({ ok: true, mode, required })
    // The order (incl. the cached report — this select names the 000336
    // columns, so the function needs the migration applied; pre-migration it
    // errors here, which the page treats as "check unavailable").
    const { data, error: orderErr } = await admin
      .from('orders')
      .select('id, proof_id, dropbox_folder_url, material_id, material_option_id, stock_order_number, project_name, person_quantities, artwork_check, artwork_checked_at, artwork_check_running_at')
      .eq('id', orderId)
      .maybeSingle()
    if (orderErr) return json({ ok: false, error: `Order lookup failed: ${orderErr.message}` }, 500)
    if (!data) return json({ ok: false, error: 'Order not found.' }, 404)
    order = data as OrderRow
  } else {
    // Pre-send proof check — its own boolean gate, independent of the order
    // check's mode. enabled:false tells the proof page to render nothing.
    if (!proofEnabled) return json({ ok: true, kind: 'proof', enabled: false })
    const { data, error: verErr } = await admin
      .from('proof_versions')
      .select('id, proof_id, version_number, is_current, material_id, material_display, material_options, names, artwork_check, materials(code, display_name)')
      .eq('id', proofVersionId)
      .maybeSingle()
    if (verErr) return json({ ok: false, error: `Version lookup failed: ${verErr.message}` }, 500)
    if (!data) return json({ ok: false, error: 'Proof version not found.' }, 404)
    versionTarget = data as unknown as VersionTargetRow
  }

  const targetProofId = order ? order.proof_id : versionTarget!.proof_id
  const existingReport = (order ? order.artwork_check : versionTarget!.artwork_check) as ArtworkCheckReport | null
  // Response fields the clients key off: the review page reads mode/required
  // (order), the proof page reads kind/enabled (proof).
  const respBase: Record<string, unknown> = order ? { mode, required } : { kind: 'proof', enabled: true }
  // One persist path for both targets — the report columns share their names.
  async function persistReportPatch(patch: Record<string, unknown>): Promise<boolean> {
    const q = order
      ? admin.from('orders').update(patch).eq('id', order.id)
      : admin.from('proof_versions').update(patch).eq('id', versionTarget!.id)
    const { error: updErr } = await q
    if (updErr) console.error('[artwork-check] persist failed:', updErr.message)
    return !updErr
  }

  // Ledger the run (migration 000357) — one append-only row per completed run,
  // errors included, so Admin → Analytics can report frequency, who ran it and
  // the verdict mix without parsing report jsonb or being blind to re-runs
  // (which overwrite the stored report and would otherwise vanish).
  //
  // Best-effort and deliberately last: reporting must never cost a reviewer
  // their report. A failed insert is logged and swallowed — the run itself has
  // already been persisted by the time this is called.
  async function ledgerRun(report: ArtworkCheckReport): Promise<void> {
    try {
      const errored = report.verdict === 'error'
      const row = {
        check_kind: order ? 'order' : 'proof',
        order_id: order ? order.id : null,
        proof_version_id: order ? null : versionTarget!.id,
        proof_id: targetProofId,
        verdict: report.verdict,
        source: runSource,
        ran_by: userId,
        is_rerun: existingReport != null,
        flag_count: errored ? 0 : countFlags(report),
        defect_count: errored ? 0 : countDefects(report),
        checked_fields: errored ? 0 : countCheckedFields(report),
        model: report.model ?? null,
        input_tokens: report.usage?.input_tokens ?? null,
        output_tokens: report.usage?.output_tokens ?? null,
        cache_read_tokens: report.usage?.cache_read_tokens ?? null,
        cache_write_tokens: report.usage?.cache_write_tokens ?? null,
        duration_ms: Date.now() - runStartedAt,
        error: report.error ?? null,
        ran_at: report.checked_at,
      }
      // The full report rides on the row (000385) so a re-run's overwrite of
      // the live slot never erases what a superseded run actually said.
      const { error: insErr } = await admin.from('artwork_check_runs').insert({ ...row, report })
      if (insErr) {
        // Almost certainly a pre-000385 database (no `report` column): a lost
        // report column must not cost the run its ledger row — analytics
        // counts every run, so retry the legacy shape before giving up.
        console.error('[artwork-check] ledger insert failed, retrying without report:', insErr.message)
        const { error: retryErr } = await admin.from('artwork_check_runs').insert(row)
        if (retryErr) console.error('[artwork-check] ledger insert retry failed:', retryErr.message)
      }
    } catch (e) {
      console.error('[artwork-check] ledger insert threw:', e instanceof Error ? e.message : String(e))
    }
  }

  // Mirror a mutated report (a tick landing, a tick undone, an investigation
  // cached) onto its run-ledger row (000385), matched on order/version +
  // ran_at = the report's checked_at — unique per run. This is what makes the
  // ledger row the report's FINAL state rather than its at-birth state, so
  // when a re-run replaces the live slot the superseded report keeps the
  // ticks it had. Best-effort: a miss (pre-000385 database, or a run older
  // than the ledger) is logged and costs only history — the live slot stays
  // authoritative and the designer's action has already succeeded.
  async function mirrorReportToLedger(updated: ArtworkCheckReport): Promise<void> {
    try {
      const q = order
        ? admin.from('artwork_check_runs').update({ report: updated }).eq('order_id', order.id)
        : admin.from('artwork_check_runs').update({ report: updated }).eq('proof_version_id', versionTarget!.id)
      const { error: mirrorErr } = await q.eq('ran_at', updated.checked_at)
      if (mirrorErr) console.error('[artwork-check] ledger mirror failed:', mirrorErr.message)
    } catch (e) {
      console.error('[artwork-check] ledger mirror threw:', e instanceof Error ? e.message : String(e))
    }
  }

  // ── One run at a time, per order (migration 000346) ────────────────────────
  // Order prep fires this function twice in parallel by design: linking the
  // Dropbox folder trips the 000337 trigger (force:true), and the reviewer
  // opens the review page moments later, which auto-runs the check itself.
  // Both used to run in full and write the report blind, so the last to
  // finish won — and the reviewer was usually reading the other one (live
  // case: order 403922, 2026-07-26). Now the first caller claims the run and
  // the second WAITS for its report, so a) we pay for one pass over the print
  // files, not two, and b) what the reviewer reads is what the order stores.
  //
  // The claim is a conditional UPDATE, which Postgres serialises on the row —
  // exactly one caller can win it. A stamp older than the TTL means a run
  // died mid-flight and is up for grabs again; nothing can wedge an order out
  // of being checked.
  const RUN_CLAIM_TTL_MS = 5 * 60_000
  const RUN_WAIT_MAX_MS = 110_000 // stays inside the function's wall-clock ceiling
  const RUN_WAIT_POLL_MS = 2_000

  function claimIsLive(stamp: string | null): boolean {
    return stamp !== null && Date.now() - Date.parse(stamp) < RUN_CLAIM_TTL_MS
  }

  async function claimRun(orderId: string): Promise<boolean> {
    const staleBefore = new Date(Date.now() - RUN_CLAIM_TTL_MS).toISOString()
    const { data, error: claimErr } = await admin
      .from('orders')
      .update({ artwork_check_running_at: new Date().toISOString() })
      .eq('id', orderId)
      .or(`artwork_check_running_at.is.null,artwork_check_running_at.lt.${staleBefore}`)
      .select('id')
    // A failed claim WRITE (not a lost race) must not block the check —
    // degrade to the old behaviour and run.
    if (claimErr) {
      console.error('[artwork-check] claim failed:', claimErr.message)
      return true
    }
    return Array.isArray(data) && data.length > 0
  }

  async function releaseClaim(orderId: string): Promise<void> {
    const { error: relErr } = await admin.from('orders').update({ artwork_check_running_at: null }).eq('id', orderId)
    if (relErr) console.error('[artwork-check] claim release failed:', relErr.message)
  }

  // Wait for the run already in flight and hand back ITS report. Returns null
  // if the wait runs out or that run died without storing anything.
  async function waitForRunningReport(orderId: string): Promise<ArtworkCheckReport | null> {
    const deadline = Date.now() + RUN_WAIT_MAX_MS
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, RUN_WAIT_POLL_MS))
      const { data } = await admin
        .from('orders')
        .select('artwork_check, artwork_check_running_at')
        .eq('id', orderId)
        .maybeSingle()
      const row = data as { artwork_check: ArtworkCheckReport | null; artwork_check_running_at: string | null } | null
      if (!row) return null
      // Cleared = that run finished and stored its report, in one patch.
      if (row.artwork_check_running_at === null) return row.artwork_check
      if (!claimIsLive(row.artwork_check_running_at)) return null // it died
    }
    return null
  }

  // The answer for a caller that couldn't claim: the in-flight run's report,
  // else whatever is stored, else an honest "come back in a moment".
  async function respondToInFlightRun(orderId: string): Promise<Response> {
    const waited = await waitForRunningReport(orderId)
    if (waited) return json({ ok: true, ...respBase, report: waited, waited: true })
    if (existingReport) return json({ ok: true, ...respBase, cached: true, report: existingReport })
    return json({ ok: false, ...respBase, error: 'A check is already running for this order — give it a moment and try again.' }, 409)
  }

  // ── Flag investigation (designer-triggered escalation) ────────────────────
  // Scoped to ONE flag: walks the flagged card's artwork across every proof
  // version against the thread's dated instructions and returns a timeline +
  // fault lean, cached on the report so the walk is paid for once. Never runs
  // automatically — only from the Investigate button on a rendered flag.
  const investigateReq = body.investigate as { card?: string; field?: string } | undefined
  if (investigateReq) {
    const report = existingReport
    if (!report) return json({ ok: false, error: 'Run the artwork check first — there is no report to investigate.' }, 400)
    const card = String(investigateReq.card ?? '')
    const field = String(investigateReq.field ?? '')

    // Every round of this proof, oldest first — the walk reads forward, and
    // the roster is needed up here to resolve the flag (below).
    const { data: verRows } = await admin
      .from('proof_versions')
      .select('id, version_number, created_at, material_display, names')
      .eq('proof_id', targetProofId)
      .order('version_number', { ascending: true })
    const versions = (verRows ?? []) as (VersionRowLite & { names: string[] | null })[]
    if (versions.length === 0) return json({ ok: false, error: 'No proof versions found.' }, 404)

    // The union of every round's roster (people join later rounds).
    const allNames = [...new Set(versions.flatMap((v) => (Array.isArray(v.names) ? v.names : []).map((n) => String(n).trim()).filter(Boolean)))]

    // Match the flag the designer clicked onto the report the DATABASE holds
    // — tolerantly, because a re-run rewords the labels (see
    // resolveReportFlag). A genuine miss means the page is showing a report
    // that no longer exists: hand back the current one so the client can
    // refresh in place instead of leaving a dead button.
    const finding = resolveReportFlag(report.cards, { card, field }, allNames)
    if (!finding) {
      return json({
        ok: false,
        ...respBase,
        code: 'stale_report',
        error: 'This check has been re-run since the page loaded, and that flag isn’t on the new report. The flags below are the current ones.',
        report,
      }, 409)
    }

    // Keyed on the STORED label, so the cached walk is found again after a
    // refresh renders that label.
    const key = investigationKey(finding.card, field)
    const existing = (report as { investigations?: Record<string, Investigation> }).investigations?.[key]
    if (existing && !force) return json({ ok: true, ...respBase, cached: true, key, investigation: existing })

    try {
      // The recipient the flagged card belongs to.
      const recipient = matchCardToRecipient(finding.card, allNames)

      const { data: imgRows } = await admin
        .from('proof_version_images')
        .select('proof_version_id, image_path, associated_name, side, is_qr_code')
        .in('proof_version_id', versions.map((v) => v.id))
      const picks = pickInvestigationImages(versions, (imgRows ?? []) as VersionImageRowLite[], recipient)

      // Thread for the instruction dates (same full, raw, paginated read as
      // the main check; attachments aren't needed for sequencing). This branch
      // runs before the main flow's proof load, so it resolves the linked
      // conversation itself.
      const { data: invProof } = await admin
        .from('proofs')
        .select('helpscout_conversation_id')
        .eq('id', targetProofId)
        .maybeSingle()
      const conversationId = (invProof as { helpscout_conversation_id: string | null } | null)?.helpscout_conversation_id ?? null
      let threadText = ''
      let threadGapNote: string | null = null
      if (conversationId) {
        const appId = Deno.env.get('HELPSCOUT_APP_ID')?.trim()
        const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')?.trim()
        if (appId && appSecret) {
          try {
            const token = await getAccessToken(appId, appSecret)
            const threads = await fetchAllConversationThreads(token, conversationId)
            if (threads) threadText = threadToText(threads).text
            else threadGapNote = 'the linked Help Scout conversation no longer exists'
          } catch {
            threadGapNote = 'Help Scout could not be read'
          }
        } else {
          threadGapNote = 'Help Scout credentials not configured'
        }
      } else {
        threadGapNote = 'this proof has no linked Help Scout conversation'
      }

      let investigation: Investigation
      if (picks.length === 0) {
        // Nothing visual to walk — answer honestly without an AI call.
        investigation = {
          timeline: versions.map((v): InvestigationTimelineEntry => ({
            at: v.created_at ? v.created_at.slice(0, 10) : 'unknown',
            kind: 'version',
            label: `v${v.version_number}`,
            detail: 'No readable artwork stored for this card in this round.',
          })),
          conclusion: 'No stored artwork could be read for this card in any round, so the history cannot be walked — compare the flag against the thread dates in the main report.',
          fault: 'undetermined',
          card: finding.card,
          field,
          at: new Date().toISOString(),
          model: runModel,
          usage: null,
        }
      } else {
        const blocks: ContentBlock[] = [{
          type: 'text',
          text: buildInvestigationContext(
            { card: finding.card, field, printed: finding.printed, supplied: finding.supplied, note: finding.note },
            versions,
            recipient,
            threadText,
            threadGapNote,
          ),
        }]
        let total = 0
        const included: string[] = []
        for (const pick of picks) {
          const { data: blob, error: dlErr } = await admin.storage.from('proof-images').download(pick.path)
          if (dlErr || !blob) continue
          const raw = new Uint8Array(await blob.arrayBuffer())
          // Fit for the model first — an oversized version image would 400 the
          // whole investigation (see imageResize.ts). This path reports no
          // per-image reasons, so an unfittable one is skipped quietly, exactly
          // as a failed download already is.
          const fitted = await fitImageForModel(raw, pick.mediaType)
          if (!fitted.ok) continue
          const bytes = fitted.bytes
          if (bytes.length > INVESTIGATION_IMAGE_MAX_BYTES) continue
          if (total + bytes.length > INVESTIGATION_TOTAL_MAX_BYTES) break
          total += bytes.length
          included.push(pick.label)
          blocks.push({ type: 'text', text: `${pick.label}:` })
          blocks.push({ type: 'image', source: { type: 'base64', media_type: pick.mediaType, data: bytesToBase64(bytes) } })
        }
        if (included.length === 0) return json({ ok: false, error: 'The version artwork could not be downloaded — try again.' }, 502)
        blocks.push({ type: 'text', text: INVESTIGATION_FINAL_INSTRUCTION })

        const { result, usage } = await callStructured<Pick<Investigation, 'timeline' | 'conclusion' | 'fault'>>(
          INVESTIGATION_SYSTEM_PROMPT,
          blocks,
          INVESTIGATION_SCHEMA,
          runModel,
        )
        investigation = {
          ...result,
          card: finding.card,
          field,
          at: new Date().toISOString(),
          model: runModel,
          usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
        }
      }

      // Cache on the report so the walk is paid for once. Last-write-wins is
      // fine here; a force re-run of the MAIN check discards investigations
      // deliberately (new report, new flags).
      const updated = {
        ...report,
        investigations: { ...((report as { investigations?: Record<string, Investigation> }).investigations ?? {}), [key]: investigation },
      }
      const persisted = await persistReportPatch({ artwork_check: updated })
      await mirrorReportToLedger(updated as ArtworkCheckReport)
      return json({ ok: true, ...respBase, key, investigation, persisted })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[artwork-check] investigation failed:', msg)
      return json({ ok: false, error: `The investigation couldn't run: ${msg.slice(0, 300)}` }, 502)
    }
  }

  // ── Advisory tick-off ("Mark as addressed", per acks.ts) ──────────────────
  // Writes ONE ack entry onto the stored report (or removes one, for undo).
  // Same lifecycle as an investigation — cached on the report, wiped by any
  // re-run — but stricter about identity: the tick must land on exactly the
  // item the designer read, so the client sends the report's checked_at as a
  // concurrency token and matching is exact, never resolveReportFlag's
  // tolerant kind. A mismatch hands back the stored report as stale_report
  // (the shape the clients already handle for investigations).
  const ackReq = body.acknowledge as Record<string, unknown> | undefined
  if (ackReq) {
    // A tick is a human judgement with a name on it — no service-role acks.
    if (!userId) return json({ ok: false, error: 'Only a signed-in designer can tick off advisories.' }, 403)
    const report = existingReport
    if (!report) return json({ ok: false, error: 'Run the check first — there is no report to update.' }, 400)
    if (report.verdict === 'error') return json({ ok: false, error: 'An errored run has no advisories to tick off — re-run the check.' }, 400)

    const staleResponse = (current: ArtworkCheckReport) =>
      json({
        ok: false,
        ...respBase,
        code: 'stale_report',
        error: 'This check has been re-run since the page loaded — the report below is the current one. Tick items off there.',
        report: current,
      }, 409)

    const target = parseAckTarget(ackReq)
    if (!target) return json({ ok: false, error: 'Malformed acknowledgement target.' }, 400)
    // The token: the tick was made against THIS run's report, or not at all.
    if (String(ackReq.checked_at ?? '') !== report.checked_at) return staleResponse(report)
    if (!ackTargetExists(report, target)) return staleResponse(report)

    const key = ackKey(target)
    const undo = ackReq.undo === true
    const acknowledgements = { ...(report.acknowledgements ?? {}) }
    if (undo) {
      delete acknowledgements[key]
    } else {
      const reason = ACK_REASONS.find((r) => r === ackReq.reason)
      if (!reason) return json({ ok: false, error: 'A reason is required to mark an advisory as addressed.' }, 400)
      const { data: prof } = await admin.from('profiles').select('full_name').eq('id', userId).maybeSingle()
      const by = ((prof as { full_name?: string | null } | null)?.full_name ?? '').trim() || 'Designer'
      acknowledgements[key] = { reason, by, by_id: userId, at: new Date().toISOString() }
    }
    const updated: ArtworkCheckReport = { ...report, acknowledgements }

    // Conditional on the stored report still being the one the tick was made
    // against, so a re-run finishing in this exact moment can't be clobbered
    // with report-plus-tick (the reverse race — the re-run storing after us —
    // wipes the tick wholesale, which is the intended reset).
    const q = order
      ? admin.from('orders').update({ artwork_check: updated }).eq('id', order.id)
      : admin.from('proof_versions').update({ artwork_check: updated }).eq('id', versionTarget!.id)
    const { data: updRows, error: updErr } = await q
      .filter('artwork_check->>checked_at', 'eq', report.checked_at)
      .select('id')
    if (updErr) return json({ ok: false, error: `Couldn’t save the tick: ${updErr.message}` }, 500)
    if (!Array.isArray(updRows) || updRows.length === 0) {
      const { data: freshRow } = order
        ? await admin.from('orders').select('artwork_check').eq('id', order.id).maybeSingle()
        : await admin.from('proof_versions').select('artwork_check').eq('id', versionTarget!.id).maybeSingle()
      const fresh = (freshRow as { artwork_check: ArtworkCheckReport | null } | null)?.artwork_check ?? null
      if (fresh) return staleResponse(fresh)
      return json({ ok: false, error: 'The stored report changed underneath this tick — reload and try again.' }, 409)
    }
    await mirrorReportToLedger(updated)
    // `acknowledged: true` is the deploy-skew sentinel: a pre-ack function
    // falls through to the cached-report path instead, and the client treats
    // a response without this field as "the service needs its update".
    return json({ ok: true, ...respBase, acknowledged: true, report: updated })
  }

  // A run already in flight wins, even over a cached report and even for a
  // force request: the report about to land IS the fresh one, and showing the
  // reviewer the copy it's about to replace is precisely the divergence this
  // guard exists to stop.
  if (order && claimIsLive(order.artwork_check_running_at)) {
    return await respondToInFlightRun(order.id)
  }

  if (existingReport && !force) {
    return json({ ok: true, ...respBase, cached: true, report: existingReport })
  }

  // Claim the run. Losing here means another caller claimed it in the moment
  // between the read above and now — wait for theirs rather than duplicating.
  if (order && !(await claimRun(order.id))) {
    return await respondToInFlightRun(order.id)
  }

  // ── Gather the shared context (proof, names, QRs, account fields) ──────────
  const { data: proof } = await admin
    .from('proofs')
    .select('id, helpscout_conversation_id, contacts:contact_id ( full_name, email, companies:company_id ( name ) )')
    .eq('id', targetProofId)
    .maybeSingle()
  const conversationId = (proof as { helpscout_conversation_id: string | null } | null)?.helpscout_conversation_id ?? null
  const contact = (proof as { contacts?: { full_name?: string | null; email?: string | null; companies?: { name?: string | null } | null } | null } | null)?.contacts ?? null

  // The version being checked. Proof mode: the target version itself. Order
  // mode: the version this ORDER was placed against — the version whose
  // material matches the order's, not blindly the current one (place-order's
  // rule; a proof can carry orders in two materials).
  type VersionRow = {
    id: string
    version_number: number
    is_current: boolean
    material_id: string | null
    material_display: string | null
    material_options: string[] | null
    names: string[] | null
    materials: { code: string; display_name: string | null } | null
  }
  let pv: VersionRow
  if (order) {
    const { data: versionRows } = await admin
      .from('proof_versions')
      .select('id, version_number, is_current, material_id, material_display, material_options, names, materials(code, display_name)')
      .eq('proof_id', order.proof_id)
      .order('version_number', { ascending: false })
    const allVersions = (versionRows ?? []) as VersionRow[]
    const orderMaterialId = order.material_id ?? null
    const materialMatches = orderMaterialId ? allVersions.filter((v) => v.material_id === orderMaterialId) : []
    const picked = materialMatches.find((v) => v.is_current) ?? materialMatches[0] ?? allVersions.find((v) => v.is_current) ?? null
    if (!picked) {
      // The one exit between claiming and finish() that stores no report.
      await releaseClaim(order.id)
      return json({ ok: false, error: 'No proof version found.' }, 404)
    }
    pv = picked
  } else {
    pv = versionTarget!
  }

  const recipients = (Array.isArray(pv.names) ? pv.names : []).map((n) => String(n).trim()).filter(Boolean)
  const rawSplit = order && Array.isArray(order.person_quantities) ? order.person_quantities : []
  const quantitySplit = rawSplit
    .filter((p: { name?: unknown; quantity?: unknown }) => p && typeof p.name === 'string' && p.name.trim() && Number(p.quantity) > 0)
    .map((p: { name: string; quantity: unknown }) => `${p.name.trim()} — ${Number(p.quantity)}`)

  // Every image row for the version in one read: QR rows carry the exact
  // decoded payloads (000168; hosted vCards additionally carry the approved-
  // contact snapshot, 000194), and the non-QR rows are the approved proof
  // images Leg C compares the print files against.
  const { data: imageRows } = await admin
    .from('proof_version_images')
    .select('image_path, original_filename, is_qr_code, qr_decoded_data, qr_kind, qr_vcard_slug, associated_name, side, material_option')
    .eq('proof_version_id', pv.id)
  type QrRow = { qr_decoded_data: string | null; qr_kind: string | null; qr_vcard_slug: string | null; associated_name: string | null; side: string | null; is_qr_code?: boolean | null; image_path?: string | null; original_filename?: string | null; material_option?: string | null }
  const allImageRows = (imageRows ?? []) as QrRow[]
  const qrRowsTyped = allImageRows.filter((q) => q.is_qr_code === true && q.qr_decoded_data)
  const qrs: QrContext[] = qrRowsTyped.map((q) => ({
    kind: q.qr_kind ?? 'unknown',
    decoded: q.qr_decoded_data as string,
    associatedName: q.associated_name,
    side: q.side,
  }))
  // The finish this ORDER was bought against. A version proofed in three metal
  // finishes carries three images per side, and only one set is what will
  // print — feeding Leg C all three makes the model reconcile print files
  // against artwork the customer didn't buy, which reads as a missing print
  // file (or masks a real mismatch). Scoped exactly as the designer-facing
  // hand-off is (src/lib/approvedArtworkFinish.ts); an unresolvable finish
  // falls back to every image rather than none, so the check never goes blind.
  // Proof mode is deliberately untouched: nothing is ordered yet, so every
  // proofed finish is legitimately under review.
  let approvedImageRows = allImageRows
  if (order) {
    const versionOptionCodes = Array.isArray(pv.material_options) ? pv.material_options : []
    if (versionOptionCodes.length > 0 && order.material_option_id) {
      const { data: optRow } = await admin
        .from('material_options')
        .select('code, display_name')
        .eq('id', order.material_option_id)
        .maybeSingle()
      const opt = optRow as { code: string | null; display_name: string | null } | null
      const code = opt?.code ?? null
      if (code) {
        // QR rows carry no finish tab, so scope only the artwork and keep every
        // QR row — dropping one would lose a payload the check verifies.
        const artworkRows = allImageRows.filter((r) => r.is_qr_code !== true)
        const scoped = artworkRows.filter((r) => r.material_option === code)
        if (scoped.length > 0) {
          approvedImageRows = [...allImageRows.filter((r) => r.is_qr_code === true), ...scoped]
        }
      }
    }
  }

  // A hosted vCard QR decodes to only the qcrd.uk short URL; the contact
  // fields the customer approved live in the slug-keyed qr_snapshot written at
  // approval time (000194). Attach each snapshot to its QR so the model
  // verifies real fields, not a blind URL.
  if (qrRowsTyped.some((q) => q.qr_kind === 'hosted_vcard' && q.qr_vcard_slug)) {
    const { data: approvals } = await admin
      .from('proof_name_approvals')
      .select('qr_snapshot')
      .eq('proof_version_id', pv.id)
      .not('qr_snapshot', 'is', null)
    const snapshots = (approvals ?? []) as { qr_snapshot: Record<string, unknown> | null }[]
    qrRowsTyped.forEach((row, i) => {
      const slug = row.qr_kind === 'hosted_vcard' ? row.qr_vcard_slug : null
      if (!slug) return
      const snap = snapshots.map((s) => s.qr_snapshot?.[slug]).find((v) => v != null)
      if (snap != null) qrs[i].snapshot = snap
    })
  }

  // ── Pre-send proof check: gather + call ────────────────────────────────────
  // The card side is this version's own proof images (no Dropbox — the images
  // ARE the artwork being checked), scanned for QR payloads on the way, with
  // the thread + customer attachments as the reference side. No approved-proof
  // leg: nothing is approved yet. Self-contained; the order path continues
  // below untouched.
  if (versionTarget) {
    const vt = versionTarget
    const proofCtx: ProofCheckContext = {
      proofLabel: contact?.companies?.name ?? contact?.full_name ?? 'Customer',
      versionNumber: vt.version_number,
      materialDisplay: pv.materials?.display_name ?? pv.material_display ?? null,
      materialCode: pv.materials?.code ?? null,
      cutThrough: isCutThroughMaterial(pv.materials?.code),
      recipients,
      accountContact: {
        name: contact?.full_name ?? null,
        email: contact?.email ?? null,
        company: contact?.companies?.name ?? null,
      },
      qrs,
      artworkDecodedQrs: [],
      threadText: '',
      threadGapNote: null,
      proofImagesRead: [],
      proofImagesSkipped: [],
      attachmentsRead: [],
      attachmentsSkipped: [],
    }
    let threadMessages = 0
    let threadFound = false
    let hsToken: string | null = null
    let hsThreads: HsThreadWithAttachments[] | null = null

    // Persist + respond, success or error alike — an errored run is a stored
    // report with a Re-check, never a stranded button.
    async function finishProof(report: ArtworkCheckReport): Promise<Response> {
      const persisted = await persistReportPatch({
        artwork_check: report,
        artwork_checked_at: report.checked_at,
        artwork_check_verdict: report.verdict,
      })
      await ledgerRun(report)
      return json({ ok: true, ...respBase, report, persisted })
    }

    try {
      // The thread — the labelled twin of the order path's read (same full,
      // raw, paginated fetch; an outage degrades to a reference gap).
      if (conversationId) {
        const appId = Deno.env.get('HELPSCOUT_APP_ID')?.trim()
        const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')?.trim()
        if (!appId || !appSecret) {
          proofCtx.threadGapNote = 'Help Scout credentials not configured'
        } else {
          try {
            const token = await getAccessToken(appId, appSecret)
            const threads = await fetchAllConversationThreads(token, conversationId)
            if (threads === null) {
              proofCtx.threadGapNote = 'the linked Help Scout conversation no longer exists'
            } else {
              hsToken = token
              hsThreads = threads
              const flat = threadToText(threads)
              proofCtx.threadText = flat.text
              threadMessages = flat.messageCount
              threadFound = flat.messageCount > 0
              if (!threadFound) proofCtx.threadGapNote = 'the linked conversation has no readable messages'
            }
          } catch (e) {
            proofCtx.threadGapNote = `Help Scout could not be read (${e instanceof HsError ? e.status : 'error'})`
          }
        }
      } else {
        proofCtx.threadGapNote = 'this proof has no linked Help Scout conversation'
      }

      // The version's images — picked and labelled exactly like Leg C's
      // gallery order, QR-scanned before the size gate.
      const imageBlocks: ContentBlock[] = []
      let imagesRawTotal = 0
      const artworkQrSeen = new Set<string>()
      {
        const { picks, skipped } = pickApprovedImages(allImageRows)
        proofCtx.proofImagesSkipped.push(...skipped)
        for (const pick of picks) {
          try {
            const { data: blob, error: dlErr } = await admin.storage.from('proof-images').download(pick.path)
            if (dlErr || !blob) {
              proofCtx.proofImagesSkipped.push({ name: pick.label, reason: 'download failed' })
              continue
            }
            const raw = new Uint8Array(await blob.arrayBuffer())
            // QR scan reads the ORIGINAL pixels — a code decodes better at full
            // resolution, and the decoder downscales internally anyway.
            for (const qr of await decodeQrsFromImage(raw)) {
              if (!artworkQrSeen.has(qr.data)) {
                artworkQrSeen.add(qr.data)
                proofCtx.artworkDecodedQrs.push(qr.data)
              }
            }
            // Then fit for the model: over ~8000px on any edge the API rejects
            // the whole request, so a single huge export would take the run
            // down with it (see imageResize.ts).
            const fitted = await fitImageForModel(raw, pick.mediaType)
            if (!fitted.ok) {
              proofCtx.proofImagesSkipped.push({ name: pick.label, reason: fitted.reason })
              continue
            }
            const bytes = fitted.bytes
            if (bytes.length > APPROVED_IMAGE_MAX_BYTES) {
              proofCtx.proofImagesSkipped.push({ name: pick.label, reason: 'over the size limit' })
              continue
            }
            if (imagesRawTotal + bytes.length > PROOF_IMAGES_TOTAL_MAX_BYTES) {
              proofCtx.proofImagesSkipped.push({ name: pick.label, reason: 'size budget reached' })
              continue
            }
            imagesRawTotal += bytes.length
            proofCtx.proofImagesRead.push(pick.label)
            imageBlocks.push({ type: 'text', text: `Proof image ${proofCtx.proofImagesRead.length}: ${pick.label}:` })
            imageBlocks.push({ type: 'image', source: { type: 'base64', media_type: pick.mediaType, data: bytesToBase64(bytes) } })
          } catch {
            proofCtx.proofImagesSkipped.push({ name: pick.label, reason: 'download failed' })
          }
        }
      }
      if (imageBlocks.length === 0) {
        return await finishProof(buildErrorReport(runModel, 'no readable proof images on this version', buildProofInputs(proofCtx, threadMessages, threadFound)))
      }

      // Customer attachments — same best-effort read as the order path, the
      // byte budget sized around what the images used. Staff attachments are
      // excluded inside pickAttachments.
      const routedAttachments: RoutedAttachment[] = []
      if (conversationId && hsToken && hsThreads) {
        const { picks, skipped } = pickAttachments(hsThreads, imagesRawTotal)
        proofCtx.attachmentsSkipped.push(...skipped)
        for (const meta of picks) {
          try {
            const bytes = await fetchAttachmentData(hsToken, conversationId, meta.id)
            if (!bytes) {
              proofCtx.attachmentsSkipped.push({ name: meta.filename, reason: 'download failed' })
              continue
            }
            const routed = await routeAttachment(meta, bytes)
            if (!routed) {
              proofCtx.attachmentsSkipped.push({ name: meta.filename, reason: 'contents not readable' })
              continue
            }
            // A print-resolution reference image gets downscaled rather than
            // dropped: over ~8000px on an edge the API rejects the ENTIRE
            // request, so one of these takes the whole run down (see
            // imageResize.ts). Byte accounting deliberately still counts the
            // original download, keeping the budget no looser than before.
            let toSend = routed
            if (routed.kind === 'image') {
              const fitted = await fitImageForModel(routed.bytes, routed.mediaType)
              if (!fitted.ok) {
                proofCtx.attachmentsSkipped.push({ name: meta.filename, reason: fitted.reason })
                continue
              }
              toSend = { ...routed, bytes: fitted.bytes }
            }
            routedAttachments.push(toSend)
            proofCtx.attachmentsRead.push({ name: meta.filename, at: attachmentDateLabel(meta.at) })
          } catch {
            proofCtx.attachmentsSkipped.push({ name: meta.filename, reason: 'download failed' })
          }
        }
      }
      const attachmentBlocks = routedToBlocks(routedAttachments)

      const content: ContentBlock[] = [
        { type: 'text', text: buildProofContextText(proofCtx) },
        { type: 'text', text: 'PROOF IMAGES (the artwork being checked, labelled per card):' },
        ...imageBlocks,
        ...(attachmentBlocks.length > 0
          ? [{ type: 'text', text: 'CUSTOMER-SUPPLIED ATTACHMENTS (reference material, labelled per file):' } as ContentBlock, ...attachmentBlocks]
          : []),
        { type: 'text', text: PROOF_FINAL_INSTRUCTION },
      ]
      const { result, usage } = await callArtworkCheck(PROOF_SYSTEM_PROMPT, content, runModel)
      return await finishProof(buildReport(runModel, result, buildProofInputs(proofCtx, threadMessages, threadFound), usage))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[artwork-check] proof-check run failed:', msg)
      return await finishProof(buildErrorReport(runModel, msg.slice(0, 500), buildProofInputs(proofCtx, threadMessages, threadFound)))
    }
  }

  // ── Order mode from here down ──────────────────────────────────────────────
  if (!order) return json({ ok: false, error: 'No check target resolved.' }, 500)

  const orderLabel = `Order ${order.stock_order_number ?? ''} — ${order.project_name ?? contact?.companies?.name ?? contact?.full_name ?? 'customer'}`.trim()

  // Inputs accumulate as gathering proceeds so an error report still records
  // what HAD been fetched when the run died.
  const baseCtx: CheckContext = {
    orderLabel,
    // Deliberately NOT annotated with the ordered finish. A metal finish is a
    // treatment of the blank, not something in the artwork — print files are
    // one per side, named by material (02_Front_Steel.ai), never per finish.
    // Naming the finish here would hand the model a claim it cannot ground in
    // any file it's reading, which is a false-flag source, not a check.
    materialDisplay: pv.materials?.display_name ?? pv.material_display ?? null,
    materialCode: pv.materials?.code ?? null,
    cutThrough: isCutThroughMaterial(pv.materials?.code),
    recipients,
    quantitySplit,
    accountContact: {
      name: contact?.full_name ?? null,
      email: contact?.email ?? null,
      company: contact?.companies?.name ?? null,
    },
    qrs,
    artworkDecodedQrs: [],
    threadText: '',
    threadGapNote: null,
    printFileNames: [],
    skippedFiles: [],
    attachmentsRead: [],
    attachmentsSkipped: [],
    approvedRead: [],
    approvedSkipped: [],
  }
  let threadMessages = 0
  let threadFound = false
  // Held for the attachment phase, which runs AFTER the print files so its
  // byte budget can be sized around what the prints already used.
  let hsToken: string | null = null
  let hsThreads: HsThreadWithAttachments[] | null = null

  // Persist + respond with a report (success or error alike) — an errored run
  // still stamps artwork_checked_at, deliberately (non-stranding gate).
  async function finish(report: ArtworkCheckReport): Promise<Response> {
    // Storing the report and releasing the claim are the same write, so a
    // waiting caller can never see one without the other.
    const persisted = await persistReportPatch({
      artwork_check: report,
      artwork_checked_at: report.checked_at,
      artwork_check_verdict: report.verdict,
      artwork_check_running_at: null,
    })
    await ledgerRun(report)
    return json({ ok: true, ...respBase, report, persisted })
  }

  try {
    // ── Leg A reference: the Help Scout thread, whole and raw ───────────────
    if (conversationId) {
      const appId = Deno.env.get('HELPSCOUT_APP_ID')?.trim()
      const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')?.trim()
      if (!appId || !appSecret) {
        baseCtx.threadGapNote = 'Help Scout credentials not configured'
      } else {
        try {
          const token = await getAccessToken(appId, appSecret)
          const threads = await fetchAllConversationThreads(token, conversationId)
          if (threads === null) {
            baseCtx.threadGapNote = 'the linked Help Scout conversation no longer exists'
          } else {
            hsToken = token
            hsThreads = threads
            const flat = threadToText(threads)
            baseCtx.threadText = flat.text
            threadMessages = flat.messageCount
            threadFound = flat.messageCount > 0
            if (!threadFound) baseCtx.threadGapNote = 'the linked conversation has no readable messages'
          }
        } catch (e) {
          // A Help Scout outage degrades the check (QR + roster legs still
          // run) rather than killing it — the report says the thread was
          // unreadable so the reviewer knows the primary leg is missing.
          baseCtx.threadGapNote = `Help Scout could not be read (${e instanceof HsError ? e.status : 'error'})`
        }
      }
    } else {
      baseCtx.threadGapNote = 'this proof has no linked Help Scout conversation'
    }

    // ── The cards being printed: Dropbox print files ────────────────────────
    if (!order.dropbox_folder_url) {
      return await finish(buildErrorReport(runModel,'no Dropbox order folder is linked', buildInputs(baseCtx, threadMessages, threadFound)))
    }
    const dbxToken = await getDropboxAccessToken(admin)
    if (!dbxToken) {
      return await finish(buildErrorReport(runModel,'Dropbox is not connected', buildInputs(baseCtx, threadMessages, threadFound)))
    }
    const entries = await listSharedLinkEntries(dbxToken, order.dropbox_folder_url)
    const picked = pickPrintFiles(entries)
    baseCtx.skippedFiles = [...picked.skipped]
    const documents: ContentBlock[] = []
    let printsRawTotal = 0
    const asDocument = (name: string, bytes: Uint8Array): ContentBlock => ({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: bytesToBase64(bytes) },
      title: name,
    })
    // Base64 costs a file its own size again, so on a cut-capable material —
    // the only one whose geometry we measure — the raw bytes are held back and
    // encoded AFTER the geometry leg, one at a time, instead of both copies of
    // every file staying alive across the whole run. A plastic job encodes as
    // it downloads exactly as before and pays nothing for any of this.
    const awaitingGeometry: { name: string; bytes: Uint8Array }[] = []
    for (const f of picked.files) {
      const bytes = await downloadSharedLinkFile(dbxToken, order.dropbox_folder_url, f.path)
      if (!bytes) {
        baseCtx.skippedFiles.push({ name: f.name, reason: 'download failed' })
        continue
      }
      if (!looksLikePdf(bytes)) {
        baseCtx.skippedFiles.push({ name: f.name, reason: 'not PDF-compatible (no %PDF header)' })
        continue
      }
      baseCtx.printFileNames.push(f.name)
      printsRawTotal += bytes.length
      if (baseCtx.cutThrough) awaitingGeometry.push({ name: f.name, bytes })
      else documents.push(asDocument(f.name, bytes))
    }

    // ── Will any cut-out piece fall out? ────────────────────────────────────
    // Measured from the vector geometry rather than judged from the page
    // images: a supporting strut is 0.4-1.2 mm, a few pixels at page scale.
    // Best-effort — any failure yields no faces and the check carries on
    // exactly as before. Time-bounded inside analyseOrderArtwork: this is the
    // one leg whose cost grows with the number of cards, and an overrun costs
    // the isolate (and so the whole check), not just this leg.
    let cutThroughFaces: CutThroughFace[] = []
    if (awaitingGeometry.length > 0) {
      try {
        // A cut-through hole is on both faces; collapse the duplicate so one
        // fault reads as one finding.
        cutThroughFaces = dedupeMirroredFaces(await analyseOrderArtwork(awaitingGeometry))
      } catch (err) {
        console.error('[artwork-check] cut-through check failed:', (err as Error)?.message)
      }
    }
    // Encode now the geometry is done with them, releasing each raw buffer as
    // its document block is built. Order is preserved: on a cut-capable
    // material every file came through here, on any other none did.
    while (awaitingGeometry.length > 0) {
      const held = awaitingGeometry.shift()!
      documents.push(asDocument(held.name, held.bytes))
    }
    if (documents.length === 0) {
      return await finish(buildErrorReport(runModel,'no readable print files (.pdf/.ai) in the Dropbox folder', buildInputs(baseCtx, threadMessages, threadFound)))
    }

    // ── Customer-thread attachments (Phase 2a) ──────────────────────────────
    // Best-effort throughout: any failure demotes that attachment to a listed
    // skip (an honest reference gap), never an error. Staff attachments are
    // excluded inside pickAttachments — reading our own proof exports back
    // would verify the card against itself.
    const routedAttachments: RoutedAttachment[] = []
    let attachmentsRawTotal = 0
    if (conversationId && hsToken && hsThreads) {
      const { picks, skipped } = pickAttachments(hsThreads, printsRawTotal)
      baseCtx.attachmentsSkipped.push(...skipped)
      for (const meta of picks) {
        try {
          const bytes = await fetchAttachmentData(hsToken, conversationId, meta.id)
          if (!bytes) {
            baseCtx.attachmentsSkipped.push({ name: meta.filename, reason: 'download failed' })
            continue
          }
          const routed = await routeAttachment(meta, bytes)
          if (!routed) {
            baseCtx.attachmentsSkipped.push({ name: meta.filename, reason: 'contents not readable' })
            continue
          }
          // Same fit as the proof leg — see imageResize.ts. attachmentsRawTotal
          // keeps counting the ORIGINAL download so the shared 24MB pool (and
          // the approved-image budget derived from it) stays no looser than it
          // was before resizing existed.
          let toSend = routed
          if (routed.kind === 'image') {
            const fitted = await fitImageForModel(routed.bytes, routed.mediaType)
            if (!fitted.ok) {
              baseCtx.attachmentsSkipped.push({ name: meta.filename, reason: fitted.reason })
              continue
            }
            toSend = { ...routed, bytes: fitted.bytes }
          }
          routedAttachments.push(toSend)
          attachmentsRawTotal += bytes.length
          baseCtx.attachmentsRead.push({ name: meta.filename, at: attachmentDateLabel(meta.at) })
        } catch {
          baseCtx.attachmentsSkipped.push({ name: meta.filename, reason: 'download failed' })
        }
      }
    }
    const attachmentBlocks = routedToBlocks(routedAttachments)

    // ── Leg C: the approved proof images (post-approval drift) ──────────────
    // What the customer signed off, downloaded from storage and fed alongside
    // the print files so the model can compare agreement vs production.
    // Best-effort like everything else: a miss is a named skip, never an error.
    const approvedBlocks: ContentBlock[] = []
    // QR payloads decoded straight from the approved artwork (qrDecode.ts) —
    // deduped across every proof image, the source that verifies a code the
    // designer never registered on the proof. Best-effort: the decoder
    // returns [] on any failure, so this only ever adds verification.
    const artworkQrSeen = new Set<string>()
    {
      const { picks, skipped } = pickApprovedImages(approvedImageRows)
      baseCtx.approvedSkipped.push(...skipped)
      let approvedRawTotal = 0
      const budget = approvedImageBudget(printsRawTotal, attachmentsRawTotal)
      for (const pick of picks) {
        try {
          const { data: blob, error: dlErr } = await admin.storage.from('proof-images').download(pick.path)
          if (dlErr || !blob) {
            baseCtx.approvedSkipped.push({ name: pick.label, reason: 'download failed' })
            continue
          }
          const raw = new Uint8Array(await blob.arrayBuffer())
          // Scan for QRs before the size gate — a large proof still gets its
          // code read (the decoder downscales internally), and reads better at
          // full resolution.
          for (const qr of await decodeQrsFromImage(raw)) {
            if (!artworkQrSeen.has(qr.data)) {
              artworkQrSeen.add(qr.data)
              baseCtx.artworkDecodedQrs.push(qr.data)
            }
          }
          // Then fit for the model — see imageResize.ts.
          const fitted = await fitImageForModel(raw, pick.mediaType)
          if (!fitted.ok) {
            baseCtx.approvedSkipped.push({ name: pick.label, reason: fitted.reason })
            continue
          }
          const bytes = fitted.bytes
          if (bytes.length > APPROVED_IMAGE_MAX_BYTES) {
            baseCtx.approvedSkipped.push({ name: pick.label, reason: 'over the size limit' })
            continue
          }
          if (approvedRawTotal + bytes.length > budget) {
            baseCtx.approvedSkipped.push({ name: pick.label, reason: 'size budget reached' })
            continue
          }
          approvedRawTotal += bytes.length
          baseCtx.approvedRead.push(pick.label)
          approvedBlocks.push({ type: 'text', text: `Approved proof ${baseCtx.approvedRead.length}: ${pick.label} (customer-approved artwork):` })
          approvedBlocks.push({
            type: 'image',
            source: { type: 'base64', media_type: pick.mediaType, data: bytesToBase64(bytes) },
          })
        } catch {
          baseCtx.approvedSkipped.push({ name: pick.label, reason: 'download failed' })
        }
      }
    }

    // ── One multimodal call ─────────────────────────────────────────────────
    const cutThroughBlock = buildCutThroughContext(cutThroughFaces)
    const content: ContentBlock[] = [
      { type: 'text', text: buildContextText(baseCtx) },
      ...(cutThroughBlock ? [{ type: 'text', text: cutThroughBlock } as ContentBlock] : []),
      ...documents,
      ...(approvedBlocks.length > 0
        ? [{ type: 'text', text: 'APPROVED PROOF IMAGES (what the customer signed off — compare the print files against these for post-approval drift):' } as ContentBlock, ...approvedBlocks]
        : []),
      ...(attachmentBlocks.length > 0
        ? [{ type: 'text', text: 'CUSTOMER-SUPPLIED ATTACHMENTS (reference material, labelled per file):' } as ContentBlock, ...attachmentBlocks]
        : []),
      { type: 'text', text: FINAL_INSTRUCTION },
    ]
    const { result, usage } = await callArtworkCheck(SYSTEM_PROMPT, content, runModel)
    // The measured cut-through result is merged into the report AFTER the
    // model, so a loose piece reaches the verdict whether or not the model
    // chose to repeat it. deriveVerdict runs on the merged report.
    const merged = applyCutThroughFindings(result, cutThroughFaces)
    // …and recorded in "Checks run" whatever it found, so a pass is visible
    // rather than inferred from the absence of a flag. A cut-capable material
    // whose files all failed to parse says so instead of going quiet.
    const cutSummary = summariseCutThrough(cutThroughFaces) ?? (
      baseCtx.cutThrough && cutThroughInput.length > 0
        ? {
          key: 'cut_through',
          label: 'Loose pieces',
          outcome: 'not_run' as const,
          detail: 'The check couldn’t run on these print files, so nothing was measured for pieces that might fall out.',
        }
        : null
    )
    return await finish(buildReport(
      runModel,
      merged,
      buildInputs(baseCtx, threadMessages, threadFound),
      usage,
      new Date(),
      cutSummary ? [cutSummary] : [],
    ))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[artwork-check] run failed:', msg)
    return await finish(buildErrorReport(runModel, msg.slice(0, 500), buildInputs(baseCtx, threadMessages, threadFound)))
  }
})
