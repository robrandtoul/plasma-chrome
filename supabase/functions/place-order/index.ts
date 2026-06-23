// place-order — designer-only. The single hand-off for placing a PAID order
// into production. Replaces the old auto-posting place-inhouse-order path: both
// routes now go through a review-and-confirm screen backed by this function.
//
// Modes:
//   * preview → composes the hand-off and returns it WITHOUT sending: for an
//     in-house order the production note + the Help Scout subject; for a supplier
//     order the email body + the chosen supplier + the active-supplier list (for
//     the picker) + the computed must-ship-by. Also returns a spec summary so the
//     review page shows exactly what the hand-off used.
//   * confirm → executes. In-house: sets the proof conversation's subject + posts
//     the production note (Stock Control's helpscout-inhouse-order ingests it).
//     Supplier: emails the chosen supplier as a NEW Help Scout conversation
//     (primary customer = the supplier, an outbound staff reply carrying the
//     order — Stock Control's helpscout-outsourced-order ingests it). Then flips
//     the order to 'fulfilled' (placed) and audits.
//
// Route comes from the proof material's production_route (in_house | supplier).
// The composed text is identical in preview and confirm (single source — what
// you see is what's sent). verify_jwt = true; designer/admin gate.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { encodeBase64 } from 'jsr:@std/encoding/base64'
import { getDropboxAccessToken, listSharedLinkEntries, downloadSharedLinkFile } from '../_shared/dropbox.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

class HsError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'HsError'
  }
}

// ── Help Scout helpers (inline; self-contained for the MCP deploy) ──────────
async function getAccessToken(appId: string, appSecret: string): Promise<string> {
  const resp = await fetch('https://api.helpscout.net/v2/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: appId, client_secret: appSecret }).toString(),
  })
  if (!resp.ok) {
    const b = await resp.text().catch(() => '')
    throw new HsError(resp.status, `Help Scout token error (${resp.status}): ${b.slice(0, 200)}`)
  }
  const tok = (await resp.json().catch(() => null) as { access_token?: string } | null)?.access_token
  if (!tok) throw new HsError(500, 'Help Scout token response missing access_token')
  return tok
}

// Read a conversation's mailbox id (the supplier email is sent from the same
// mailbox as the proof's customer thread).
async function fetchMailboxId(token: string, conversationId: string | number): Promise<number | null> {
  const resp = await fetch(`https://api.helpscout.net/v2/conversations/${conversationId}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!resp.ok) return null
  const c = await resp.json().catch(() => null)
  const m = (c as { mailboxId?: number } | null)?.mailboxId
  return typeof m === 'number' ? m : null
}

async function setConversationSubject(token: string, conversationId: string | number, subject: string): Promise<void> {
  const resp = await fetch(`https://api.helpscout.net/v2/conversations/${conversationId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'replace', path: '/subject', value: subject }),
  })
  if (!resp.ok && resp.status !== 204) {
    const b = await resp.text().catch(() => '')
    throw new HsError(resp.status, `subject update (${resp.status}): ${b.slice(0, 200)}`)
  }
}

async function createNote(
  token: string,
  conversationId: string | number,
  userId: number,
  text: string,
  attachments?: { fileName: string; mimeType: string; data: string }[],
): Promise<void> {
  const payload: Record<string, unknown> = { user: userId, text }
  if (attachments && attachments.length) payload.attachments = attachments
  const resp = await fetch(`https://api.helpscout.net/v2/conversations/${conversationId}/notes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!resp.ok && resp.status !== 201) {
    const b = await resp.text().catch(() => '')
    throw new HsError(resp.status, `note create (${resp.status}): ${b.slice(0, 200)}`)
  }
}

// Create a NEW conversation addressed TO the supplier (primary customer = the
// supplier's email) carrying the order as an outbound staff reply, which Help
// Scout emails out. Returns the new conversation id (Resource-Id header).
async function createSupplierConversation(
  token: string,
  opts: { mailboxId: number; subject: string; supplierEmail: string; userId: number; text: string },
): Promise<string | null> {
  const resp = await fetch('https://api.helpscout.net/v2/conversations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      subject: opts.subject,
      type: 'email',
      status: 'pending',
      mailboxId: opts.mailboxId,
      customer: { email: opts.supplierEmail },
      threads: [{ type: 'reply', customer: { email: opts.supplierEmail }, user: opts.userId, text: opts.text }],
    }),
  })
  if (!resp.ok) {
    const b = await resp.text().catch(() => '')
    throw new HsError(resp.status, `supplier conversation create (${resp.status}): ${b.slice(0, 200)}`)
  }
  const rid = resp.headers.get('Resource-Id') ?? resp.headers.get('Resource-ID') ?? ''
  return rid.match(/^\d+$/) ? rid : null
}

// ── Compose helpers ─────────────────────────────────────────────────────────
function titleCaseCode(code: string): string {
  return String(code).split(/[_\s]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

// In-house Card line for Stock Control's forgiving material match.
function buildCardLine(code: string, materialDisplay: string | null, options: unknown, front: string | null, core: string | null, back: string | null): string {
  if (code === 'paper_letterpress' || code === 'paper_letterpress_gilded') {
    if (front && core && back) return `Letterpress (${front}, ${core}, ${back})`
    return 'Letterpress'
  }
  if (code === 'wood') {
    const species = Array.isArray(options) && options.length ? String(options[0]) : ''
    return species ? titleCaseCode(species) : (materialDisplay || 'Wood')
  }
  if (code === 'plastic_translucent') return 'Translucent Plastic'
  return materialDisplay || code
}

// Split freeform ink_names into front / back on a back/reverse/rear marker.
function buildInks(inkNames: unknown): { front: string | null; back: string | null } {
  const inks = (Array.isArray(inkNames) ? inkNames : []).map((s) => String(s).trim()).filter(Boolean)
  if (!inks.length) return { front: null, back: null }
  const backRe = /\b(back|reverse|rear)\b/i
  const backInks = inks.filter((i) => backRe.test(i))
  const frontInks = inks.filter((i) => !backRe.test(i))
  return { front: frontInks.length ? frontInks.join(', ') : null, back: backInks.length ? backInks.join(', ') : null }
}

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

// ── Artwork attachments (in-house) ──────────────────────────────────────────
// Stock Control's in-house ingester mirrors the production note's attachments
// onto the job card, so we attach the prepped Dropbox files to the note — the
// automated version of the manual "attach the files" step. Help Scout caps an
// attachment at 10 MB; larger / non-artwork files are skipped but stay reachable
// via the Dropbox link in the note.
const HS_ATTACH_MAX_BYTES = 10 * 1024 * 1024
const ARTWORK_TOTAL_MAX_BYTES = 20 * 1024 * 1024
const ARTWORK_MAX_FILES = 10

// Map an artwork filename to a mime type, or null if it's not a file Stock
// Control would surface on the job card (mirrors its classifyAttachment).
function artworkMime(name: string): string | null {
  const f = name.toLowerCase()
  if (/\.jpe?g$/.test(f)) return 'image/jpeg'
  if (/\.png$/.test(f)) return 'image/png'
  if (/\.webp$/.test(f)) return 'image/webp'
  if (/\.gif$/.test(f)) return 'image/gif'
  if (/\.tiff?$/.test(f)) return 'image/tiff'
  if (/\.svg$/.test(f)) return 'image/svg+xml'
  if (/\.pdf$/.test(f)) return 'application/pdf'
  if (/\.(ai|eps)$/.test(f)) return 'application/postscript'
  return null
}

interface FolderEntry { name: string; is_folder: boolean; path: string; size: number }
type ArtworkPlan = { attach: string[]; skipped: { name: string; reason: string }[] }

// Decide which folder files we'll attach (by type + size) WITHOUT downloading —
// used for the preview and to drive the confirm download.
function planArtwork(entries: FolderEntry[]): { plan: ArtworkPlan; toFetch: { name: string; path: string; mime: string }[] } {
  const plan: ArtworkPlan = { attach: [], skipped: [] }
  const toFetch: { name: string; path: string; mime: string }[] = []
  for (const e of entries) {
    if (e.is_folder) continue
    const mime = artworkMime(e.name)
    if (!mime) { plan.skipped.push({ name: e.name, reason: 'not an artwork file' }); continue }
    if (e.size > HS_ATTACH_MAX_BYTES) { plan.skipped.push({ name: e.name, reason: 'over 10 MB' }); continue }
    if (toFetch.length >= ARTWORK_MAX_FILES) { plan.skipped.push({ name: e.name, reason: 'attachment limit reached' }); continue }
    plan.attach.push(e.name)
    toFetch.push({ name: e.name, path: e.path, mime })
  }
  return { plan, toFetch }
}

// Download the planned files and base64-encode them for the Help Scout note.
// Best-effort: a file that won't download is skipped; the total is capped so a
// large folder can't blow the edge function's memory or the HS request size.
async function buildArtworkAttachments(
  token: string,
  url: string,
  toFetch: { name: string; path: string; mime: string }[],
): Promise<{ fileName: string; mimeType: string; data: string }[]> {
  const out: { fileName: string; mimeType: string; data: string }[] = []
  let total = 0
  for (const f of toFetch) {
    const bytes = await downloadSharedLinkFile(token, url, f.path)
    if (!bytes || bytes.length > HS_ATTACH_MAX_BYTES) continue
    if (total + bytes.length > ARTWORK_TOTAL_MAX_BYTES) break
    total += bytes.length
    out.push({ fileName: f.name, mimeType: f.mime, data: encodeBase64(bytes) })
  }
  return out
}

// YYYY-MM-DD (the safest "Must ship by" format for the outsourced ingester).
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// The supplier default for a material (Rob's routing). Full colour plastic
// defaults to QX but the picker offers the alternate (Swype).
function defaultSupplierName(code: string): string {
  if (code.startsWith('metal_')) return 'QX Metals'
  if (code === 'carbon_fibre' || code === 'carbon_fibre_cnc') return 'QX Metals'
  if (code === 'plastic_full_colour') return 'QX Metals'
  if (code === 'paper_standard') return 'Solopress'
  return ''
}

// Material → Stock Control outsourced product-type name (the `Material:` line).
function productTypeFor(code: string): string {
  if (code.startsWith('metal_')) return 'Metal'
  if (code === 'carbon_fibre' || code === 'carbon_fibre_cnc') return 'Carbon fibre'
  if (code === 'plastic_full_colour') return 'Full colour plastic'
  if (code === 'paper_standard') return 'Standard cards'
  return ''
}

// Designer/admin gate. Returns the proofs-schema service client + a public-schema
// service client (for Stock Control's outsourced_suppliers) + caller id.
async function requireDesigner(req: Request): Promise<{ admin: SupabaseClient; pub: SupabaseClient; callerId: string } | Response> {
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.toLowerCase().startsWith('bearer ')) return json({ ok: false, error: 'Unauthorized' }, 401)
  const jwt = authHeader.replace(/^[Bb]earer\s+/, '').trim()
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const anon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY') ?? '')
  const { data: userData, error: userErr } = await anon.auth.getUser(jwt)
  if (userErr || !userData?.user) return json({ ok: false, error: 'Unauthorized' }, 401)
  const admin = createClient(url, serviceKey, { db: { schema: 'proofs' }, auth: { persistSession: false, autoRefreshToken: false } })
  const pub = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: profile } = await admin.from('profiles').select('role, deactivated_at').eq('id', userData.user.id).single()
  if (!profile || profile.deactivated_at) return json({ ok: false, error: 'Forbidden' }, 403)
  if (profile.role !== 'admin' && profile.role !== 'designer') return json({ ok: false, error: 'Forbidden' }, 403)
  return { admin, pub, callerId: userData.user.id }
}

interface SupplierRow {
  id: string
  name: string
  email: string | null
  is_international: boolean
  default_shipping_days: number | null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)

  const check = await requireDesigner(req)
  if (check instanceof Response) return check
  const { admin, pub, callerId } = check

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400)
  }
  const orderId = String(body.order_id ?? '').trim()
  const mode = body.mode === 'confirm' ? 'confirm' : 'preview'
  const supplierIdOverride = typeof body.supplier_id === 'string' && body.supplier_id ? body.supplier_id : null
  if (!orderId) return json({ ok: false, error: 'order_id is required' }, 400)

  // ── Load order + proof + current version ──────────────────────────────────
  const { data: order, error: orderErr } = await admin
    .from('orders')
    .select('id, status, quantity, person_quantities, date_required, stock_order_number, project_name, proof_id, ship_dest_country, ship_to_address, material_variant_id, material_option_id, dropbox_folder_url, payment_reference, currency')
    .eq('id', orderId)
    .maybeSingle()
  if (orderErr) return json({ ok: false, error: `Order lookup failed: ${orderErr.message}` }, 500)
  if (!order) return json({ ok: false, error: 'Order not found.' }, 404)
  if (order.status !== 'paid') return json({ ok: false, error: `Order is ${order.status}, not paid — it can't be placed.` }, 409)
  if (!order.stock_order_number) return json({ ok: false, error: 'Link and check the Dropbox order folder first (no order number).' }, 400)
  if (!order.date_required) return json({ ok: false, error: 'Set the date required first.' }, 400)

  const { data: proof } = await admin
    .from('proofs')
    .select('id, helpscout_conversation_id, contacts:contact_id ( full_name, companies:company_id ( name ) )')
    .eq('id', order.proof_id)
    .maybeSingle()
  const conversationId = (proof as { helpscout_conversation_id: string | null } | null)?.helpscout_conversation_id ?? null
  const contact = (proof as { contacts?: { full_name?: string | null; companies?: { name?: string | null } | null } | null } | null)?.contacts ?? null
  const customerName = (contact?.companies?.name?.trim()) || (contact?.full_name?.trim()) || (order.project_name?.trim()) || 'Customer'

  const { data: pv } = await admin
    .from('proof_versions')
    .select('material_display, ink_names, material_options, front_colour_id, core_colour_id, back_colour_id, materials(code, display_name, production_route)')
    .eq('proof_id', order.proof_id)
    .eq('is_current', true)
    .maybeSingle()
  if (!pv) return json({ ok: false, error: 'No current proof version found.' }, 404)
  const mat = (pv as { materials: { code: string; display_name: string | null; production_route: string | null } | null }).materials
  if (!mat) return json({ ok: false, error: 'This version has no single material (mixed / variant round) — place it manually.' }, 400)
  const route = mat.production_route === 'supplier' ? 'supplier' : 'in_house'

  // Variant (thickness / finish) + chosen finish option.
  let variantName: string | null = null
  let variantType: string | null = null
  if (order.material_variant_id) {
    const { data: v } = await admin.from('material_variants').select('display_name, variant_type').eq('id', order.material_variant_id).maybeSingle()
    variantName = (v?.display_name as string | null) ?? null
    variantType = (v?.variant_type as string | null) ?? null
  }
  let optionName: string | null = null
  if (order.material_option_id) {
    const { data: mo } = await admin.from('material_options').select('display_name').eq('id', order.material_option_id).maybeSingle()
    optionName = (mo?.display_name as string | null) ?? null
  }

  // Letterpress colours (in-house Card line).
  let front: string | null = null, core: string | null = null, back: string | null = null
  const colourIds = [pv.front_colour_id, pv.core_colour_id, pv.back_colour_id].filter(Boolean)
  if (colourIds.length) {
    const { data: cols } = await admin.from('letterpress_core_colours').select('id, name').in('id', colourIds)
    const byId = new Map((cols ?? []).map((c: { id: string; name: string }) => [c.id, c.name]))
    front = (pv.front_colour_id && byId.get(pv.front_colour_id)) || null
    core = (pv.core_colour_id && byId.get(pv.core_colour_id)) || null
    back = (pv.back_colour_id && byId.get(pv.back_colour_id)) || null
  }

  // Quantity (+ per-person split).
  const rawSplit = Array.isArray(order.person_quantities) ? order.person_quantities : []
  const split = rawSplit.filter((p: { name?: unknown; quantity?: unknown }) => p && typeof p.name === 'string' && p.name.trim() && Number.isFinite(Number(p.quantity)) && Number(p.quantity) > 0)
  let qty: number
  const splitLines: string[] = []
  if (split.length >= 2) {
    qty = split.reduce((s: number, p: { quantity: unknown }) => s + Number(p.quantity), 0)
    for (const p of split) splitLines.push(`${(p.name as string).trim()} — ${Number(p.quantity)}`)
  } else {
    qty = Number(order.quantity ?? 0)
  }
  if (!Number.isFinite(qty) || qty <= 0) return json({ ok: false, error: 'This order has no fixed quantity to place.' }, 400)

  const inks = buildInks(pv.ink_names)
  const destCountry = String(order.ship_dest_country ?? (order.ship_to_address as { country?: string | null } | null)?.country ?? '').trim().toUpperCase()
  const packaging = destCountry ? (destCountry === 'GB' ? 'Domestic' : 'International') : null
  const dateRequiredStr = fmtDate(order.date_required)

  // Shared spec summary for the review page (same data the hand-off uses).
  const summary = {
    customer: customerName,
    material: mat.display_name,
    variant: variantName,
    finish: optionName ?? (variantType === 'finish' ? variantName : null),
    inkFront: inks.front,
    inkBack: inks.back,
    quantity: qty,
    split: splitLines,
    packaging,
    dateRequired: dateRequiredStr,
    dropboxFolderUrl: order.dropbox_folder_url ?? null,
    route,
  }

  // ── IN-HOUSE ──────────────────────────────────────────────────────────────
  if (route === 'in_house') {
    const card = buildCardLine(mat.code, pv.material_display, pv.material_options, front, core, back)
    const lines: string[] = [`Qty: ${qty}`, `Card: ${card}`]
    if (dateRequiredStr) lines.push(`Date required: ${dateRequiredStr}`)
    if (inks.front) lines.push(`Ink on front: ${inks.front}`)
    if (inks.back) lines.push(`Ink on back: ${inks.back}`)
    if (packaging) lines.push(`Packaging: ${packaging}`)
    for (const sl of splitLines) lines.push(sl)
    // Belt-and-braces: the link is in the note too, so anything not attached
    // (too big / not artwork) is still reachable from the job card.
    if (order.dropbox_folder_url) lines.push(`Artwork: ${order.dropbox_folder_url}`)
    const subject = `Order ${String(order.stock_order_number).trim()} - ${String(order.project_name ?? customerName).trim()}`.replace(/\s-\s*$/, '').trim()

    // Plan the artwork attachments from the Dropbox folder (best-effort: a
    // listing failure just means no attachments — the note + link still go).
    let artworkPlan: ArtworkPlan = { attach: [], skipped: [] }
    let toFetch: { name: string; path: string; mime: string }[] = []
    let dbxToken: string | null = null
    if (order.dropbox_folder_url) {
      try {
        dbxToken = await getDropboxAccessToken(admin)
        if (dbxToken) {
          const planned = planArtwork(await listSharedLinkEntries(dbxToken, order.dropbox_folder_url))
          artworkPlan = planned.plan
          toFetch = planned.toFetch
        }
      } catch { /* best-effort */ }
    }

    if (mode === 'preview') {
      return json({ ok: true, route, subject, note_lines: lines, summary, helpscout_linked: !!conversationId, artwork_plan: artworkPlan })
    }

    // confirm
    if (!conversationId) return json({ ok: false, error: 'This proof has no linked Help Scout conversation, so the production note can’t be posted.' }, 400)
    const appId = Deno.env.get('HELPSCOUT_APP_ID')?.trim()
    const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')?.trim()
    if (!appId || !appSecret) return json({ ok: false, error: 'Help Scout credentials not configured.' }, 500)
    const userId = await resolveUserId(admin, callerId)
    if (userId == null) return json({ ok: false, error: 'No Help Scout author id available (set HELPSCOUT_DEFAULT_USER_ID).' }, 500)
    try {
      const token = await getAccessToken(appId, appSecret)
      await setConversationSubject(token, conversationId, subject)
      // Download + attach the prepped artwork. Best-effort: if a download fails
      // we still post the note (with whatever attached) + the Dropbox link.
      let attachments: { fileName: string; mimeType: string; data: string }[] = []
      if (dbxToken && toFetch.length && order.dropbox_folder_url) {
        try {
          attachments = await buildArtworkAttachments(dbxToken, order.dropbox_folder_url, toFetch)
        } catch { /* best-effort: post the note without attachments */ }
      }
      await createNote(token, conversationId, userId, lines.join('<br>'), attachments)
    } catch (e) {
      if (e instanceof HsError) return json({ ok: false, error: `Help Scout: ${e.message}` }, 502)
      return json({ ok: false, error: `Hand-off failed: ${(e as Error)?.message ?? 'unknown'}` }, 502)
    }
    const placed = await markPlaced(admin, orderId, callerId, { route, subject })
    if (!placed.ok) {
      // The note WAS posted to Help Scout, but the status flip failed. Surface a
      // distinct error so the UI does NOT offer a plain retry (which would re-post
      // the note); the human marks the order placed manually instead.
      await logPlaceMishap(admin, orderId, callerId, { route, subject, error: placed.error })
      return json({ ok: false, code: 'sent_not_recorded', error: `The production note was posted to Help Scout, but the order status couldn’t be updated (${placed.error}). Do NOT place it again — mark this order placed manually.` }, 500)
    }
    return json({ ok: true, route, placed: true })
  }

  // ── SUPPLIER ──────────────────────────────────────────────────────────────
  // Active suppliers from Stock Control (public schema).
  const { data: supRows } = await pub
    .from('outsourced_suppliers')
    .select('id, name, email_addresses, is_international, default_shipping_days, active')
    .eq('active', true)
  const suppliers: SupplierRow[] = (supRows ?? []).map((s: { id: string; name: string; email_addresses: string[] | null; is_international: boolean; default_shipping_days: number | null }) => ({
    id: s.id,
    name: s.name,
    email: Array.isArray(s.email_addresses) && s.email_addresses.length ? s.email_addresses[0] : null,
    is_international: !!s.is_international,
    default_shipping_days: s.default_shipping_days,
  }))

  const defaultName = defaultSupplierName(mat.code)
  const chosen =
    (supplierIdOverride && suppliers.find((s) => s.id === supplierIdOverride)) ||
    suppliers.find((s) => s.name === defaultName) ||
    suppliers[0] ||
    null
  if (!chosen) return json({ ok: false, error: 'No active suppliers are configured.' }, 400)

  // Must ship by = date required − the supplier's shipping (transit) days.
  const dr = new Date(order.date_required as string)
  const shipDays = Number(chosen.default_shipping_days ?? 0)
  const shipBy = new Date(dr)
  if (Number.isFinite(shipDays) && shipDays > 0) shipBy.setDate(shipBy.getDate() - shipDays)
  const shipByIso = isoDate(shipBy)
  const shipByStr = fmtDate(shipByIso)

  const productType = productTypeFor(mat.code)
  const thickness = variantType === 'thickness' ? variantName : null
  const finish = optionName ?? (variantType === 'finish' ? variantName : null)

  const emailLines: string[] = ['Hi,', '', `Please produce the following order for ${customerName}:`, '', `Qty: ${qty}`]
  if (productType) emailLines.push(`Material: ${productType}`)
  if (thickness) emailLines.push(`Thickness: ${thickness}`)
  if (finish) emailLines.push(`Finish: ${finish}`)
  if (shipByStr) emailLines.push(`Must ship by: ${shipByStr}`)
  if (order.dropbox_folder_url) emailLines.push('', `Artwork: ${order.dropbox_folder_url}`)
  emailLines.push('', 'Many thanks.')
  const subject = `Order ${String(order.stock_order_number).trim()} - ${customerName}`

  if (mode === 'preview') {
    return json({
      ok: true,
      route,
      subject,
      email_lines: emailLines,
      supplier: chosen,
      suppliers,
      ship_by: shipByStr,
      summary,
    })
  }

  // confirm
  if (!chosen.email) return json({ ok: false, error: `${chosen.name} has no email address configured in Stock Control.` }, 400)
  const appId = Deno.env.get('HELPSCOUT_APP_ID')?.trim()
  const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')?.trim()
  if (!appId || !appSecret) return json({ ok: false, error: 'Help Scout credentials not configured.' }, 500)
  const userId = await resolveUserId(admin, callerId)
  if (userId == null) return json({ ok: false, error: 'No Help Scout author id available (set HELPSCOUT_DEFAULT_USER_ID).' }, 500)
  let newConvId: string | null = null
  try {
    const token = await getAccessToken(appId, appSecret)
    // Send from the proof's mailbox; fall back to the env default if unset.
    let mailboxId: number | null = conversationId ? await fetchMailboxId(token, conversationId) : null
    if (mailboxId == null) {
      const envMb = Number(Deno.env.get('HELPSCOUT_MAILBOX_ID') ?? '')
      mailboxId = Number.isInteger(envMb) && envMb > 0 ? envMb : null
    }
    if (mailboxId == null) return json({ ok: false, error: 'Could not resolve a Help Scout mailbox to send from.' }, 502)
    newConvId = await createSupplierConversation(token, {
      mailboxId,
      subject,
      supplierEmail: chosen.email,
      userId,
      text: emailLines.join('<br>'),
    })
  } catch (e) {
    if (e instanceof HsError) return json({ ok: false, error: `Help Scout: ${e.message}` }, 502)
    return json({ ok: false, error: `Hand-off failed: ${(e as Error)?.message ?? 'unknown'}` }, 502)
  }
  const placed = await markPlaced(admin, orderId, callerId, {
    route,
    subject,
    supplier_id: chosen.id,
    supplier_name: chosen.name,
    supplier_helpscout_conversation_id: newConvId,
  })
  if (!placed.ok) {
    // The supplier email WAS sent; only the status flip failed. Distinct error so
    // the UI won't re-send — the order is placed, it just needs recording manually.
    await logPlaceMishap(admin, orderId, callerId, { route, subject, supplier_name: chosen.name, supplier_helpscout_conversation_id: newConvId, error: placed.error })
    return json({ ok: false, code: 'sent_not_recorded', error: `The order was emailed to ${chosen.name}, but the order status couldn’t be updated (${placed.error}). Do NOT send it again — mark this order placed manually.` }, 500)
  }
  return json({ ok: true, route, placed: true, supplier: chosen.name })
})

// Resolve the authoring Help Scout staff id: caller's mapping, else the default.
async function resolveUserId(admin: SupabaseClient, callerId: string): Promise<number | null> {
  const { data: pr } = await admin.from('profiles').select('helpscout_user_id').eq('id', callerId).single()
  const v = (pr as { helpscout_user_id: number | null } | null)?.helpscout_user_id ?? null
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v
  const parsed = Number(Deno.env.get('HELPSCOUT_DEFAULT_USER_ID') ?? '')
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

// Flip the order to placed ('fulfilled') + record supplier details + audit.
// Returns { ok:false } when the flip didn't land (DB error, or the row was no
// longer 'paid') so the caller can surface a "sent but not recorded" error
// instead of falsely reporting success — the bug this guards against is a
// swallowed flip failure leaving the order in 'paid' and re-placeable, which
// re-sends the whole hand-off into production.
async function markPlaced(
  admin: SupabaseClient,
  orderId: string,
  callerId: string,
  detail: { route: string; subject: string; supplier_id?: string; supplier_name?: string; supplier_helpscout_conversation_id?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const nowIso = new Date().toISOString()
  // Conditional on status='paid' so a stale/concurrent re-entry can't re-flip;
  // .select() so we can confirm exactly one row actually moved paid→fulfilled.
  const { data, error } = await admin
    .from('orders')
    .update({
      status: 'fulfilled',
      fulfilled_at: nowIso,
      fulfilled_by: callerId,
      ...(detail.supplier_id ? { supplier_id: detail.supplier_id } : {}),
      ...(detail.supplier_name ? { supplier_name: detail.supplier_name } : {}),
      ...(detail.supplier_helpscout_conversation_id ? { supplier_helpscout_conversation_id: detail.supplier_helpscout_conversation_id } : {}),
      updated_at: nowIso,
    })
    .eq('id', orderId)
    .eq('status', 'paid')
    .select('id')
  if (error) return { ok: false, error: error.message }
  if (!data || data.length === 0) return { ok: false, error: 'order was no longer in the paid state' }
  await admin.from('audit_log').insert({
    actor_id: callerId,
    action: 'order.placed',
    target_type: 'order',
    target_id: orderId,
    target_label: `Order ${orderId}`,
    after_value: detail,
  }).then(undefined, () => {})
  return { ok: true }
}

// Record a "hand-off sent but status not updated" event so an order that was
// actually placed but is stuck in 'paid' leaves a trail to reconcile from.
async function logPlaceMishap(
  admin: SupabaseClient,
  orderId: string,
  callerId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await admin.from('audit_log').insert({
    actor_id: callerId,
    action: 'order.place_sent_not_recorded',
    target_type: 'order',
    target_id: orderId,
    target_label: `Order ${orderId}`,
    after_value: detail,
  }).then(undefined, () => {})
}
