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
//   VCARD_SUPABASE_URL,                       — vCard app's project URL
//   VCARD_SUPABASE_ANON_KEY                    + anon (publishable) key.
//                                              Used by the Phase 4
//                                              hosted-vCard snapshot
//                                              (migration 000194) to
//                                              freeze the contact data
//                                              the customer approved.
//                                              Missing / unreachable
//                                              degrades to null
//                                              qr_snapshot — the
//                                              approval still records.
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
import {
  fetchConversationOwnership,
  getAccessToken,
  HsError,
  postStaffReply,
} from '../_shared/helpscout.ts'

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

// ── Reply template renderer (verbatim copy of src/lib/replyTemplates.ts) ─────
//
// Edge functions are Deno modules with no import path back into src/,
// so we carry a small copy of the template renderer here. The two
// must stay in sync — same as SHARED_APPROVAL_KEY above. The renderer
// is small and the substitution syntax is unlikely to change; if a
// second server-side renderer ever appears, extract then.
//
// Syntax matches the admin template editor:
//   {variable}             — substitute ctx[variable], empty if null/undefined
//   {? variable}body{/?}   — render body iff ctx[variable] is non-empty
//                            (after .trim() for strings; null/undefined
//                            collapse the block). No nesting.

type TemplateContext = Record<string, string | number | null | undefined>

function renderTemplate(template: string, ctx: TemplateContext): string {
  // Pass 1: conditional blocks. Match {? var}body{/?} non-greedily so
  // multiple blocks in one template resolve independently. The body
  // recurses through substituteVariables so {var} tokens inside a
  // surviving block render correctly. Empty / whitespace / null /
  // undefined ctx values trim the whole block.
  let s = template.replace(
    /\{\?\s*(\w+)\s*\}([\s\S]*?)\{\/\?\}/g,
    (_match, varName: string, body: string) => {
      const v = ctx[varName]
      const empty = v == null || (typeof v === 'string' && v.trim() === '')
      return empty ? '' : substituteVariables(body, ctx)
    },
  )
  // Pass 2: bare variables outside conditional blocks.
  s = substituteVariables(s, ctx)
  return s
}

function substituteVariables(text: string, ctx: TemplateContext): string {
  return text.replace(/\{(\w+)\}/g, (_match, v: string) => {
    const val = ctx[v]
    return val == null ? '' : String(val)
  })
}

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
// OAuth token + conversation fetch + staff-reply POST live in
// ../_shared/helpscout.ts. The customer-thread POST stays here
// because it has a single caller and the Help Scout endpoint shape
// (no `user` field, no status flip) is specific to "speak as the
// customer". Differences vs send-helpscout-reply's POST /reply path:
//   * /customer endpoint creates a thread attributed to the customer,
//     not the staff agent.
//   * No `user` field in the body.
//   * No status flip — the proof's status is managed in app code; the
//     HS conversation status is left to the designer to manage from HS
//     itself.

// Returns the new thread id parsed from the response headers, or 0
// if HS responded successfully but neither header carried an id.
//
// Header contract for the customer endpoint as observed on the live
// HS API on 2026-04-27: Resource-Id holds the thread id directly,
// Location is empty. The /reply endpoint inverts that pairing —
// Location carries the thread URL, Resource-Id is empty. Reading
// both, with Resource-Id preferred and Location as a path-tail
// fallback, is the safe shape across both endpoints and across
// any future HS API change that swaps which header carries the id
// (memory:proof_viewer_helpscout_customer_endpoint.md). Mirrors the
// Location parser at hsPostReply (~line 194) for symmetry.
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

  // Prefer Resource-Id; this is the empirically-observed location of
  // the new thread id on the customer endpoint today.
  //
  // Regex shapes deliberately mirror the parser in _shared/helpscout.ts
  // postStaffReply so both POST helpers parse identically: digits-only
  // anchored on Resource-Id, end-anchored /threads/{id} on Location.
  const resourceId = resp.headers.get('Resource-Id') ?? ''
  const directId = resourceId.match(/^\d+$/)?.[0]
  const location = resp.headers.get('Location') ?? ''
  const locationId = location.match(/\/threads\/(\d+)$/)?.[1]
  const threadIdRaw = directId ?? locationId
  const threadId = threadIdRaw ? Number(threadIdRaw) : NaN
  return Number.isFinite(threadId) && threadId > 0 ? threadId : 0
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

// ── Hosted-vCard snapshot (migration 000194) ──────────────────────────────────
//
// On approve, for every hosted-vCard QR visible to the slot, we fetch the
// vCard app's anon RPCs to freeze a copy of the contact data the customer
// just confirmed. Mirrors src/lib/vcardClient.ts on the frontend side
// (verbatim parity: the edge runtime cannot import from src/, same as
// SHARED_APPROVAL_KEY above). Three sequential lookups per slug:
//   1. lookup_card_by_slug         — top-level card row (incl. card id)
//   2. lookup_card_links_by_card_id        — social / custom links
//   3. lookup_card_contact_methods_by_card_id — secondary emails / phones
//
// Snapshot shape is documented in migration 000194's column comment.
// Styling fields (profile / cover image, theme_*) are intentionally
// excluded — they are not part of the proof's contractual content.
//
// Best-effort: any failure (env missing, network down, slug not found,
// shape mismatch) is logged and that slug is skipped. When every slug
// fails the whole snapshot is returned as null — the approval row still
// records, qr_confirmed_at still stamps, and the designer surface shows
// "snapshot unavailable" on the approval expand.
//
// Slugs are case-sensitive per the integration brief — we use
// qr_vcard_slug as stored without normalising.

const VCARD_RPC_TIMEOUT_MS = 4_000

interface VcardCardRow {
  id: string
  slug: string
  // A Plasma vCard can be a contact card OR a URL redirect. When
  // target_type is 'external_url' the card resolves to external_url
  // and the contact fields below are unused — the snapshot needs
  // both to record what the customer actually approved.
  target_type: string | null
  external_url: string | null
  first_name: string | null
  last_name: string | null
  nickname: string | null
  job_title: string | null
  company: string | null
  birthday: string | null
  primary_email: string | null
  email_label: string | null
  primary_phone: string | null
  phone_label: string | null
  bio: string | null
  address_street: string | null
  address_city: string | null
  address_region: string | null
  address_postcode: string | null
  address_country: string | null
}

interface VcardLinkRow {
  id: string
  url: string
  label: string | null
  icon_slug: string | null
  sort_order: number
}

interface VcardContactMethodRow {
  id: string
  method_type: 'email' | 'phone'
  value: string
  label: string | null
  sort_order: number
}

interface VcardSnapshotEntry {
  captured_at: string
  card_id: string
  card_slug: string
  // 'vcard' (contact card) or 'external_url' (URL redirect). Null
  // tolerated for forward-compatibility with future card kinds; the
  // designer-side display treats null the same as 'vcard'.
  target_type: string | null
  external_url: string | null
  first_name: string | null
  last_name: string | null
  nickname: string | null
  job_title: string | null
  company: string | null
  primary_email: string | null
  email_label: string | null
  primary_phone: string | null
  phone_label: string | null
  bio: string | null
  birthday: string | null
  address_street: string | null
  address_city: string | null
  address_region: string | null
  address_postcode: string | null
  address_country: string | null
  links: Array<{
    url: string
    label: string | null
    icon_slug: string | null
    sort_order: number
  }>
  contact_methods: Array<{
    method_type: 'email' | 'phone'
    value: string
    label: string | null
    sort_order: number
  }>
}

async function vcardRpc<T>(
  baseUrl: string,
  anonKey: string,
  fnName: string,
  body: Record<string, unknown>,
): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), VCARD_RPC_TIMEOUT_MS)
  try {
    const res = await fetch(`${baseUrl}/rest/v1/rpc/${fnName}`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`vCard RPC ${fnName} ${res.status}: ${text}`)
    }
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

async function buildHostedVcardSnapshot(
  slugs: string[],
): Promise<Record<string, VcardSnapshotEntry> | null> {
  if (slugs.length === 0) return null
  const baseUrl = Deno.env.get('VCARD_SUPABASE_URL')?.trim().replace(/\/+$/, '') ?? ''
  const anonKey = Deno.env.get('VCARD_SUPABASE_ANON_KEY')?.trim() ?? ''
  if (!baseUrl || !anonKey) {
    console.warn('[proof-action] vCard snapshot skipped: env not configured')
    return null
  }

  // De-dupe in case the same slug appears on multiple QR rows for the
  // slot. Case-sensitive as per the integration brief.
  const uniqueSlugs = Array.from(new Set(slugs))
  const capturedAt = new Date().toISOString()
  const snapshot: Record<string, VcardSnapshotEntry> = {}

  await Promise.all(
    uniqueSlugs.map(async (slug) => {
      try {
        const cardRows = await vcardRpc<VcardCardRow[]>(baseUrl, anonKey, 'lookup_card_by_slug', {
          card_slug: slug,
        })
        const card = Array.isArray(cardRows) && cardRows.length > 0 ? cardRows[0] : null
        if (!card) {
          console.warn('[proof-action] vCard snapshot skipped: slug not found', { slug })
          return
        }
        // URL-redirect cards have no contact card behind them, so
        // links / contact_methods are by definition empty for those
        // — skip the two extra RPC round-trips. Contact-card cards
        // (target_type === 'vcard' or legacy null) keep the full
        // bundled fetch.
        const isRedirect = card.target_type === 'external_url'
        const [links, contactMethods] = isRedirect
          ? [[] as VcardLinkRow[], [] as VcardContactMethodRow[]]
          : await Promise.all([
              vcardRpc<VcardLinkRow[]>(baseUrl, anonKey, 'lookup_card_links_by_card_id', {
                p_card_id: card.id,
              }).catch((e) => {
                console.warn('[proof-action] vCard links lookup failed', { slug, error: String(e) })
                return [] as VcardLinkRow[]
              }),
              vcardRpc<VcardContactMethodRow[]>(
                baseUrl,
                anonKey,
                'lookup_card_contact_methods_by_card_id',
                { p_card_id: card.id },
              ).catch((e) => {
                console.warn('[proof-action] vCard contact methods lookup failed', {
                  slug,
                  error: String(e),
                })
                return [] as VcardContactMethodRow[]
              }),
            ])
        snapshot[slug] = {
          captured_at: capturedAt,
          card_id: card.id,
          card_slug: card.slug,
          target_type: card.target_type,
          external_url: card.external_url,
          first_name: card.first_name,
          last_name: card.last_name,
          nickname: card.nickname,
          job_title: card.job_title,
          company: card.company,
          primary_email: card.primary_email,
          email_label: card.email_label,
          primary_phone: card.primary_phone,
          phone_label: card.phone_label,
          bio: card.bio,
          birthday: card.birthday,
          address_street: card.address_street,
          address_city: card.address_city,
          address_region: card.address_region,
          address_postcode: card.address_postcode,
          address_country: card.address_country,
          links: (Array.isArray(links) ? links : []).map((l) => ({
            url: l.url,
            label: l.label,
            icon_slug: l.icon_slug,
            sort_order: l.sort_order,
          })),
          contact_methods: (Array.isArray(contactMethods) ? contactMethods : []).map((m) => ({
            method_type: m.method_type,
            value: m.value,
            label: m.label,
            sort_order: m.sort_order,
          })),
        }
      } catch (err) {
        console.warn('[proof-action] vCard snapshot failed for slug', {
          slug,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }),
  )

  return Object.keys(snapshot).length > 0 ? snapshot : null
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
  // qr_confirmed: boolean flag the customer page sets to true when
  // the "I've verified my QR code contents" checkbox is ticked.
  // The flag is only meaningful on the approve path and only on
  // versions that have at least one QR row visible to the slot —
  // see the server-side enforcement block below. Accept boolean
  // true exclusively; everything else (false, missing, non-bool)
  // collapses to false. Matches migration 000169's predicate:
  // qr_confirmed_at IS NOT NULL is what counts; the timestamp
  // itself is server-stamped to avoid client-clock spoofing.
  let qrConfirmed: boolean
  // side is the card face the customer had open in the detail view
  // when they submitted the action (Phase 3 customer-page rework).
  // Accept exactly 'front' or 'back' off the wire; everything else
  // — missing key, null, empty string, unexpected value — collapses
  // to null. The DB CHECK from migration 000196 only allows those
  // two values plus null, so anything weirder than that would
  // 23514 anyway; the parser pre-empts it with a clean null.
  let side: 'front' | 'back' | null
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
    qrConfirmed = parsed?.qr_confirmed === true
    const rawSide = parsed?.side
    side = rawSide === 'front' || rawSide === 'back' ? rawSide : null
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
      'id, proof_id, material_id, currency, displayed_variant_ids, names, material_options, is_variant_round, version_number, ' +
      'proofs:proof_id ( helpscout_conversation_id, created_by ), ' +
      // is_qr_code joined per migration 000168 so the QR-confirmation
      // enforcement block below can decide whether the slot actually
      // needs the tick before counting qr_confirmed in the upsert.
      // qr_kind + qr_vcard_slug (migrations 000192 / 000194) feed the
      // hosted-vCard snapshot below.
      'proof_version_images ( original_filename, sort_order, associated_name, is_qr_code, qr_kind, qr_vcard_slug )',
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
    version_number: number
    proofs: {
      helpscout_conversation_id: string | null
      created_by: string | null
    } | null
    proof_version_images: Array<{
      original_filename: string | null
      sort_order: number
      associated_name: string | null
      is_qr_code: boolean
      qr_kind: string | null
      qr_vcard_slug: string | null
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

    // ── Lock-on-selection: variant rounds reject a second customer choice ─
    // Build-plan contract: once a customer has selected a variant,
    // the variant set is locked ("no in-page change-of-mind; reply
    // by email" — CustomerProofPage 1453). The customer page hides
    // the CTA on locked rounds, but a stale link or direct API
    // call could bypass that. The proof_name_approvals upsert
    // below uses onConflict: (proof_version_id, name), which would
    // silently overwrite the existing __shared__ row, breaking the
    // lock contract.
    //
    // Fast-path pre-check first — common case is the lock was
    // already taken before the request landed (e.g. a stale tab
    // re-submitted after the round was decided). Returning 400
    // here keeps proof_events clean of the rejected attempt.
    // Belt-and-braces via ignoreDuplicates: true on the upsert
    // below (the SELECT-then-UPSERT pattern races in the microsecond
    // window between the two calls; the unique index on
    // (proof_version_id, name) serialises concurrent writes at
    // the DB level so the do-nothing pattern is correct under
    // contention).
    const { data: lockRow, error: lockErr } = await admin
      .from('proof_name_approvals')
      .select('id')
      .eq('proof_version_id', proofVersionId)
      .eq('name', SHARED_APPROVAL_KEY)
      .maybeSingle()
    if (lockErr) {
      console.error('[proof-action] lock-check failed', lockErr)
      return failed('unknown', 500, lockErr.message)
    }
    if (lockRow) {
      return failed('validation', 400, 'this variant round has already been locked by a customer selection')
    }
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

  // ── QR-confirmation enforcement (migration 000169) ───────────────────────
  // The customer page renders a "I've verified my QR code contents"
  // checkbox above the Approve button when at least one QR row is
  // visible to the slot. The button is disabled until that's ticked.
  // The body's qr_confirmed flag records that tick. This block is
  // the server-side mirror: if the customer somehow bypasses the
  // disabled button (stale tab, direct API call), an approve with
  // an unticked QR set is rejected here rather than landing as a
  // state='approved' row with null qr_confirmed_at that the DB
  // predicate then refuses to count toward auto-finalize. Variant
  // rounds already reject 'approve' earlier (build-plan step 4 +
  // line 629 above), so this block only fires on the standard path.
  //
  // Slot coordinates match the DB predicate in
  // _finalize_proof_if_complete:
  //   * Named slot: rows where associated_name = slot OR null
  //   * __shared__ when names is empty: every QR row
  //   * __shared__ on a split-name version: not gated (Shared is
  //     approved-by-implication; the customer page hides the tick)
  //
  // qrConfirmedAt feeds the proof_name_approvals upsert below. We
  // stamp it server-side rather than trusting a client timestamp
  // — same shape as updated_at — so the predicate can rely on
  // "set means the customer ticked at action time".
  let qrConfirmedAt: string | null = null
  // Hosted-vCard snapshot (migration 000194). Populated only on the
  // approve path AND only when at least one slot QR is a hosted vCard
  // with a stored slug. Best-effort: null if the vCard app is
  // unreachable or env-misconfigured; the approval still records.
  let qrSnapshot: Record<string, VcardSnapshotEntry> | null = null
  if (eventType === 'approve') {
    const hasNames = recipientRoster.length > 0
    const slotQrImages = (v.proof_version_images ?? []).filter((img) => {
      if (!img.is_qr_code) return false
      if (recipientName === SHARED_APPROVAL_KEY) {
        // __shared__ only collects QRs as a slot when names is
        // empty. On split-name versions the sentinel isn't a
        // gated slot so no rows count.
        return !hasNames
      }
      return img.associated_name === recipientName || img.associated_name == null
    })

    if (slotQrImages.length > 0 && !qrConfirmed) {
      return failed(
        'validation',
        400,
        'Please confirm the QR code contents before approving.',
      )
    }
    if (slotQrImages.length > 0) {
      qrConfirmedAt = new Date().toISOString()
    }

    // Snapshot the hosted-vCard QRs visible to this slot. The slot
    // coordinate filter above already restricts to the relevant rows;
    // here we narrow to the hosted_vcard subset with a non-null slug.
    const hostedSlugs = slotQrImages
      .filter((img) => img.qr_kind === 'hosted_vcard' && img.qr_vcard_slug)
      .map((img) => img.qr_vcard_slug as string)
    if (hostedSlugs.length > 0) {
      try {
        qrSnapshot = await buildHostedVcardSnapshot(hostedSlugs)
      } catch (snapErr) {
        // Defensive — buildHostedVcardSnapshot swallows its own
        // failures, so this branch is essentially unreachable. Logged
        // and degraded to null so the approve still lands.
        console.warn('[proof-action] vCard snapshot threw at top level', snapErr)
        qrSnapshot = null
      }
    }
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
    // Migration 000196. Card side visible in the detail view at the
    // moment the customer submitted; null when no detail view was
    // open (e.g. the panel was opened from the overview action band)
    // or for non-Phase-3 clients that don't send the field.
    // Designer-only — surfaced on ProofDetailPage's audit panel and
    // not exposed via any public_* view.
    side,
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
  const approvalRow = {
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
    // Migration 000169. Server-stamped above when event = approve
    // AND the slot has QRs visible to it. Null otherwise (no QRs
    // visible → tick isn't shown → predicate short-circuits;
    // request_changes → no QR confirmation semantics). Stamping
    // here, on the upsert, means a re-approve after a previous
    // changes-requested correctly refreshes the timestamp, and
    // a changes-requested clears it back to null so the slot has
    // to re-confirm on the next approve.
    qr_confirmed_at: qrConfirmedAt,
    // Migration 000194. Slug-keyed snapshot of each hosted-vCard
    // QR's contact data at action time. Null when no hosted-vCard
    // QRs are visible to the slot, when the vCard app couldn't be
    // reached, or on the request_changes path (a customer who is
    // asking for changes hasn't approved anything to snapshot).
    // Set explicitly on every approve+QR-confirm so a re-approve
    // after a changes-requested correctly refreshes the captured
    // values; cleared (set to null) on request_changes for the
    // same reason qr_confirmed_at is.
    qr_snapshot: qrSnapshot,
  }

  // Branch on is_variant_round: standard versions allow the
  // customer to change their mind (re-approve, re-request changes
  // with a new comment) so the upsert overwrites; variant rounds
  // are lock-on-selection so use ignoreDuplicates (ON CONFLICT DO
  // NOTHING) and inspect the returned row count. The pre-check
  // earlier in the variant-round validation block catches the
  // common case; this is the race-safe fallback for two
  // near-simultaneous selections.
  let approvalErr: { message: string } | null = null
  if (v.is_variant_round) {
    const { data: insertedApproval, error } = await admin
      .from('proof_name_approvals')
      .upsert(approvalRow, {
        onConflict: 'proof_version_id,name',
        ignoreDuplicates: true,
      })
      .select('id')
    approvalErr = error
    if (!error && (insertedApproval?.length ?? 0) === 0) {
      // Pre-check said "no lock yet" but a concurrent request
      // landed first. The unique index returned no rows for our
      // insert; the lock is held by the other request. Same
      // 400 the pre-check returns, so the customer sees a
      // consistent message regardless of which path detected it.
      // The proof_events row recording this attempt is left in
      // place as audit signal of the rejected selection.
      return failed('validation', 400, 'this variant round has already been locked by a customer selection')
    }
  } else {
    const { error } = await admin
      .from('proof_name_approvals')
      .upsert(approvalRow, { onConflict: 'proof_version_id,name' })
    approvalErr = error
  }
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

  // Token + ownership ids carry forward into the confirmation-reply
  // block below, so they're declared with `let` outside this try
  // block and assigned inside. fetchConversationOwnership is a
  // single GET that returns both primaryCustomerId (consumed by the
  // customer-thread post) and assigneeId (consumed by the reply's
  // sender resolution).
  let threadId = 0
  let token: string | null = null
  let primaryCustomerId: number | null = null
  let assigneeId: number | null = null
  try {
    token = await getAccessToken(appId, appSecret)
    const ownership = await fetchConversationOwnership(token, conversationId)
    if (!ownership) throw new HsError(404, 'HS conversation not found')
    if (ownership.primaryCustomerId == null) {
      throw new HsError(502, 'HS conversation has no primary customer')
    }
    primaryCustomerId = ownership.primaryCustomerId
    assigneeId = ownership.assigneeId
    threadId = await hsPostCustomerThread(token, conversationId, primaryCustomerId, text)
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

  // ── Designer confirmation reply (best-effort, isolated try/catch) ────────
  //
  // Layered on top of the customer-thread post: a staff reply that
  // Help Scout WILL email out to the customer, so the customer sees
  // a confirmation in the same email thread as the original proof
  // email. Help Scout doesn't email customer-thread messages back to
  // the customer who sent them, so without this they have no record
  // of their own action in their inbox.
  //
  // Boundary discipline:
  //   * Wrapped in its own try/catch — fully isolated from the
  //     customer's success path. The customer-thread post and DB
  //     writes are already durable by this point; a confirmation-
  //     reply failure is a courtesy gap, not a partial outcome.
  //   * Never returns 'partial'. 'partial' is reserved for "step 3
  //     broke"; a reply failure here flows into the unconditional
  //     `return json({ status: 'ok' })` below.
  //   * console.warn for skip / failure (this is a courtesy that
  //     didn't land); console.error reserved for the customer-thread
  //     post's real failures above.
  //
  // Sender resolution (no cascading on HS API failure — a tier-1
  // mapping that HS rejects should surface in logs as a real signal
  // to fix the mapping, not get papered over by tier 2):
  //   1. proofs.created_by → profiles.helpscout_user_id, if non-null
  //   2. assigneeId from the conversation, if non-null
  //   3. HELPSCOUT_DEFAULT_USER_ID env, if set and numeric. Mirrors the
  //      tier-3 fallback in send-helpscout-reply so confirmation replies
  //      and manual designer replies share the same resolution shape
  //      (PV-2026W20-007). A confirmation that posts under the default
  //      account is recoverable; a confirmation that silently doesn't
  //      post leaves the customer wondering whether their approval
  //      registered.
  //   4. skip with console.warn. Reached when none of the three tiers
  //      can produce a valid sender — typically only on environments
  //      where the default-user env var hasn't been configured. The
  //      env-missing case is logged as a warn rather than an error
  //      because the customer's action is already durable and posted
  //      on the customer thread above; the confirmation reply is a
  //      courtesy, not a partial outcome.
  //
  // Template routing mirrors the buildCustomerThreadText branching
  // above: variantDisplayName != null → variant_selection;
  // eventType === 'approve' → approval; else → change_request.
  try {
    if (token == null || primaryCustomerId == null) {
      // Defensive — both are assigned in the step-3 try block on the
      // success path, so this is unreachable in practice. The early-
      // return on step-3 failure means we never reach this block when
      // they're null. But TypeScript doesn't track that across the
      // try/catch, and a future refactor could subtly break the
      // invariant — log + skip rather than rely on a non-null
      // assertion.
      console.warn('[proof-action] reply skipped: token/customer missing on success path')
    } else {
      // Tier 1: proof's assigned designer.
      let senderId: number | null = null
      const createdBy = v.proofs?.created_by ?? null
      if (createdBy) {
        const { data: profileRow, error: profileErr } = await admin
          .from('profiles')
          .select('helpscout_user_id')
          .eq('id', createdBy)
          .maybeSingle()
        if (profileErr) {
          console.warn('[proof-action] reply: designer profile lookup failed', profileErr.message)
        } else {
          const value = (profileRow as { helpscout_user_id: number | null } | null)?.helpscout_user_id ?? null
          if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0) {
            senderId = value
          }
        }
      }
      // Tier 2: HS conversation assignee.
      if (senderId == null && assigneeId != null) {
        senderId = assigneeId
      }
      // Tier 3: HELPSCOUT_DEFAULT_USER_ID env. Same gate shape used by
      // send-helpscout-reply for parity (PV-2026W20-007). Trim guards
      // against secrets configured with stray whitespace.
      let defaultUserIdSource: 'env' | null = null
      if (senderId == null) {
        const raw = Deno.env.get('HELPSCOUT_DEFAULT_USER_ID')?.trim()
        if (raw) {
          const parsed = Number(raw)
          if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0) {
            senderId = parsed
            defaultUserIdSource = 'env'
          } else {
            console.warn('[proof-action] reply: HELPSCOUT_DEFAULT_USER_ID is not a positive integer', { raw })
          }
        }
      }
      // Tier 4: skip + warn. Reached only when the env-var fallback
      // was unset or invalid; the customer's action is already durable,
      // so this is a courtesy gap, not a failure path.
      if (senderId == null) {
        console.warn('[proof-action] reply skipped: no sender resolvable', {
          proofVersionId,
          createdBy,
          assigneeId,
        })
      } else {
        if (defaultUserIdSource === 'env') {
          console.log('[proof-action] reply using default HS id', { senderId })
        }
        // Route to the template that matches the action shape.
        const templateCode =
          variantDisplayName != null
            ? 'proof_variant_selection_confirmation'
            : eventType === 'approve'
              ? 'proof_approval_confirmation'
              : 'proof_change_request_confirmation'

        const { data: templateRow, error: templateErr } = await admin
          .from('reply_templates')
          .select('body')
          .eq('id', templateCode)
          .maybeSingle()
        if (templateErr || !templateRow) {
          console.warn('[proof-action] reply skipped: template fetch failed', {
            templateCode,
            error: templateErr?.message ?? 'row missing',
          })
        } else {
          const body = renderTemplate((templateRow as { body: string }).body, {
            // Variables explicitly named in the seed defaults:
            version_label: `version ${v.version_number}`,
            change_notes: comment ?? '',
            chosen_variant: variantDisplayName ?? '',
            // Surfaced for admin customisation (not in the defaults
            // but documented in the admin template editor):
            actor_name: actorName,
            recipient_name: recipientName === SHARED_APPROVAL_KEY ? '' : recipientName,
          })
          const replyThreadId = await postStaffReply(token, conversationId, {
            text: body,
            userId: senderId,
            customerId: primaryCustomerId,
            // No status flip — this is a confirmation, not a
            // designer asking the customer for input.
          })
          console.log('[proof-action] confirmation reply sent', {
            templateCode,
            senderId,
            replyThreadId,
          })
        }
      }
    }
  } catch (replyErr) {
    // Anything from the sender-resolution / template / postStaffReply
    // path lands here. console.warn (not error) — the customer's
    // action is already durable and posted; the missing confirmation
    // is a courtesy gap.
    console.warn('[proof-action] confirmation reply failed', replyErr)
  }

  return json({ status: 'ok', event_id: eventId })
})
