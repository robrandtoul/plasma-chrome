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
  attachmentDateLabel,
  pickAttachments,
  routeAttachment,
  routedToBlocks,
  type RoutedAttachment,
} from '../_shared/artworkCheck/attachments.ts'
import { threadToText } from '../_shared/artworkCheck/threadText.ts'
import {
  buildContextText,
  buildInputs,
  FINAL_INSTRUCTION,
  SYSTEM_PROMPT,
  type CheckContext,
  type QrContext,
} from '../_shared/artworkCheck/prompts.ts'
import { bytesToBase64, callArtworkCheck, modelId, type ContentBlock } from '../_shared/artworkCheck/anthropic.ts'
import { buildErrorReport, buildReport } from '../_shared/artworkCheck/report.ts'
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
async function requireCaller(req: Request): Promise<{ admin: SupabaseClient } | Response> {
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.toLowerCase().startsWith('bearer ')) return json({ ok: false, error: 'Unauthorized' }, 401)
  const jwt = authHeader.replace(/^[Bb]earer\s+/, '').trim()
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!url || !serviceKey) return json({ ok: false, error: 'missing supabase env' }, 500)
  const admin = createClient(url, serviceKey, { db: { schema: 'proofs' }, auth: { persistSession: false, autoRefreshToken: false } })
  if (timingSafeEqual(jwt, serviceKey) || bearerRole(jwt) === 'service_role') return { admin }
  const anon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY') ?? '')
  const { data: userData, error: userErr } = await anon.auth.getUser(jwt)
  if (userErr || !userData?.user) return json({ ok: false, error: 'Unauthorized' }, 401)
  const { data: profile } = await admin.from('profiles').select('role, deactivated_at').eq('id', userData.user.id).single()
  if (!profile || profile.deactivated_at) return json({ ok: false, error: 'Forbidden' }, 403)
  if (profile.role !== 'admin' && profile.role !== 'designer') return json({ ok: false, error: 'Forbidden' }, 403)
  return { admin }
}

// settings.artwork_check_mode / _required, tolerant of the columns not
// existing yet (deployable before migration 000336 — same idiom as
// place-order's loadHandoffMode). The required gate only means anything in
// live mode: a shadow/off check isn't a precondition a reviewer can see.
async function loadCheckSettings(admin: SupabaseClient): Promise<{ mode: 'off' | 'shadow' | 'live'; required: boolean }> {
  try {
    const { data } = await admin.from('settings').select('artwork_check_mode, artwork_check_required').limit(1).maybeSingle()
    const raw = (data as { artwork_check_mode?: string | null; artwork_check_required?: boolean | null } | null)
    const mode = raw?.artwork_check_mode === 'shadow' ? 'shadow' : raw?.artwork_check_mode === 'live' ? 'live' : 'off'
    return { mode, required: mode === 'live' && raw?.artwork_check_required === true }
  } catch {
    return { mode: 'off', required: false }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)

  const check = await requireCaller(req)
  if (check instanceof Response) return check
  const { admin } = check

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400)
  }
  const orderId = String(body.order_id ?? '').trim()
  const force = body.force === true
  if (!orderId) return json({ ok: false, error: 'order_id is required' }, 400)

  const { mode, required } = await loadCheckSettings(admin)
  if (mode === 'off') return json({ ok: true, mode, required })

  // The order (incl. the cached report — this select names the 000336 columns,
  // so the function needs the migration applied; pre-migration it errors here,
  // which the page treats as "check unavailable" and renders nothing).
  const { data: order, error: orderErr } = await admin
    .from('orders')
    .select('id, proof_id, dropbox_folder_url, material_id, stock_order_number, project_name, person_quantities, artwork_check, artwork_checked_at')
    .eq('id', orderId)
    .maybeSingle()
  if (orderErr) return json({ ok: false, error: `Order lookup failed: ${orderErr.message}` }, 500)
  if (!order) return json({ ok: false, error: 'Order not found.' }, 404)

  if (order.artwork_check && !force) {
    return json({ ok: true, mode, required, cached: true, report: order.artwork_check as ArtworkCheckReport })
  }

  // ── Gather the order context (names, QRs, account fields) ─────────────────
  const { data: proof } = await admin
    .from('proofs')
    .select('id, helpscout_conversation_id, contacts:contact_id ( full_name, email, companies:company_id ( name ) )')
    .eq('id', order.proof_id)
    .maybeSingle()
  const conversationId = (proof as { helpscout_conversation_id: string | null } | null)?.helpscout_conversation_id ?? null
  const contact = (proof as { contacts?: { full_name?: string | null; email?: string | null; companies?: { name?: string | null } | null } | null } | null)?.contacts ?? null

  // The version this ORDER was placed against — the version whose material
  // matches the order's, not blindly the current one (place-order's rule; a
  // proof can carry orders in two materials).
  type VersionRow = {
    id: string
    version_number: number
    is_current: boolean
    material_id: string | null
    material_display: string | null
    names: string[] | null
    materials: { code: string; display_name: string | null } | null
  }
  const { data: versionRows } = await admin
    .from('proof_versions')
    .select('id, version_number, is_current, material_id, material_display, names, materials(code, display_name)')
    .eq('proof_id', order.proof_id)
    .order('version_number', { ascending: false })
  const allVersions = (versionRows ?? []) as VersionRow[]
  const orderMaterialId = (order as { material_id: string | null }).material_id ?? null
  const materialMatches = orderMaterialId ? allVersions.filter((v) => v.material_id === orderMaterialId) : []
  const pv = materialMatches.find((v) => v.is_current) ?? materialMatches[0] ?? allVersions.find((v) => v.is_current) ?? null
  if (!pv) return json({ ok: false, error: 'No proof version found.' }, 404)

  const recipients = (Array.isArray(pv.names) ? pv.names : []).map((n) => String(n).trim()).filter(Boolean)
  const rawSplit = Array.isArray(order.person_quantities) ? order.person_quantities : []
  const quantitySplit = rawSplit
    .filter((p: { name?: unknown; quantity?: unknown }) => p && typeof p.name === 'string' && p.name.trim() && Number(p.quantity) > 0)
    .map((p: { name: string; quantity: unknown }) => `${p.name.trim()} — ${Number(p.quantity)}`)

  // QR rows for the version (payloads are exact decoded text, 000168; hosted
  // vCards additionally carry the approved-contact snapshot, 000194).
  const { data: qrRows } = await admin
    .from('proof_version_images')
    .select('qr_decoded_data, qr_kind, qr_vcard_slug, associated_name, side')
    .eq('proof_version_id', pv.id)
    .eq('is_qr_code', true)
  type QrRow = { qr_decoded_data: string | null; qr_kind: string | null; qr_vcard_slug: string | null; associated_name: string | null; side: string | null }
  const qrRowsTyped = ((qrRows ?? []) as QrRow[]).filter((q) => q.qr_decoded_data)
  const qrs: QrContext[] = qrRowsTyped.map((q) => ({
    kind: q.qr_kind ?? 'unknown',
    decoded: q.qr_decoded_data as string,
    associatedName: q.associated_name,
    side: q.side,
  }))
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

  const orderLabel = `Order ${order.stock_order_number ?? ''} — ${order.project_name ?? contact?.companies?.name ?? contact?.full_name ?? 'customer'}`.trim()

  // Inputs accumulate as gathering proceeds so an error report still records
  // what HAD been fetched when the run died.
  const baseCtx: CheckContext = {
    orderLabel,
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
    threadText: '',
    threadGapNote: null,
    printFileNames: [],
    skippedFiles: [],
    attachmentsRead: [],
    attachmentsSkipped: [],
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
    const { error: updErr } = await admin
      .from('orders')
      .update({
        artwork_check: report,
        artwork_checked_at: report.checked_at,
        artwork_check_verdict: report.verdict,
      })
      .eq('id', orderId)
    if (updErr) console.error('[artwork-check] persist failed:', updErr.message)
    return json({ ok: true, mode, required, report, persisted: !updErr })
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
      return await finish(buildErrorReport(modelId(), 'no Dropbox order folder is linked', buildInputs(baseCtx, threadMessages, threadFound)))
    }
    const dbxToken = await getDropboxAccessToken(admin)
    if (!dbxToken) {
      return await finish(buildErrorReport(modelId(), 'Dropbox is not connected', buildInputs(baseCtx, threadMessages, threadFound)))
    }
    const entries = await listSharedLinkEntries(dbxToken, order.dropbox_folder_url)
    const picked = pickPrintFiles(entries)
    baseCtx.skippedFiles = [...picked.skipped]
    const documents: ContentBlock[] = []
    let printsRawTotal = 0
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
      documents.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: bytesToBase64(bytes) },
        title: f.name,
      })
    }
    if (documents.length === 0) {
      return await finish(buildErrorReport(modelId(), 'no readable print files (.pdf/.ai) in the Dropbox folder', buildInputs(baseCtx, threadMessages, threadFound)))
    }

    // ── Customer-thread attachments (Phase 2a) ──────────────────────────────
    // Best-effort throughout: any failure demotes that attachment to a listed
    // skip (an honest reference gap), never an error. Staff attachments are
    // excluded inside pickAttachments — reading our own proof exports back
    // would verify the card against itself.
    const routedAttachments: RoutedAttachment[] = []
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
          routedAttachments.push(routed)
          baseCtx.attachmentsRead.push({ name: meta.filename, at: attachmentDateLabel(meta.at) })
        } catch {
          baseCtx.attachmentsSkipped.push({ name: meta.filename, reason: 'download failed' })
        }
      }
    }
    const attachmentBlocks = routedToBlocks(routedAttachments)

    // ── One multimodal call ─────────────────────────────────────────────────
    const content: ContentBlock[] = [
      { type: 'text', text: buildContextText(baseCtx) },
      ...documents,
      ...(attachmentBlocks.length > 0
        ? [{ type: 'text', text: 'CUSTOMER-SUPPLIED ATTACHMENTS (reference material, labelled per file):' } as ContentBlock, ...attachmentBlocks]
        : []),
      { type: 'text', text: FINAL_INSTRUCTION },
    ]
    const { result, usage } = await callArtworkCheck(SYSTEM_PROMPT, content)
    return await finish(buildReport(modelId(), result, buildInputs(baseCtx, threadMessages, threadFound), usage))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[artwork-check] run failed:', msg)
    return await finish(buildErrorReport(modelId(), msg.slice(0, 500), buildInputs(baseCtx, threadMessages, threadFound)))
  }
})
