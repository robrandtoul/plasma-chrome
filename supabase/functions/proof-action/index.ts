// proof-action: customer-facing edge function for the Phase 2.5 per-
// recipient Approve / Request changes flow.
//
// Each request targets a (proof_version, recipient name) pair. The
// recipient is either a value from proof_versions.names or the
// SHARED_APPROVAL_KEY sentinel '__shared__' (matching the convention
// from src/lib/types.ts:176 and proof_name_approvals semantics from
// migration 000076).
//
// On a successful request the function writes to TWO tables:
//   * proof_events  — append-only audit log with name, IP, UA,
//                     pricing snapshot at action time, comment,
//                     helpscout_thread_id (best-effort).
//   * proof_name_approvals — upsert of current state (one row per
//                            (version, name) pair). Mirrors the
//                            shape the designer-side upsert from
//                            VersionDetailModal writes, so the
//                            existing carry-forward + render paths
//                            in NewVersionPage / ProofDetailPage
//                            inherit customer-recorded state for
//                            free.
//
// Anon-callable (the customer page is unauthenticated). Defence in depth:
//   * approvals_enabled re-checked at request time, not from any client-
//     side cache — the UI kill switch can be bypassed but this can't.
//   * Submitted recipient name is validated against the version's
//     pv.names ∪ {SHARED_APPROVAL_KEY} at action time — random strings
//     can't be smuggled into proof_name_approvals.
//   * Both writes go via service role; the tables' RLS has no anon
//     INSERT policy by design.
//   * Every action captures from_ip / from_ua / pricing_snapshot_at_action
//     so we have forensics if a stray request lands.
//
// Required Supabase secrets (re-uses existing where possible):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — service-role client.
//   HELPSCOUT_APP_ID, HELPSCOUT_APP_SECRET   — OAuth client credentials
//                                              (already configured per
//                                              project brief, used by
//                                              send-helpscout-reply).
//   PROOF_VIEWER_BASE_URL                    — e.g. https://proofs
//                                              .plasmadesign.co.uk
//                                              (the legacy
//                                              proof-viewer.netlify.app
//                                              host is also accepted).
//                                              Used as the fallback
//                                              when the request's
//                                              Origin header isn't in
//                                              the allowlist (see
//                                              ALLOWED_BASE_URL_
//                                              ORIGINS below). Empty
//                                              string is the final
//                                              fallback — customer
//                                              thread omits the proof
//                                              URL line rather than
//                                              posting a broken
//                                              /p/{id} link.
//
// Endpoint shape and discriminated response codes are documented in the
// Phase 2 prompt 6 spec. This file is the canonical reference; treat the
// status / reason union as the public contract.

import { createClient } from 'jsr:@supabase/supabase-js@2'

// Allowlist of origins that this edge function trusts to build
// customer-facing /p/{proof_id} links for the Help Scout thread post.
// Anything outside this list falls through to PROOF_VIEWER_BASE_URL.
//
// Why allowlist (vs trusting Origin outright):
//   The edge function endpoint accepts any caller, not just browsers.
//   A direct curl with a forged Origin header would otherwise let an
//   attacker post a phishing URL into the HS thread (visible to both
//   designer and customer). The allowlist closes that vector at the
//   cost of a tiny static list.
//
// Members:
//   - production custom domain (proofs.plasmadesign.co.uk)
//   - legacy Netlify domain (proof-viewer.netlify.app) — kept as a
//     transitional safety net while any in-flight links / bookmarks
//     are still resolving via the old host
//   - Vite dev default port (5173)
//   - Vite preview default port (4173)
//
// If branch-deploy / Netlify preview origins ever land
// (e.g. https://deploy-preview-N--proof-viewer.netlify.app), extend
// this list — likely as a regex entry — at that point.
const ALLOWED_BASE_URL_ORIGINS = [
  'https://proofs.plasmadesign.co.uk',
  'https://proof-viewer.netlify.app',
  'http://localhost:5173',
  'http://localhost:4173',
] as const

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const MAX_COMMENT_BYTES = 10 * 1024
const MAX_ACTOR_NAME_BYTES = 200

type EventType = 'approve' | 'request_changes'

type FailedReason =
  | 'validation'
  | 'approvals_disabled'
  | 'db_write_failed'
  | 'unknown'

type PartialReason =
  | 'helpscout_post_failed'
  | 'proof_name_approvals_sync_failed'

type Response_ =
  | { status: 'ok'; event_id: string }
  | { status: 'partial'; event_id: string; reason: PartialReason }
  | { status: 'failed'; reason: FailedReason; detail?: string }

// Sentinel used as proof_name_approvals.name for the shared section
// of multi-recipient proofs and as the sole valid name for all-shared
// (membership / single-design) proofs. Mirrors src/lib/types.ts:176.
// Duplicated here because edge functions are their own Deno modules
// with no import path back into src/.
const SHARED_APPROVAL_KEY = '__shared__'

function json(body: Response_ | { error: string }, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function failed(reason: FailedReason, status: number, detail?: string) {
  return json({ status: 'failed', reason, detail }, status)
}

// ── Help Scout client ─────────────────────────────────────────────────────────
//
// Mirrors the auth + customer-id lookup pattern in send-helpscout-reply
// (the existing reply endpoint). Differences:
//   * POSTs to /v2/conversations/{id}/customer (not /reply) — creates a
//     thread attributed to the customer, not the staff agent.
//   * No `user` field in the body (customer threads aren't staff-attributed).
//   * No status flip — the proof's status is managed in app code; the HS
//     conversation status is left to the designer to manage from HS itself.

class HsError extends Error {
  constructor(public hsStatus: number, message: string) {
    super(message)
    this.name = 'HsError'
  }
}

async function hsAccessToken(appId: string, appSecret: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: appId,
    client_secret: appSecret,
  })
  const resp = await fetch('https://api.helpscout.net/v2/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '<body read failed>')
    throw new HsError(resp.status, `HS token (${resp.status}): ${text}`)
  }
  const data = await resp.json()
  if (!data?.access_token) throw new HsError(500, 'HS token response missing access_token')
  return data.access_token as string
}

async function hsPrimaryCustomerId(token: string, conversationId: string): Promise<number> {
  const resp = await fetch(
    `https://api.helpscout.net/v2/conversations/${conversationId}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
  )
  if (resp.status === 404) throw new HsError(404, 'HS conversation not found')
  if (!resp.ok) {
    const text = await resp.text().catch(() => '<body read failed>')
    throw new HsError(resp.status, `HS conversation fetch (${resp.status}): ${text}`)
  }
  const data = await resp.json().catch(() => null)
  const id = (data as { primaryCustomer?: { id?: number } } | null)?.primaryCustomer?.id
  if (!id || typeof id !== 'number') {
    throw new HsError(502, 'HS conversation has no primary customer')
  }
  return id
}

// Returns the new thread id parsed from the Resource-Id header, or 0
// if HS responded successfully but the header was missing.
//
// Header contract for the customer endpoint differs from /reply: the
// reply endpoint returns Location with the thread URL and an empty
// Resource-Id; the customer endpoint returns the thread id directly
// in Resource-Id with an empty Location. Verified empirically against
// the live HS API on 2026-04-27 — Access-Control-Expose-Headers came
// back as "Location, Resource-Id" with content-length 0.
async function hsPostCustomerThread(
  token: string,
  conversationId: string,
  customerId: number,
  text: string,
): Promise<number> {
  const resp = await fetch(
    `https://api.helpscout.net/v2/conversations/${conversationId}/customer`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        customer: { id: customerId },
        text,
      }),
    },
  )
  if (resp.status === 404) throw new HsError(404, 'HS conversation not found')
  if (!resp.ok) {
    const upstream = await resp.text().catch(() => '<body read failed>')
    throw new HsError(resp.status, `HS customer thread (${resp.status}): ${upstream}`)
  }
  const resourceId = resp.headers.get('Resource-Id') ?? ''
  const parsed = Number(resourceId)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

// ── Customer thread copy ──────────────────────────────────────────────────────
//
// Phrasing per the Phase 2 prompt. Plain text — Help Scout renders
// linebreaks but no markdown for customer-side threads.

function buildCustomerThreadText(
  eventType: EventType,
  actorName: string,
  recipientName: string,
  comment: string | null,
  fileNames: string[],
  proofUrl: string | null,
  // material_options dimension surface for the active option, looked
  // up from the DB at the call site. Both null when the version has
  // no option dimension OR the material_options row was not found
  // (defensive — the in-function trigger validates membership before
  // we get here, so this should be unreachable in practice).
  optionDisplayLabel: string | null,
  optionDimensionLabel: string | null,
  // Variant-round display name (migrations 000138 + 000139). Non-null
  // routes the function to the variant-round branch below; null falls
  // through to the standard approve / request_changes branches with
  // byte-identical output to the pre-variant-rounds shape.
  variantDisplayName: string | null,
): string {
  // SHARED_APPROVAL_KEY suppresses the "for {name}" suffix — the
  // shared section IS the whole proof (all-shared / membership /
  // single-design case). Named recipients get the suffix.
  const recipientSuffix =
    recipientName === SHARED_APPROVAL_KEY ? '' : ` for ${recipientName}`
  // Option suffix reads e.g. " for the Brushed finish" / " for the
  // Black Walnut species" / " for the Optional CNC cutting"
  // (dedup case — the display_name already ends with the dimension
  // noun, so we drop the redundant trailing word). Suppressed when
  // either piece is missing so we never emit "for the  finish" /
  // "for the Brushed".
  //
  // Dedup rule: if the display_name's trailing whitespace-delimited
  // word equals the dimension label (case-insensitive, whole-word),
  // drop the suffix and emit display_name only. Otherwise keep both.
  // This handles the carbon-fibre "Optional CNC cutting" / "Cutting"
  // pair without special-casing — same logic would dedup any future
  // material whose option codes carry the dimension noun in their
  // display name.
  const optionSuffix = (() => {
    if (!optionDisplayLabel || !optionDimensionLabel) return ''
    const tail = optionDisplayLabel.trim().split(/\s+/).pop() ?? ''
    const tailMatchesDimension =
      tail.toLowerCase() === optionDimensionLabel.toLowerCase()
    return tailMatchesDimension
      ? ` for the ${optionDisplayLabel}`
      : ` for the ${optionDisplayLabel} ${optionDimensionLabel.toLowerCase()}`
  })()
  const fileLine = fileNames.length > 0 ? fileNames.join(', ') : '(no files)'
  const urlLine = proofUrl ? `View the proof: ${proofUrl}\n` : ''

  // ── Variant-round branch ──────────────────────────────────────────────
  // Routes ahead of the standard approve / request_changes branches so
  // those return byte-identical output to the pre-variant-rounds shape
  // when variantDisplayName is null. Variant rounds always travel as
  // request_changes server-side (the edge function rejects 'approve'),
  // so eventType here is always request_changes for this branch — but
  // we don't read it: the copy template is selection-shaped, not
  // approval-shaped. The recipient suffix is suppressed (variant
  // rounds always use SHARED_APPROVAL_KEY) and the file list block
  // is dropped — the proof URL is the visual reference. Comment is
  // required server-side for variant rounds, so the quoted block is
  // always populated.
  if (variantDisplayName != null) {
    return (
      `${actorName} chose: ${variantDisplayName}.\n\n` +
      `"${comment ?? ''}"\n\n` +
      urlLine +
      `— Posted via the proof viewer`
    )
  }

  if (eventType === 'approve') {
    const commentBlock = comment ? `"${comment}"\n\n` : ''
    return (
      `Approved by ${actorName}${recipientSuffix}${optionSuffix}.\n\n` +
      commentBlock +
      `Approved version: ${fileLine}\n` +
      urlLine +
      `— Posted via the proof viewer`
    )
  }

  // request_changes — comment is required and always present.
  return (
    `Changes requested by ${actorName}${recipientSuffix}${optionSuffix}.\n\n` +
    `"${comment ?? ''}"\n\n` +
    `Version: ${fileLine}\n` +
    urlLine +
    `— Posted via the proof viewer`
  )
}

// ── Pricing snapshot at action time ───────────────────────────────────────────
//
// Same shape and source as CustomerProofPage's livePricingSnapshot:
//   variants[]  scoped by displayed_variant_ids if not null, else all
//               active variants of the version's material
//   prices keyed by quantity-as-string in the version's currency.
// Variants with zero priced rows in the active currency are dropped to
// match what the customer was actually looking at on screen.

interface PricingVariantSnapshot {
  variant_id: string
  display: string
  prices: Record<string, number>
}

async function buildPricingSnapshot(
  admin: ReturnType<typeof createClient>,
  materialId: string,
  currency: string,
  displayedVariantIds: string[] | null,
): Promise<{ variants: PricingVariantSnapshot[] }> {
  // Variants for the material. Filter to displayedVariantIds if set;
  // otherwise show every active variant (the post-Phase-2 default).
  const variantsQuery = admin
    .from('public_material_variants')
    .select('id, display_name, variant_type')
    .eq('material_id', materialId)
    .order('sort_order')
  const { data: variantData } = displayedVariantIds && displayedVariantIds.length > 0
    ? await variantsQuery.in('id', displayedVariantIds)
    : await variantsQuery
  const variants = (variantData ?? []) as Array<{
    id: string
    display_name: string
    variant_type: string
  }>
  if (variants.length === 0) return { variants: [] }

  const ids = variants.map((v) => v.id)
  const { data: tierData } = await admin
    .from('public_price_tiers')
    .select('material_variant_id, quantity, total_price')
    .in('material_variant_id', ids)
    .eq('currency', currency)
  const tiers = (tierData ?? []) as Array<{
    material_variant_id: string
    quantity: number
    total_price: number
  }>

  return {
    variants: variants
      .map((v) => {
        const prices: Record<string, number> = {}
        for (const t of tiers) {
          if (t.material_variant_id === v.id) {
            prices[String(t.quantity)] = t.total_price
          }
        }
        return {
          variant_id: v.id,
          display: v.variant_type === 'default' ? 'Default' : v.display_name,
          prices,
        }
      })
      .filter((v) => Object.keys(v.prices).length > 0),
  }
}

// ── IP capture ────────────────────────────────────────────────────────────────
//
// Edge functions sit behind Supabase's edge layer; the client's real IP
// is in X-Forwarded-For (first entry) or cf-connecting-ip. We trim and
// validate enough to write to inet without crashing on garbage input —
// the column accepts NULL on parse failure rather than rejecting the
// whole insert.

function parseClientIp(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first && first.length < 64) return first
  }
  const cf = req.headers.get('cf-connecting-ip')
  if (cf && cf.length < 64) return cf.trim()
  return null
}

// ── UUID validation ───────────────────────────────────────────────────────────
//
// Supabase's PostgREST will return a clear error on a malformed uuid,
// but rejecting at the edge is cheaper and lets us return a 400 with a
// useful reason code instead of leaking a Postgres error string.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── Handler ───────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return failed('validation', 400, 'POST only')

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!supabaseUrl || !serviceKey) {
    console.error('[proof-action] missing supabase env')
    return failed('unknown', 500, 'server misconfigured')
  }
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // ── Body parse + shape validation ─────────────────────────────────────────
  let proofVersionId: string
  let eventType: EventType
  let actorName: string
  let recipientName: string
  let comment: string | null
  // material_option_code is the active option-tab code at the moment
  // the customer clicked Confirm (per migration 000124). Null when
  // the version has no option dimension. Membership in the parent's
  // material_options array is validated below — same rule the BEFORE
  // INSERT trigger enforces, surfaced here as a 400 so the client
  // gets a clean reason instead of a 23514 from the trigger.
  let materialOptionCode: string | null
  // round_variant_id is the variant the customer chose at action time
  // on a variant-round version (migration 000138). Null on standard-
  // version requests. Membership in proof_round_variants for this
  // version is validated below — symmetric with the option-code
  // membership check, except this one is required when the parent
  // version is_variant_round = true.
  let roundVariantId: string | null
  try {
    const parsed = await req.json()
    proofVersionId = typeof parsed?.proof_version_id === 'string' ? parsed.proof_version_id.trim() : ''
    eventType = parsed?.event_type
    actorName = typeof parsed?.actor_name === 'string' ? parsed.actor_name.trim() : ''
    recipientName = typeof parsed?.name === 'string' ? parsed.name.trim() : ''
    comment = typeof parsed?.comment === 'string' ? parsed.comment.trim() : null
    if (comment === '') comment = null
    // Accept null / undefined / missing as null. A non-string value
    // (e.g. number, object) is treated as null too — frontend always
    // sends string-or-null, but we don't trust the wire shape.
    const rawCode = parsed?.material_option_code
    materialOptionCode = typeof rawCode === 'string' && rawCode.trim() !== ''
      ? rawCode.trim()
      : null
    const rawVariantId = parsed?.round_variant_id
    roundVariantId = typeof rawVariantId === 'string' && rawVariantId.trim() !== ''
      ? rawVariantId.trim()
      : null
  } catch {
    return failed('validation', 400, 'invalid JSON body')
  }

  if (!UUID_RE.test(proofVersionId)) {
    return failed('validation', 400, 'proof_version_id must be a UUID')
  }
  if (eventType !== 'approve' && eventType !== 'request_changes') {
    return failed('validation', 400, 'event_type must be approve or request_changes')
  }
  if (!actorName) return failed('validation', 400, 'actor_name is required')
  if (new TextEncoder().encode(actorName).byteLength > MAX_ACTOR_NAME_BYTES) {
    return failed('validation', 400, 'actor_name too long')
  }
  if (!recipientName) return failed('validation', 400, 'name is required')
  if (new TextEncoder().encode(recipientName).byteLength > MAX_ACTOR_NAME_BYTES) {
    return failed('validation', 400, 'name too long')
  }
  if (eventType === 'request_changes' && !comment) {
    return failed('validation', 400, 'comment is required for request_changes')
  }
  if (comment && new TextEncoder().encode(comment).byteLength > MAX_COMMENT_BYTES) {
    return failed('validation', 400, 'comment too long')
  }

  // ── approvals_enabled re-check (defence in depth) ─────────────────────────
  const { data: settingsRow, error: settingsErr } = await admin
    .from('settings')
    .select('approvals_enabled')
    .eq('id', 1)
    .single()
  if (settingsErr) {
    console.error('[proof-action] settings lookup failed', settingsErr)
    return failed('unknown', 500, settingsErr.message)
  }
  if (!settingsRow?.approvals_enabled) {
    return failed('approvals_disabled', 400)
  }

  // ── Look up the version + parent proof + image filenames ─────────────────
  // Also pulls pv.names (recipient roster — drives the allowed-names
  // validation below) and pvi.associated_name (drives the recipient-
  // scoped file list for the HS thread).
  const { data: versionRow, error: versionErr } = await admin
    .from('proof_versions')
    .select(
      'id, proof_id, material_id, currency, displayed_variant_ids, names, material_options, is_variant_round, ' +
      'proofs:proof_id ( helpscout_conversation_id ), ' +
      'proof_version_images ( original_filename, sort_order, associated_name )',
    )
    .eq('id', proofVersionId)
    .maybeSingle()
  if (versionErr) {
    console.error('[proof-action] version lookup failed', versionErr)
    return failed('unknown', 500, versionErr.message)
  }
  if (!versionRow) {
    return failed('validation', 400, 'proof_version_id not found')
  }

  const v = versionRow as unknown as {
    id: string
    proof_id: string
    material_id: string
    currency: string
    displayed_variant_ids: string[] | null
    names: string[] | null
    material_options: string[] | null
    is_variant_round: boolean
    proofs: { helpscout_conversation_id: string | null } | null
    proof_version_images: Array<{
      original_filename: string | null
      sort_order: number
      associated_name: string | null
    }>
  }

  // ── Validate recipient name against the version's allowed set ────────────
  // Allowed = pv.names ∪ {SHARED_APPROVAL_KEY}. For all-shared
  // proofs (membership / single-design with no recipient roster),
  // pv.names is empty so the only valid name is the sentinel.
  const recipientRoster = Array.isArray(v.names) ? v.names : []
  const allowedNames = new Set<string>([SHARED_APPROVAL_KEY, ...recipientRoster])
  if (!allowedNames.has(recipientName)) {
    return failed('validation', 400, 'unknown recipient name')
  }

  // ── Validate variant-round constraints (migrations 000138 + 000139) ──────
  //
  // When the parent version is a variant round (is_variant_round = true),
  // four extra rules apply on top of the standard validation:
  //
  //   * approve is not available — variant rounds are a "pick a
  //     direction" moment, not an approval moment. Customer-side UI
  //     hides the Approve button; this is the server-side enforcement.
  //   * recipient name must be SHARED_APPROVAL_KEY — variant rounds
  //     have no recipient roster (validate_variant_round_proof_version
  //     trigger from 000138 enforces this at the DB level).
  //   * round_variant_id is required — the customer's chosen direction.
  //   * round_variant_id must reference an existing variant on this
  //     version — same membership shape as the option-code check below,
  //     but required-when-variant-round rather than optional.
  //
  // When the parent version is NOT a variant round, round_variant_id
  // must be absent — symmetric defence so a request can't smuggle a
  // variant id onto a standard version's event row.
  //
  // variantDisplayName is captured here so the Help Scout thread copy
  // ("Alec chose: Charcoal") can read the human-readable label without
  // a second lookup. Null on the standard path.
  let variantDisplayName: string | null = null
  if (v.is_variant_round) {
    if (eventType === 'approve') {
      return failed('validation', 400, 'approve is not available on variant rounds')
    }
    if (recipientName !== SHARED_APPROVAL_KEY) {
      return failed('validation', 400, 'variant rounds must use the shared recipient (__shared__)')
    }
    if (!roundVariantId) {
      return failed('validation', 400, 'round_variant_id is required on variant rounds')
    }
    if (!UUID_RE.test(roundVariantId)) {
      return failed('validation', 400, 'round_variant_id must be a UUID')
    }
    const { data: rvRow, error: rvErr } = await admin
      .from('proof_round_variants')
      .select('id, display_name')
      .eq('id', roundVariantId)
      .eq('proof_version_id', proofVersionId)
      .maybeSingle()
    if (rvErr) {
      console.error('[proof-action] variant lookup failed', rvErr)
      return failed('unknown', 500, rvErr.message)
    }
    if (!rvRow) {
      return failed('validation', 400, 'unknown round_variant_id for this version')
    }
    variantDisplayName = (rvRow as { display_name: string }).display_name
  } else if (roundVariantId !== null) {
    return failed('validation', 400, 'round_variant_id only valid on variant rounds')
  }

  // ── Validate material_option_code membership ─────────────────────────────
  // Same rule the BEFORE INSERT trigger enforces (per migration 000124),
  // surfaced here as a clean 400 so the client gets a structured
  // 'validation' reason instead of a 23514 errcode wrapped in a 500.
  // Null is always accepted: versions with no option dimension send
  // null, and the frontend doesn't need to know the parent's option
  // shape to make a request.
  const versionOptions = Array.isArray(v.material_options) ? v.material_options : []
  if (materialOptionCode !== null && !versionOptions.includes(materialOptionCode)) {
    return failed(
      'validation',
      400,
      `material_option_code "${materialOptionCode}" is not a member of this version's material_options`,
    )
  }

  const conversationId = v.proofs?.helpscout_conversation_id ?? null
  // Recipient-scoped file list for the HS thread. SHARED_APPROVAL_KEY
  // sees only the shared images (associated_name IS NULL); a named
  // recipient sees their own images plus any shared images (which
  // virtual-pair into their card per the customer-page render
  // logic).
  const fileNames = (v.proof_version_images ?? [])
    .filter((img) => {
      if (recipientName === SHARED_APPROVAL_KEY) return img.associated_name == null
      return img.associated_name === recipientName || img.associated_name == null
    })
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((img) => img.original_filename)
    .filter((n): n is string => !!n && n.trim() !== '')

  // ── Pricing snapshot at action time ──────────────────────────────────────
  let pricingSnapshotAtAction: { variants: PricingVariantSnapshot[] } = { variants: [] }
  try {
    pricingSnapshotAtAction = await buildPricingSnapshot(
      admin,
      v.material_id,
      v.currency,
      v.displayed_variant_ids,
    )
  } catch (snapErr) {
    // Don't fail the whole action — log and proceed with an empty
    // snapshot. The customer's intent (approve / request_changes) is
    // captured regardless; a missing audit grid is recoverable, a
    // missing event is not.
    console.error('[proof-action] pricing snapshot build failed', snapErr)
  }

  // ── Insert proof_events row (without helpscout_thread_id) ────────────────
  const fromIp = parseClientIp(req)
  const fromUa = req.headers.get('user-agent') ?? null

  const eventInsert = {
    proof_version_id: proofVersionId,
    event_type: eventType,
    actor_name: actorName,
    name: recipientName,
    comment,
    from_ip: fromIp,
    from_ua: fromUa,
    pricing_snapshot_at_action: pricingSnapshotAtAction,
    // Migration 000124. Trigger-validated above; sending null when
    // the version has no option dimension is the documented
    // "unknown / not applicable" semantic.
    material_option_code: materialOptionCode,
    // Migration 000138/000139. Customer's chosen variant on a
    // variant-round version; null on every standard-version event.
    // Validated above against proof_round_variants membership for
    // this version. The FK on proof_events.round_variant_id catches
    // any client that bypasses edge-function validation.
    round_variant_id: roundVariantId,
  }
  const { data: eventRow, error: insertErr } = await admin
    .from('proof_events')
    .insert(eventInsert)
    .select('id')
    .single()
  if (insertErr || !eventRow) {
    console.error('[proof-action] event insert failed', insertErr)
    return failed('db_write_failed', 500, insertErr?.message)
  }
  const eventId = (eventRow as { id: string }).id

  // ── Mirror state into proof_name_approvals (dual-write) ─────────────────
  // Upsert keyed on (proof_version_id, name). Mirrors the column
  // shape VersionDetailModal's upsertApproval writes — the designer
  // surfaces (NewVersionPage carry-forward, ProofDetailPage roll-up,
  // public_proof_versions.approvals jsonb) read this table directly,
  // so a customer-recorded action lands as a state-equal designer
  // record without changing any of those read paths.
  //
  // change_request mirrors the customer's comment when state =
  // 'changes_requested'; cleared to null on approve so a stale
  // request note doesn't survive a later approval. carried_from_
  // version_id stays null — only the v(N) creation block in
  // NewVersionPage populates that, and a fresh customer action is
  // by definition not a carry. actor_ip / actor_ua DO get populated
  // here (designer-side leaves them null for keyboard-driven
  // edits; customer telemetry is more useful for audit).
  //
  // If this fails after the proof_events row is already in, we
  // return 'partial' / 'proof_name_approvals_sync_failed' and skip
  // the HS post — the customer's email-the-team fallback then
  // covers the notification gap, and the designer dashboard's
  // out-of-sync state surfaces visibly via the missing approval
  // pill on a row that has a proof_events entry.
  const approvalState = eventType === 'approve' ? 'approved' : 'changes_requested'
  const nowIso = new Date().toISOString()
  const { error: approvalErr } = await admin
    .from('proof_name_approvals')
    .upsert(
      {
        proof_version_id: proofVersionId,
        name: recipientName,
        state: approvalState,
        change_request: approvalState === 'approved' ? null : comment,
        actor_name: actorName,
        actor_ip: fromIp,
        actor_ua: fromUa,
        updated_at: nowIso,
        // Mirrors proof_events.material_option_code per migration
        // 000124. Best-effort consistency: if the proof_events insert
        // landed but this upsert fails, the partial-status response
        // already covers the divergence — same model as every other
        // mirrored field on this row.
        material_option_code: materialOptionCode,
      },
      { onConflict: 'proof_version_id,name' },
    )
  if (approvalErr) {
    console.error('[proof-action] proof_name_approvals upsert failed', approvalErr)
    return json({
      status: 'partial',
      event_id: eventId,
      reason: 'proof_name_approvals_sync_failed',
    })
  }

  // ── Help Scout customer thread (best-effort) ─────────────────────────────
  // From here on, any failure returns 'partial' rather than rolling back —
  // the customer's intent is recorded in proof_events; the HS notification
  // is a courtesy that the dashboard can flag for manual follow-up via
  // helpscout_thread_id IS NULL on the row.

  if (!conversationId) {
    // No HS conversation linked — record the event and return partial
    // with a clear reason. The dashboard will surface this the same way
    // it'd surface a transient HS outage.
    console.warn('[proof-action] no conversation linked', { proofVersionId })
    return json({ status: 'partial', event_id: eventId, reason: 'helpscout_post_failed' })
  }

  const appId = Deno.env.get('HELPSCOUT_APP_ID')?.trim()
  const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')?.trim()
  if (!appId || !appSecret) {
    console.error('[proof-action] HS credentials not configured')
    return json({ status: 'partial', event_id: eventId, reason: 'helpscout_post_failed' })
  }

  // Resolution order (inverted from the original env-first shape as
  // part of Option B / lightweight isolation — localhost dev triggering
  // an HS post should produce a localhost-pointing link, not a prod-
  // pointing one):
  //
  //   1. Request Origin header IF it's in ALLOWED_BASE_URL_ORIGINS.
  //      The allowlist protects against an attacker posting a forged
  //      Origin to steer the HS thread post toward a phishing URL.
  //   2. PROOF_VIEWER_BASE_URL env var. Configured per deployment;
  //      today set to the prod Netlify URL on the Supabase function's
  //      environment.
  //   3. Empty string. Customer thread omits the proof URL line
  //      rather than posting a broken /p/{id} link.
  const rawOrigin = req.headers.get('origin')?.trim() ?? ''
  const allowedOrigin = (ALLOWED_BASE_URL_ORIGINS as readonly string[]).includes(rawOrigin)
    ? rawOrigin
    : ''
  const baseUrl =
    allowedOrigin ||
    Deno.env.get('PROOF_VIEWER_BASE_URL')?.trim() ||
    ''
  const proofUrl = baseUrl ? `${baseUrl.replace(/\/+$/, '')}/p/${v.proof_id}` : null

  // Look up the human-readable option label + dimension noun for the
  // HS thread copy. Two cheap reads when materialOptionCode is set;
  // skipped entirely when null (the no-option-dimension case). Both
  // failures degrade gracefully — buildCustomerThreadText drops the
  // "for the … finish" suffix when either label is null. Customer's
  // intent is already recorded in proof_events so a missing suffix
  // is purely cosmetic.
  let optionDisplayLabel: string | null = null
  let optionDimensionLabel: string | null = null
  if (materialOptionCode) {
    const [optResult, matResult] = await Promise.all([
      admin
        .from('material_options')
        .select('display_name')
        .eq('material_id', v.material_id)
        .eq('code', materialOptionCode)
        .maybeSingle(),
      admin
        .from('materials')
        .select('option_label')
        .eq('id', v.material_id)
        .maybeSingle(),
    ])
    optionDisplayLabel =
      (optResult.data as { display_name: string } | null)?.display_name ?? null
    optionDimensionLabel =
      (matResult.data as { option_label: string | null } | null)?.option_label ?? null
  }

  const text = buildCustomerThreadText(
    eventType,
    actorName,
    recipientName,
    comment,
    fileNames,
    proofUrl,
    optionDisplayLabel,
    optionDimensionLabel,
    variantDisplayName,
  )

  let threadId = 0
  try {
    const token = await hsAccessToken(appId, appSecret)
    const customerId = await hsPrimaryCustomerId(token, conversationId)
    threadId = await hsPostCustomerThread(token, conversationId, customerId, text)
  } catch (hsErr) {
    console.error('[proof-action] HS post failed', hsErr)
    return json({ status: 'partial', event_id: eventId, reason: 'helpscout_post_failed' })
  }

  // Stamp the thread id back on the event row. Best-effort: log on
  // failure but don't downgrade the response — the HS thread is
  // already posted and the event already exists; the column going
  // unstamped is mildly degraded but not user-visible-broken.
  if (threadId > 0) {
    const { error: updateErr } = await admin
      .from('proof_events')
      .update({ helpscout_thread_id: String(threadId) })
      .eq('id', eventId)
    if (updateErr) {
      console.error('[proof-action] thread-id update failed', updateErr)
    }
  }

  return json({ status: 'ok', event_id: eventId })
})
