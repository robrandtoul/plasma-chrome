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
import { buildOrderSpecSnapshot, type OrderSpecSnapshot } from '../_shared/orderSpecSnapshot.ts'
import { buildHandoffPayload } from '../_shared/orderHandoff.ts'

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
  opts: { mailboxId: number; subject: string; supplierEmail: string; userId: number; text: string; attachments?: { fileName: string; mimeType: string; data: string }[] },
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
      // Attachments ride on the reply thread (same shape as the in-house note).
      threads: [{ type: 'reply', customer: { email: opts.supplierEmail }, user: opts.userId, text: opts.text, ...(opts.attachments && opts.attachments.length ? { attachments: opts.attachments } : {}) }],
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

// Turn a plain-text message into the Help Scout body. Help Scout treats the
// note/reply `text` as HTML, so newlines become <br>. Stray angle brackets in
// the (now freely-editable) message are escaped so "< 2mm" renders literally
// rather than being eaten as a tag; `&` is left alone so the Dropbox link's
// query string (?rlkey=…&dl=0) keeps working exactly as the generated text did.
// The spec-line safety check below runs on the raw text, but that's sound: the
// machine-read lines never contain <,> or & (Qty/dates/catalogue names/URLs), so
// htmlify can't alter the bytes a Stock Control ingester actually parses.
function htmlifyMessage(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replaceAll('\n', '<br>')
}

// Lines a Stock Control ingester reads off the hand-off. Used to vet a freely-
// edited message before it's sent. The ingester is first-wins per key and
// ignores unknown lines, so two failure modes must be caught: a genuine spec
// line was DROPPED, or an extra line was ADDED that the parser could mistake for
// one (a conflicting duplicate key it would read FIRST, or a stray "name — 50"
// split line that breaks the per-person sum). Substring matching is unsound
// here (deleting "Qty: 50" passes if "Qty: 500" appears anywhere), so this works
// on whole, trimmed lines. KEEP IN LOCKSTEP with the same helper + regexes in
// src/pages/OrderReviewPage.tsx (client mirror for instant feedback).
const SPEC_KEY_RE = /^(Qty|Card|Material|Type|Thickness|Finish|Date required|Must ship by|Packaging|Per person|Ink on front|Ink on back|Artwork)\s*:/i
const SPLIT_SHAPE_RE = /^.+?\s*[—–:-]\s*\d{1,6}$/
function checkEditedMessage(customMessage: string, criticalLines: string[]): string[] {
  const problems: string[] = []
  const msgLines = customMessage.split('\n').map((l) => l.trim())
  const present = new Set(msgLines)
  const critical = new Set(criticalLines.map((l) => l.trim()))
  // 1. Every machine-read spec line must still be present, whole and verbatim.
  for (const l of criticalLines) {
    if (!present.has(l.trim())) problems.push(`Missing required line: "${l.trim()}"`)
  }
  // 2. No ADDED line may look like a spec line the parser would act on.
  for (const l of msgLines) {
    if (!l || critical.has(l)) continue
    if (SPEC_KEY_RE.test(l) || SPLIT_SHAPE_RE.test(l)) problems.push(`Stock Control may misread this line: "${l}"`)
  }
  return problems
}

// In-house Card line for Stock Control's forgiving material match.
function buildCardLine(code: string, materialDisplay: string | null, options: unknown, front: string | null, core: string | null, back: string | null, stockColour: string | null): string {
  if (code === 'paper_letterpress' || code === 'paper_letterpress_gilded') {
    // Gilding rides on the Card line, NOT a "Finish:" line — Stock Control's
    // in-house parser has no Finish field, so it preserves the Card value
    // verbatim onto the job card but drops unknown lines. The " + gilding"
    // suffix sits OUTSIDE the brackets, so parseLetterpressColours (which reads
    // only the first parenthesis group) still gets the colour trio, and the
    // combo resolves off the colours regardless.
    const gild = code === 'paper_letterpress_gilded' ? ' + gilding' : ''
    if (front && core && back) {
      // Strip the "(default …)" suffix so a colour's OWN parentheses don't nest
      // inside the "Letterpress (a, b, c)" brackets. Stock Control's parser
      // captures only the first parenthesis group, so a default colour like
      // "Ebony (default black)" would otherwise be read as a single malformed
      // colour and bounce the whole order (the two default colours are in 14 of
      // the 16 letterpress combos — the commonest case). The combo resolver
      // strips the same suffix, so the trio still resolves to the right combo.
      const plain = (c: string) => c.replace(/\s*\(\s*default[^)]*\)/gi, '').trim()
      return `Letterpress (${plain(front)}, ${plain(core)}, ${plain(back)})${gild}`
    }
    return `Letterpress${gild}`
  }
  if (code === 'wood') {
    const species = Array.isArray(options) && options.length ? String(options[0]) : ''
    return species ? titleCaseCode(species) : (materialDisplay || 'Wood')
  }
  if (code === 'plastic_translucent') return 'Translucent Plastic'
  // Satin / tinted / acrylic carry no colour on the proof (it isn't a price
  // factor), so the specific stock colour is captured at order time and emitted
  // here verbatim — the exact Stock Control material name its in-house parser
  // resolves against. Falls back to the generic material name when unset.
  if (stockColour && stockColour.trim()) return stockColour.trim()
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

// Neutralise any note line shaped like a per-person split entry ("name — 50")
// so Stock Control's detectSplit (which scans the whole note and validates the
// counts sum to the quantity) can't fold a note line into — or break — the real
// split. Append a full stop so the line no longer ends in digits. Same shape as
// the deployed detectSplit regex.
function sanitiseInhouseNote(note: string): string {
  return note.split('\n').map((line) =>
    /^\s*.+?\s*[—–:-]\s*\d{1,6}\s*$/.test(line) ? `${line.replace(/\s+$/, '')}.` : line,
  ).join('\n')
}

// ── Artwork attachments (in-house) ──────────────────────────────────────────
// Stock Control's in-house ingester mirrors the production note's attachments
// onto the job card, so we attach the prepped Dropbox files to the note — the
// automated version of the manual "attach the files" step. Help Scout caps an
// attachment at 10 MB; larger / non-artwork files are skipped but stay reachable
// via the Dropbox link in the note.
const HS_ATTACH_MAX_BYTES = 10 * 1024 * 1024
const ARTWORK_TOTAL_MAX_BYTES = 20 * 1024 * 1024
// 30 (not 10) so a multi-material Set order — one subfolder per material, easily
// 20+ files across them — doesn't fill the quota inside the first subfolder and
// silently drop whole materials (see Order 403822 / OpusApeiro). ARTWORK_TOTAL_MAX_BYTES
// is still the backstop for very large folders.
const ARTWORK_MAX_FILES = 30

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

// When a folder holds more artwork than the caps below allow, production needs
// the print-ready files (PDF / AI / EPS) far more than the low-res proof-preview
// JPEGs. Rank print-ready formats first so, if the count or byte budget bites,
// it drops previews rather than the files the printer actually works from.
function artworkPriority(name: string): number {
  return /\.(pdf|ai|eps)$/i.test(name) ? 0 : 1
}

interface FolderEntry { name: string; is_folder: boolean; path: string; size: number }
type ArtworkPlan = { attach: string[]; skipped: { name: string; reason: string }[] }

// Decide which folder files we'll attach (by type + size) WITHOUT downloading —
// used for the preview and to drive the confirm download.
function planArtwork(entries: FolderEntry[]): { plan: ArtworkPlan; toFetch: { name: string; path: string; mime: string }[] } {
  const plan: ArtworkPlan = { attach: [], skipped: [] }
  const toFetch: { name: string; path: string; mime: string }[] = []
  // Print-ready files first, then previews. V8's sort is stable, so each group
  // keeps its original folder order; the caps below then bite previews last.
  const ordered = [...entries].sort((a, b) => artworkPriority(a.name) - artworkPriority(b.name))
  for (const e of ordered) {
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

// Legacy fallback only (the per-material routing now lives in
// proofs.materials.outsourced_supplier_ids, admin-editable). Suppliers (by exact
// Stock Control name) that may be ordered from for a material — metal/carbon →
// QX only; full-colour plastic → QX or Swype; standard paper → Solopress only.
// Used only when a material has no configured supplier ids yet. A metal
// order can't be sent to Solopress etc. null = unmapped material → no scope
// (show all active, defensive). First entry is the default selection.
function allowedSupplierNames(code: string): string[] | null {
  if (code.startsWith('metal_') || code === 'carbon_fibre' || code === 'carbon_fibre_cnc') return ['QX Metals']
  if (code === 'plastic_full_colour') return ['QX Metals', 'Swype']
  if (code === 'paper_standard') return ['Solopress']
  return null
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

// Render the admin-editable supplier-order email. Each supplier may have its own
// template (proofs.reply_templates id 'supplier_order_email:<supplier_id>'); if
// it has none, the shared default ('supplier_order_email') is used, then the
// built-in constant. Only {customer} + {order_details} are substituted;
// {order_details} is the machine-generated, parser-critical spec block, so the
// admin only edits the prose around it.
const SUPPLIER_EMAIL_DEFAULT = 'Hi,\n\nPlease produce the following order for {customer}:\n\n{order_details}\n\nMany thanks.'
async function renderSupplierEmail(admin: SupabaseClient, supplierId: string | null, vars: { customer: string; order_details: string }): Promise<string> {
  // Most-specific first: the chosen supplier's own template, then the shared one.
  const ids = supplierId ? [`supplier_order_email:${supplierId}`, 'supplier_order_email'] : ['supplier_order_email']
  let body = SUPPLIER_EMAIL_DEFAULT
  try {
    const { data } = await admin.from('reply_templates').select('id, body').in('id', ids)
    const byId = new Map((data ?? []).map((r: { id: string; body: string }) => [r.id, r.body]))
    for (const id of ids) {
      const b = byId.get(id)
      // Require {order_details}: a template saved without it (somehow bypassing
      // the admin UI guard) would drop the parser-critical spec block and the
      // order would silently never import. Skip such a body and fall back.
      if (typeof b === 'string' && b.trim() && b.includes('{order_details}')) { body = b; break }
    }
  } catch { /* fall back to the default */ }
  return body.replaceAll('{customer}', vars.customer).replaceAll('{order_details}', vars.order_details)
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
  // Optional per-order note from the review page (supplier route): project-
  // specific instructions appended AFTER the machine-readable spec so the
  // outsourced parser (which first-wins on Qty/Material/… and ignores unknown
  // lines) can't be thrown off by it.
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : ''
  // Optional fully-edited message from the review page (confirm only). When set,
  // it REPLACES the composed hand-off verbatim — the reviewer owns the text. The
  // machine-read spec lines are re-derived below and checked against it before
  // anything is sent, so an edit can't silently break the Stock Control import.
  // Trimmed (so leading/trailing whitespace can't reach the wire or skew the
  // line check) and capped. A present-but-blank value is an explicit error on
  // confirm (below), NOT a silent fall-back to the composed text.
  const customMessageRaw = typeof body.custom_message === 'string' ? body.custom_message : null
  const customMessage = customMessageRaw && customMessageRaw.trim() ? customMessageRaw.trim().slice(0, 10000) : null
  // Re-place attestation (revision flow): when a previously-PLACED order is
  // re-placed after a redesign, the OLD Stock Control job must be cancelled by a
  // human first — proof-viewer can't do it. The review page sends this ack.
  const oldJobCancelled = body.old_job_cancelled === true
  // Spoilage overs (hybrid orders): extra cards added to the SUPPLIER order only,
  // to cover foiling done in-house after the supplier makes the base cards. Set
  // manually on the review screen (no automatic default). Pads the supplier
  // `Qty:` line; the customer's quantity — their invoice AND the in-house
  // finishing target — is unchanged. Ignored on the in-house route. Clamped to a
  // sane non-negative integer so a stray value can't distort the order.
  const supplierOvers = Math.min(1_000_000, Math.max(0, Math.floor(Number(body.supplier_overs) || 0)))
  if (!orderId) return json({ ok: false, error: 'order_id is required' }, 400)
  // Present-but-blank edited message = the reviewer cleared it; that's an error,
  // not a request to send the composed text they can no longer see.
  if (mode === 'confirm' && customMessageRaw != null && !customMessage) {
    return json({ ok: false, code: 'spec_check_failed', error: 'The hand-off message is empty — type the message or reset it.' }, 400)
  }

  // ── Load order + proof + current version ──────────────────────────────────
  const { data: order, error: orderErr } = await admin
    .from('orders')
    .select('id, status, quantity, person_quantities, has_personalisation, custom_quote_total, order_kind, date_required, stock_order_number, project_name, stock_colour, proof_id, ship_dest_country, ship_to_address, material_id, material_variant_id, material_option_id, dropbox_folder_url, payment_reference, currency, fulfilled_at, handoff_at, production_note_posted_at, supplier_email_sent_at, supplier_helpscout_conversation_id')
    .eq('id', orderId)
    .maybeSingle()
  if (orderErr) return json({ ok: false, error: `Order lookup failed: ${orderErr.message}` }, 500)
  if (!order) return json({ ok: false, error: 'Order not found.' }, 404)

  // Read the rollout mode BEFORE any of the gates below — the message-retry
  // state is a live-mode concept, and if the setting is ever rolled back to
  // shadow/off those gates must behave exactly as they did pre-Phase-2.
  const handoffMode = await loadHandoffMode(admin)

  // MESSAGE RETRY (live mode only). Phase 2 writes the Stock Control job before
  // sending the human note/email, so a send failure leaves a placed order whose
  // message never went. Confirming again is the retry — and it is safe because
  // create_order_handoff is idempotent on `handoff_at` (a second call returns
  // already_imported without writing), so the re-run only re-sends the message.
  // Allowed ONLY in that exact state: fulfilled + the job exists + at least one
  // send stamp still missing. The route-specific check happens once the route is
  // known (a supplier order never has production_note_posted_at, and vice versa,
  // so the precise test can't be made here). See docs/order-handoff-spec.md §3.4.
  const isMessageRetryCandidate = handoffMode === 'live' &&
    order.status === 'fulfilled' &&
    !!order.handoff_at &&
    (!order.production_note_posted_at || !order.supplier_email_sent_at)
  if (order.status !== 'paid' && order.status !== 'revision' && !isMessageRetryCandidate) {
    return json({ ok: false, error: `Order is ${order.status}, not paid — it can't be placed.` }, 409)
  }
  // A non-null fulfilled_at means this order already had a Stock Control job
  // (scenario 4: paid AND placed, then revised). Re-placing requires the
  // designer to confirm they've cancelled that old job. A first-ever placement
  // (fulfilled_at null, incl. scenario 3) needs no ack. Enforced on confirm only
  // so the review screen can still preview a re-place. A message retry is NOT a
  // re-place — the job it would duplicate is the one this order already owns —
  // so it must never demand the cancel attestation.
  const isReplace = !!order.fulfilled_at && !isMessageRetryCandidate
  if (mode === 'confirm' && isReplace && !oldJobCancelled) {
    return json({ ok: false, code: 'old_job_not_cancelled', error: 'Cancel the old Stock Control job first, then confirm the re-place.' }, 409)
  }
  if (!order.stock_order_number) return json({ ok: false, error: 'Link and check the Dropbox order folder first (no order number).' }, 400)
  if (!order.date_required) return json({ ok: false, error: 'Set the date required first.' }, 400)

  // Artwork sanity check — the mandatory-RUN gate (docs/artwork-check-spec.md).
  // When settings.artwork_check_required is on (and the check is live), an
  // order can't be confirmed until the check has run for it — the server-side
  // mirror of the review page's blockReason clause, so a direct API call can't
  // bypass the UI gate. Only RUNNING is mandatory: any verdict (clear, flagged,
  // even error) satisfies it — the human adjudicates flags on the review page.
  // The artwork_checked_at read is a separate query so the main order select
  // stays free of 000336 columns (pre-migration deploy safety).
  // Skipped on a message retry: the job is already IN production, so this is a
  // "send the message" action, not a placement decision. Re-gating it would
  // strand a placed order with its workshop/supplier never told (e.g. the proof
  // was reopened for a tweak between the failed send and the retry).
  if (mode === 'confirm' && !isMessageRetryCandidate && await loadArtworkCheckGate(admin)) {
    const { data: chk } = await admin.from('orders').select('artwork_checked_at').eq('id', orderId).maybeSingle()
    if (!(chk as { artwork_checked_at: string | null } | null)?.artwork_checked_at) {
      return json({ ok: false, code: 'artwork_check_required', error: 'Run the artwork check before placing this order.' }, 409)
    }
  }

  const { data: proof } = await admin
    .from('proofs')
    .select('id, status, helpscout_conversation_id, contacts:contact_id ( full_name, email, companies:company_id ( name ) )')
    .eq('id', order.proof_id)
    .maybeSingle()
  // The proof must be approved to place. Always true for a first placement; the
  // gate matters for a revision re-place — after a reopen the proof goes back to
  // in_progress with approvals cleared, so this blocks handing off artwork that
  // hasn't been re-approved. Confirm only, so the review screen can still preview.
  const proofStatus = (proof as { status?: string | null } | null)?.status ?? null
  // Skipped on a message retry — see the artwork-check gate above. The approval
  // gate protects the decision to hand artwork to production; that decision was
  // already taken and executed, and the message is chasing it.
  if (mode === 'confirm' && !isMessageRetryCandidate && proofStatus !== 'approved') {
    return json({ ok: false, error: "The proof isn't approved — re-approve it before placing this order." }, 409)
  }
  const conversationId = (proof as { helpscout_conversation_id: string | null } | null)?.helpscout_conversation_id ?? null
  const contact = (proof as { contacts?: { full_name?: string | null; email?: string | null; companies?: { name?: string | null } | null } | null } | null)?.contacts ?? null
  const customerName = (contact?.companies?.name?.trim()) || (contact?.full_name?.trim()) || (order.project_name?.trim()) || 'Customer'

  // The order carries its OWN material (material_id), copied from the version it
  // was placed against. A proof can hold versions of DIFFERENT materials (e.g. v1
  // steel, v2 letterpress), so the version to read — and the production route —
  // must follow the ORDER's material, NOT blindly the current version. This
  // mirrors the Orders page (OrdersPage.tsx routeOf / thumbForOrder), which
  // already keys off the order's material. Without this, a metal order on a proof
  // whose current version is letterpress reads the letterpress spec and routes
  // in-house instead of to the metal supplier (PV — Novion Order 403868).
  type VersionRow = {
    id: string
    version_number: number
    is_current: boolean
    material_id: string | null
    material_display: string | null
    ink_names: unknown
    material_options: unknown
    front_colour_id: string | null
    core_colour_id: string | null
    back_colour_id: string | null
    materials: { code: string; display_name: string | null; production_route: string | null; outsourced_product_type: string | null; outsourced_supplier_ids: string[] | null } | null
  }
  const orderMaterialId = (order as { material_id: string | null }).material_id ?? null
  const { data: versionRows } = await admin
    .from('proof_versions')
    .select('id, version_number, is_current, material_id, material_display, ink_names, material_options, front_colour_id, core_colour_id, back_colour_id, materials(code, display_name, production_route, outsourced_product_type, outsourced_supplier_ids)')
    .eq('proof_id', order.proof_id)
    .order('version_number', { ascending: false })
  const allVersions = (versionRows ?? []) as VersionRow[]
  const currentVersion = allVersions.find((v) => v.is_current) ?? null
  const materialMatches = orderMaterialId ? allVersions.filter((v) => v.material_id === orderMaterialId) : []
  // Prefer the current version when it carries the order's material (the common
  // single-material case → identical to the old behaviour); else the latest
  // version that does; else the current version (legacy orders with no
  // material_id, or nothing matching).
  const pv = materialMatches.find((v) => v.is_current) ?? materialMatches[0] ?? currentVersion
  if (!pv) return json({ ok: false, error: 'No proof version found.' }, 404)

  // Material identity + production route come from the ORDER's material. When the
  // chosen version already IS the order's material (the normal path) that's just
  // pv.materials; only when they diverge (or pv has no single material) do we load
  // the order's material directly — so route / supplier / product-type always
  // match the order the Orders page showed, never a superseded version's material.
  let mat = pv.materials
  if (orderMaterialId && (!mat || pv.material_id !== orderMaterialId)) {
    const { data: m } = await admin
      .from('materials')
      .select('code, display_name, production_route, outsourced_product_type, outsourced_supplier_ids')
      .eq('id', orderMaterialId)
      .maybeSingle()
    if (m) mat = m as VersionRow['materials']
  }
  if (!mat) return json({ ok: false, error: 'This order has no single material (mixed / variant round) — place it manually.' }, 400)
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

  // A prototype is a flat-fee sample run (up to three exact copies of the
  // approved design), not a production run — flag it loudly on the hand-off so
  // production makes the samples, not the full quantity.
  const isPrototype = order.order_kind === 'prototype'
  const prototypeMarker = `PROTOTYPE SAMPLE — up to ${qty} exact ${qty === 1 ? 'copy' : 'copies'}, NOT a production run.`

  const inks = buildInks(pv.ink_names)

  // Durable spec snapshot (Order log Phase 2). Rebuilt from the spec we just
  // read live + OVERWRITTEN on every placement (first place AND a revision
  // re-place), so it reflects the exact spec handed to production — which is the
  // record the order log should keep. Same builder as create-order so the two
  // writers can't drift. Stamped inside markPlaced, only once the hand-off sends.
  const orderSpecSnapshot = buildOrderSpecSnapshot({
    materialCode: mat.code ?? null,
    materialDisplay: mat.display_name ?? pv.material_display ?? null,
    variantDisplay: variantName,
    variantType,
    optionDisplay: optionName,
    inkNames: (pv.ink_names as string[] | null) ?? null,
    letterpressFront: front,
    letterpressCore: core,
    letterpressBack: back,
    quantity: qty,
    personQuantities: (order.person_quantities as { name: string; quantity: number }[] | null) ?? null,
    hasPersonalisation: order.has_personalisation === true,
    customQuoteTotal: order.custom_quote_total != null ? Number(order.custom_quote_total) : null,
    contactEmail: contact?.email ?? null,
    contactName: contact?.full_name ?? null,
    companyName: contact?.companies?.name ?? null,
    stage: 'place',
    capturedBy: callerId,
    capturedAt: new Date().toISOString(),
  })

  const destCountry = String(order.ship_dest_country ?? (order.ship_to_address as { country?: string | null } | null)?.country ?? '').trim().toUpperCase()
  const packaging = destCountry ? (destCountry === 'GB' ? 'Domestic' : 'International') : null
  const dateRequiredStr = fmtDate(order.date_required)

  // Supplier quantity = customer quantity + spoilage overs, but ONLY on the
  // supplier route (overs are meaningless for an in-house job). This is the
  // number the supplier is told to make; `qty` stays the customer's quantity
  // everywhere else (invoice, in-house finishing target, per-person split).
  const supplierQty = route === 'supplier' ? qty + supplierOvers : qty

  // Shared spec summary for the review page (same data the hand-off uses).
  const summary = {
    customer: customerName,
    material: mat.display_name,
    variant: variantName,
    finish: optionName ?? (variantType === 'finish' ? variantName : null),
    inkFront: inks.front,
    inkBack: inks.back,
    quantity: qty,
    supplierQuantity: supplierQty,
    supplierOvers,
    split: splitLines,
    packaging,
    dateRequired: dateRequiredStr,
    dropboxFolderUrl: order.dropbox_folder_url ?? null,
    route,
    prototype: isPrototype,
  }

  // ── IN-HOUSE ──────────────────────────────────────────────────────────────
  if (route === 'in_house') {
    const card = buildCardLine(mat.code, pv.material_display, pv.material_options, front, core, back, (order.stock_colour as string | null) ?? null)
    const lines: string[] = []
    if (isPrototype) lines.push(prototypeMarker)
    lines.push(`Qty: ${qty}`, `Card: ${card}`)
    if (dateRequiredStr) lines.push(`Date required: ${dateRequiredStr}`)
    if (inks.front) lines.push(`Ink on front: ${inks.front}`)
    if (inks.back) lines.push(`Ink on back: ${inks.back}`)
    if (packaging) lines.push(`Packaging: ${packaging}`)
    for (const sl of splitLines) lines.push(sl)
    // Belt-and-braces: the link is in the note too, so anything not attached
    // (too big / not artwork) is still reachable from the job card.
    if (order.dropbox_folder_url) lines.push(`Artwork: ${order.dropbox_folder_url}`)
    // The machine-read spec block, captured before the free-text note is appended
    // — this is what a fully-edited message must still contain (see customMessage).
    const criticalLines = lines.filter((l) => l.trim().length > 0)
    // Optional per-order note for the production team, AFTER the spec (so the
    // parser's first-wins fields aren't affected) and split-sanitised so a
    // "name — 50"-shaped note line can't fold into / break the real split. Skipped
    // when a custom message is supplied (the note is then typed inline instead).
    if (note && !customMessage) {
      lines.push('')
      for (const nl of sanitiseInhouseNote(note).split('\n')) lines.push(nl)
    }
    const subject = `Order ${String(order.stock_order_number).trim()} - ${String(order.project_name ?? customerName).trim()}`.replace(/\s-\s*$/, '').trim()

    // The direct hand-off contract payload (docs/order-handoff-spec.md §3.2) —
    // composed from the same values as the note so the two can't drift.
    const handoffPayload = buildHandoffPayload({
      pvOrderId: orderId,
      placedBy: callerId,
      stockOrderNumber: String(order.stock_order_number),
      route: 'in_house',
      customerName,
      projectName: (order.project_name as string | null) ?? null,
      helpscoutConversationId: conversationId ? String(conversationId) : null,
      qty,
      supplierQty: qty,
      supplierOvers: 0,
      isPrototype,
      material: {
        pvMaterialId: orderMaterialId ?? pv.material_id,
        code: mat.code,
        display: mat.display_name ?? pv.material_display ?? null,
        cardLine: card,
        letterpress: (mat.code === 'paper_letterpress' || mat.code === 'paper_letterpress_gilded') && front && core && back
          ? { front, core, back, gilding: mat.code === 'paper_letterpress_gilded' }
          : null,
      },
      supplier: null,
      dateRequired: (order.date_required as string | null) ?? null,
      inks,
      packaging,
      split: split.map((p: { name: unknown; quantity: unknown }) => ({ name: String(p.name).trim(), qty: Number(p.quantity) })),
      dropboxFolderUrl: (order.dropbox_folder_url as string | null) ?? null,
      note: note || null,
    })

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
      // Key present only when the feature is on — 'off' responses stay byte-identical.
      const handoffValidation = await runHandoffValidation(pub, handoffMode, handoffPayload)
      return json({ ok: true, route, subject, note_lines: lines, critical_lines: criticalLines, summary, helpscout_linked: !!conversationId, artwork_plan: artworkPlan, ...(handoffValidation ? { handoff_validation: handoffValidation } : {}) })
    }

    // confirm
    // A fully-edited message must still carry every machine-read spec line and
    // add none the parser could misread, or Stock Control's ingester can't read
    // the job. Reject before posting anything.
    if (customMessage) {
      const problems = checkEditedMessage(customMessage, criticalLines)
      if (problems.length) return json({ ok: false, code: 'spec_check_failed', error: `${problems.join(' | ')} — fix the flagged ${problems.length === 1 ? 'line' : 'lines'} or reset the message.` }, 400)
    }
    if (!conversationId) return json({ ok: false, error: 'This proof has no linked Help Scout conversation, so the production note can’t be posted.' }, 400)
    const appId = Deno.env.get('HELPSCOUT_APP_ID')?.trim()
    const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')?.trim()
    if (!appId || !appSecret) return json({ ok: false, error: 'Help Scout credentials not configured.' }, 500)
    const userId = await resolveUserId(admin, callerId)
    if (userId == null) return json({ ok: false, error: 'No Help Scout author id available (set HELPSCOUT_DEFAULT_USER_ID).' }, 500)

    // A retry whose message already went out has nothing left to do — guard
    // before re-posting a duplicate note.
    if (isMessageRetryCandidate && order.production_note_posted_at) {
      return json({ ok: false, error: 'This order is already placed and its production note was sent.' }, 409)
    }

    // LIVE: write the Stock Control job FIRST — one transaction that also marks
    // the order placed, so the two can never drift apart. Nothing has been sent
    // at this point, so a failure here is clean and freely retryable.
    if (handoffMode === 'live') {
      // A re-place must produce a NEW job, so drop the previous placement's
      // stamps first (see clearHandoffStampsForReplace).
      if (isReplace) {
        const cleared = await clearHandoffStampsForReplace(admin, orderId)
        if (!cleared.ok) {
          return json({ ok: false, code: 'handoff_failed', error: `Couldn’t prepare this order for re-placing (${cleared.error}). Nothing has been sent — try again.` }, 500)
        }
      }
      const wrote = await executeHandoff(pub, handoffPayload, orderSpecSnapshot)
      if (!wrote.ok) {
        await stampHandoffError(admin, orderId, wrote.error ?? 'unknown error')
        return json({ ok: false, code: 'handoff_failed', error: `Stock Control couldn’t accept this order: ${wrote.error}. Nothing has been sent — fix that and try again.` }, 400)
      }
      // Audit whenever a job was actually resolved for this order (including an
      // adopted hand-keyed job — that IS a placement); skip only the no-op
      // early return. Carries the re-place attestation, which markPlaced used to
      // record and which is the only trail behind a duplicate-job decision.
      if (!wrote.wroteNothing) {
        await auditPlaced(admin, orderId, callerId, { route, subject, sc_order_id: wrote.scOrderId, ...(isReplace ? { old_job_cancelled: oldJobCancelled } : {}) })
      }
    }

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
      await createNote(token, conversationId, userId, customMessage ? htmlifyMessage(customMessage) : lines.join('<br>'), attachments)
    } catch (e) {
      const msg = e instanceof HsError ? `Help Scout: ${e.message}` : `${(e as Error)?.message ?? 'unknown'}`
      // LIVE: the job is ALREADY in Stock Control (committed above) — only the
      // human note failed. Never report this as a failed placement, or someone
      // will place it again and duplicate the job. The Orders page keys its
      // "Send it now" retry on production_note_posted_at staying null.
      if (handoffMode === 'live') {
        await stampHandoffError(admin, orderId, `production note not sent: ${msg}`)
        return json({ ok: false, code: 'placed_message_not_sent', error: `The order is in Stock Control, but the production note couldn’t be posted (${msg}). The order IS placed — don’t place it again; use “Send it now” on the Orders page to retry the note.` }, 502)
      }
      if (e instanceof HsError) return json({ ok: false, error: `Help Scout: ${e.message}` }, 502)
      return json({ ok: false, error: `Hand-off failed: ${msg}` }, 502)
    }

    // LIVE: the RPC already flipped the order to placed, so all that's left is
    // the done-once stamp confirming the note went out.
    if (handoffMode === 'live') {
      await stampMessageSent(admin, orderId, { production_note_posted_at: new Date().toISOString() })
      return json({ ok: true, route, placed: true })
    }

    const placed = await markPlaced(admin, orderId, callerId, orderSpecSnapshot, { route, subject, ...(isReplace ? { old_job_cancelled: oldJobCancelled } : {}) })
    if (!placed.ok) {
      // The note WAS posted to Help Scout, but the status flip failed. Surface a
      // distinct error so the UI does NOT offer a plain retry (which would re-post
      // the note); the human marks the order placed manually instead.
      await logPlaceMishap(admin, orderId, callerId, { route, subject, error: placed.error })
      // The hand-off DID send, so the shadow ledger should still carry it —
      // these odd placements are exactly the ones the parity check must see.
      await recordShadowHandoff(admin, pub, handoffMode, orderId, handoffPayload)
      return json({ ok: false, code: 'sent_not_recorded', error: `The production note was posted to Help Scout, but the order status couldn’t be updated (${placed.error}). Do NOT place it again — mark this order placed manually.` }, 500)
    }
    await recordShadowHandoff(admin, pub, handoffMode, orderId, handoffPayload)
    return json({ ok: true, route, placed: true })
  }

  // ── SUPPLIER ──────────────────────────────────────────────────────────────
  // Active suppliers from Stock Control (public schema).
  const { data: supRows } = await pub
    .from('outsourced_suppliers')
    .select('id, name, email_addresses, is_international, default_shipping_days, active')
    .eq('active', true)
  // Scope to the suppliers configured for this material on Admin > Outsourcing
  // (proofs.materials.outsourced_supplier_ids), so the picker can't send to the
  // wrong one. Falls back to the legacy hard-coded routing if a material has no
  // config yet (defensive — every seeded supplier material carries it).
  const configIds = Array.isArray(mat.outsourced_supplier_ids) ? mat.outsourced_supplier_ids : []
  const legacyAllowed = allowedSupplierNames(mat.code)
  const suppliers: SupplierRow[] = (supRows ?? [])
    .filter((s: { id: string; name: string }) =>
      configIds.length > 0 ? configIds.includes(s.id) : (!legacyAllowed || legacyAllowed.includes(s.name)))
    .map((s: { id: string; name: string; email_addresses: string[] | null; is_international: boolean; default_shipping_days: number | null }) => ({
      id: s.id,
      name: s.name,
      email: Array.isArray(s.email_addresses) && s.email_addresses.length ? s.email_addresses[0] : null,
      is_international: !!s.is_international,
      default_shipping_days: s.default_shipping_days,
    }))
  if (suppliers.length === 0) return json({ ok: false, error: 'No suppliers are configured for this material — set them on Admin → Outsourcing.' }, 400)

  // No default when several suppliers are allowed: the person placing the order
  // must pick one (the review page disables Confirm until they do). A lone
  // allowed supplier is used directly. An override always wins (and is validated
  // against the allowed set, so a crafted request can't reach a disallowed one).
  const chosen =
    (supplierIdOverride ? suppliers.find((s) => s.id === supplierIdOverride) ?? null : null) ||
    (suppliers.length === 1 ? suppliers[0] : null)

  // Must ship by = date required − a shipping buffer. A supplier's configured
  // transit (default_shipping_days) wins; a DOMESTIC supplier with none set still
  // needs a working buffer — 2 days: one for the supplier to reach us, one for us
  // to reach the customer (Rob's rule, 2026-07-23) — so must-ship-by is never the
  // customer's required date itself, which left the supplier plus our own
  // finishing + delivery with zero slack (found in shadow on order 403917; Swype
  // and Solopress are both domestic with no configured transit). International
  // suppliers with no transit set stay at 0 (unchanged). Before a pick (several
  // allowed) preview against the longest window as a safe lower bound; it
  // re-resolves once the placer chooses. See docs/order-handoff-spec.md.
  const DOMESTIC_SHIP_BUFFER_DAYS = 2
  const shipBufferDays = (s: { default_shipping_days: number | null; is_international: boolean }): number => {
    const configured = Number(s.default_shipping_days ?? 0)
    if (configured > 0) return configured
    return s.is_international ? 0 : DOMESTIC_SHIP_BUFFER_DAYS
  }
  const shipDays = chosen
    ? shipBufferDays(chosen)
    : suppliers.reduce((m, s) => Math.max(m, shipBufferDays(s)), 0)
  const dr = new Date(order.date_required as string)
  const shipBy = new Date(dr)
  if (Number.isFinite(shipDays) && shipDays > 0) shipBy.setDate(shipBy.getDate() - shipDays)
  const shipByStr = fmtDate(isoDate(shipBy))

  // Material: = the coarse product type Stock Control matches on (admin-set per
  // material; legacy fallback). Type: = the specific card so the supplier knows
  // which metal/variant; skipped when it would just repeat Material:.
  const productType = (mat.outsourced_product_type ?? '').trim() || productTypeFor(mat.code)
  const thickness = variantType === 'thickness' ? variantName : null
  const finish = optionName ?? (variantType === 'finish' ? variantName : null)
  const specificType = (mat.display_name ?? '').trim() || null

  // Machine-generated, parser-critical spec block. Injected into the editable
  // supplier-email template as {order_details}. The reviewer may edit the whole
  // composed message, but the safety check (see customMessage) refuses a send
  // that dropped any of these lines, so the Stock Control import can't break.
  const detailLines: string[] = []
  if (isPrototype) detailLines.push(prototypeMarker)
  // Supplier Qty is padded with the spoilage overs. The per-person split lines
  // stay at the customer's allocation (summing to `qty`), so Qty > split sum when
  // overs are added — Stock Control's outsourced importer already tolerates this
  // (extra blanks are unallocated spares), matching how these orders look today.
  detailLines.push(`Qty: ${supplierQty}`)
  if (splitLines.length) {
    detailLines.push('Per person:')
    for (const sl of splitLines) detailLines.push(sl)
  }
  if (productType) detailLines.push(`Material: ${productType}`)
  if (specificType && specificType.toLowerCase() !== productType.toLowerCase()) detailLines.push(`Type: ${specificType}`)
  if (thickness) detailLines.push(`Thickness: ${thickness}`)
  if (finish) detailLines.push(`Finish: ${finish}`)
  if (shipByStr) detailLines.push(`Must ship by: ${shipByStr}`)
  if (order.dropbox_folder_url) detailLines.push('', `Artwork: ${order.dropbox_folder_url}`)

  // The machine-read spec block, captured before the free-text note — this is
  // what a fully-edited message must still contain (see customMessage).
  const criticalLines = detailLines.filter((l) => l.trim().length > 0)
  // Append the optional per-order note after the spec block (before the
  // template's sign-off, since it's part of {order_details}). Skipped when a
  // custom message is supplied (the note is then typed inline instead).
  const orderDetails = detailLines.join('\n') + (note && !customMessage ? `\n\n${note}` : '')
  const emailLines = (await renderSupplierEmail(admin, chosen?.id ?? null, { customer: customerName, order_details: orderDetails })).split('\n')
  const subject = `Order ${String(order.stock_order_number).trim()} - ${customerName}`

  // The direct hand-off contract payload (docs/order-handoff-spec.md §3.2) —
  // composed from the same values as the email so the two can't drift. At
  // preview time before a supplier pick, supplier_id is null and validation
  // reports "choose a supplier" — accurate, and Confirm is gated on the pick
  // anyway.
  const handoffPayload = buildHandoffPayload({
    pvOrderId: orderId,
    placedBy: callerId,
    stockOrderNumber: String(order.stock_order_number),
    route: 'supplier',
    customerName,
    projectName: (order.project_name as string | null) ?? null,
    helpscoutConversationId: conversationId ? String(conversationId) : null,
    qty,
    supplierQty,
    supplierOvers,
    isPrototype,
    material: {
      pvMaterialId: orderMaterialId ?? pv.material_id,
      code: mat.code,
      display: mat.display_name ?? pv.material_display ?? null,
      cardLine: null,
      letterpress: null,
    },
    supplier: {
      supplierId: chosen?.id ?? null,
      supplierName: chosen?.name ?? null,
      productTypeName: productType || null,
      specificType,
      thickness,
      finish,
      mustShipBy: isoDate(shipBy),
    },
    dateRequired: (order.date_required as string | null) ?? null,
    inks,
    packaging,
    split: split.map((p: { name: unknown; quantity: unknown }) => ({ name: String(p.name).trim(), qty: Number(p.quantity) })),
    dropboxFolderUrl: (order.dropbox_folder_url as string | null) ?? null,
    note: note || null,
  })

  // Plan the artwork attachments from the Dropbox folder (best-effort: a listing
  // failure just means no attachments — the email + folder link still go). Same
  // as the in-house route, so the supplier gets the files AND the link.
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
    // Key present only when the feature is on — 'off' responses stay byte-identical.
    const handoffValidation = await runHandoffValidation(pub, handoffMode, handoffPayload)
    return json({
      ok: true,
      route,
      subject,
      email_lines: emailLines,
      critical_lines: criticalLines,
      supplier: chosen,
      suppliers,
      ship_by: shipByStr,
      summary,
      artwork_plan: artworkPlan,
      ...(handoffValidation ? { handoff_validation: handoffValidation } : {}),
    })
  }

  // confirm
  // A fully-edited message must still carry every machine-read spec line and add
  // none the parser could misread, or Stock Control's ingester can't read the
  // job. Reject before emailing anyone.
  if (customMessage) {
    const problems = checkEditedMessage(customMessage, criticalLines)
    if (problems.length) return json({ ok: false, code: 'spec_check_failed', error: `${problems.join(' | ')} — fix the flagged ${problems.length === 1 ? 'line' : 'lines'} or reset the message.` }, 400)
  }
  if (!chosen) return json({ ok: false, error: 'Choose a supplier to order from.' }, 400)
  if (!chosen.email) return json({ ok: false, error: `${chosen.name} has no email address configured in Stock Control.` }, 400)
  const appId = Deno.env.get('HELPSCOUT_APP_ID')?.trim()
  const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')?.trim()
  if (!appId || !appSecret) return json({ ok: false, error: 'Help Scout credentials not configured.' }, 500)
  const userId = await resolveUserId(admin, callerId)
  if (userId == null) return json({ ok: false, error: 'No Help Scout author id available (set HELPSCOUT_DEFAULT_USER_ID).' }, 500)

  // A retry must never email a supplier twice — a duplicate order email can
  // become a duplicate production run, which is not merely cosmetic. If the
  // conversation id is already on the order the email DID go (only the stamp
  // was lost), so repair the stamp and stop.
  // Either stamp proves the email already went out. Repair the missing one if
  // needed, then STOP — re-emailing a supplier can become a duplicate
  // production run, so this route refuses rather than risking it.
  if (isMessageRetryCandidate && (order.supplier_helpscout_conversation_id || order.supplier_email_sent_at)) {
    if (!order.supplier_email_sent_at) {
      await stampMessageSent(admin, orderId, { supplier_email_sent_at: new Date().toISOString() })
    }
    return json({ ok: false, code: 'already_sent', error: `This order is already placed and ${chosen.name} was already emailed — nothing further was sent.` }, 409)
  }

  // The Stock Control job this order resolved to, kept in scope so the
  // conversation id can be stamped onto it after the email is created.
  let scOrderId: string | null = null

  // LIVE: write the Stock Control job FIRST (see the in-house route). Nothing
  // has been emailed yet, so a failure here is clean and freely retryable.
  if (handoffMode === 'live') {
    // A re-place must produce a NEW job, so drop the previous placement's
    // stamps first (see clearHandoffStampsForReplace).
    if (isReplace) {
      const cleared = await clearHandoffStampsForReplace(admin, orderId)
      if (!cleared.ok) {
        return json({ ok: false, code: 'handoff_failed', error: `Couldn’t prepare this order for re-placing (${cleared.error}). Nothing has been sent — try again.` }, 500)
      }
    }
    const wrote = await executeHandoff(pub, handoffPayload, orderSpecSnapshot)
    if (!wrote.ok) {
      await stampHandoffError(admin, orderId, wrote.error ?? 'unknown error')
      return json({ ok: false, code: 'handoff_failed', error: `Stock Control couldn’t accept this order: ${wrote.error}. Nothing has been sent — fix that and try again.` }, 400)
    }
    // CRITICAL on this route: if the RPC did not create a job for this call,
    // some other call already did — either a concurrent Confirm that won the
    // row lock, or a retry landing on the 000345 idempotency guard. That other
    // call is sending (or has sent) the supplier email. Sending here too would
    // put a SECOND identical order in front of the supplier, which becomes a
    // duplicate production run and a real bill. Stop, and report it honestly.
    // (A deliberate message RETRY is the one case where already_imported is
    // expected and sending is exactly what we're here to do — the guards above
    // have already proved this order's email never went out.)
    if (wrote.alreadyImported && !isMessageRetryCandidate) {
      return json({
        ok: false,
        code: 'already_placed',
        error: `This order is already in Stock Control${wrote.wroteNothing ? '' : ' (it matched an existing job)'} — it has not been emailed again. Check the Orders page before placing it once more.`,
      }, 409)
    }
    scOrderId = wrote.scOrderId ?? null
    await auditPlaced(admin, orderId, callerId, { route, subject, sc_order_id: wrote.scOrderId, supplier_id: chosen.id, supplier_name: chosen.name, supplier_overs: supplierOvers, ...(isReplace ? { old_job_cancelled: oldJobCancelled } : {}) })
  }

  let newConvId: string | null = null
  try {
    const token = await getAccessToken(appId, appSecret)
    // Send from the proof's mailbox; fall back to the env default if unset.
    let mailboxId: number | null = conversationId ? await fetchMailboxId(token, conversationId) : null
    if (mailboxId == null) {
      const envMb = Number(Deno.env.get('HELPSCOUT_MAILBOX_ID') ?? '')
      mailboxId = Number.isInteger(envMb) && envMb > 0 ? envMb : null
    }
    // THROW, don't return: in live mode the Stock Control job is already
    // committed by this point, and a bare return here would skip the catch
    // below — leaving a placed order reported as a plain failure, with no
    // handoff_error and no retry affordance, while the supplier is never told.
    if (mailboxId == null) throw new HsError(502, 'Could not resolve a Help Scout mailbox to send from.')
    // Download + attach the prepped artwork (best-effort, same as in-house). The
    // Dropbox link stays in the email body so anything too big to attach (Help
    // Scout caps a file at 10 MB) is still reachable.
    let attachments: { fileName: string; mimeType: string; data: string }[] = []
    if (dbxToken && toFetch.length && order.dropbox_folder_url) {
      try {
        attachments = await buildArtworkAttachments(dbxToken, order.dropbox_folder_url, toFetch)
      } catch { /* best-effort: send the email without attachments */ }
    }
    // The exact body emailed to the supplier — reused verbatim for the customer-
    // thread copy below so the two can't drift.
    const handoffBody = customMessage ? htmlifyMessage(customMessage) : emailLines.join('<br>')
    newConvId = await createSupplierConversation(token, {
      mailboxId,
      subject,
      supplierEmail: chosen.email,
      userId,
      text: handoffBody,
      attachments,
    })
    // Stamp the send THE MOMENT Help Scout accepts it, before the best-effort
    // copy below. The email is irreversible from here, so the record of it must
    // not depend on anything that follows: if the invocation dies later (a
    // timeout after a 20 MB attachment upload is the realistic case), a retry
    // would otherwise find no evidence and email the supplier a second time.
    if (handoffMode === 'live') {
      await stampMessageSent(admin, orderId, {
        supplier_email_sent_at: new Date().toISOString(),
        ...(newConvId ? { supplier_helpscout_conversation_id: newConvId } : {}),
      })
      // Also stamp the conversation onto the Stock Control job itself. Today
      // migration 000331's ref-based adoption fills this ~2s later when the
      // webhook fires (verified: all live direct rows have it), but that route
      // depends on the email still PARSING — which stops being true the moment
      // the wording is freed, and on the webhook winning a race we don't
      // control. Writing it here makes the link wording-independent, and it is
      // what stops the outsourced parser treating the thread as a brand-new
      // order (its first dedupe check is exactly this column).
      if (newConvId && scOrderId) {
        await pub
          .from('outsourced_orders')
          .update({ helpscout_conversation_id: Number(newConvId) })
          .eq('id', scOrderId)
          .is('helpscout_conversation_id', null)
          .then(({ error }) => {
            if (error) console.error('supplier conversation stamp failed:', error.message)
          })
      }
    }
    // Best-effort: file a copy of exactly what was sent to the supplier as an
    // internal note on the customer's proof thread. Help Scout notes are never
    // emailed or shown to the customer, so this just gives the project thread a
    // record of the outsourced hand-off. No attachments — the artwork already rode
    // on the supplier email, and the Dropbox link is in the copied body. A failure
    // here must NOT fail the placement: the supplier email has already gone out, so
    // a throw that reached the outer catch would wrongly report failure and invite
    // a retry that re-sends the whole order. Guarded on a linked thread (a supplier
    // order can be placed without one, in which case there's nothing to copy onto).
    if (conversationId) {
      try {
        await createNote(
          token,
          conversationId,
          userId,
          `<strong>COPY OF ORDER SENT TO SUPPLIER</strong><br><br>${handoffBody}`,
        )
      } catch { /* best-effort copy; the supplier email is the hand-off that matters */ }
    }
  } catch (e) {
    const msg = e instanceof HsError ? `Help Scout: ${e.message}` : `${(e as Error)?.message ?? 'unknown'}`
    // LIVE: the job is ALREADY in Stock Control — only the supplier email
    // failed. Report it as placed-but-unsent so nobody re-places (which would
    // duplicate the job); the Orders page offers the single-purpose retry.
    if (handoffMode === 'live') {
      await stampHandoffError(admin, orderId, `supplier email not sent: ${msg}`)
      return json({ ok: false, code: 'placed_message_not_sent', error: `The order is in Stock Control, but the email to ${chosen.name} couldn’t be sent (${msg}). The order IS placed — don’t place it again; use “Send it now” on the Orders page to retry the email.` }, 502)
    }
    if (e instanceof HsError) return json({ ok: false, error: `Help Scout: ${e.message}` }, 502)
    return json({ ok: false, error: `Hand-off failed: ${msg}` }, 502)
  }

  // LIVE: the RPC flipped the order to placed and the send was stamped the
  // instant Help Scout accepted it (above), so there is nothing left to do.
  if (handoffMode === 'live') {
    return json({ ok: true, route, placed: true, supplier: chosen.name })
  }

  const placed = await markPlaced(admin, orderId, callerId, orderSpecSnapshot, {
    route,
    subject,
    supplier_id: chosen.id,
    supplier_name: chosen.name,
    supplier_helpscout_conversation_id: newConvId,
    supplier_overs: supplierOvers,
    ...(isReplace ? { old_job_cancelled: oldJobCancelled } : {}),
  })
  if (!placed.ok) {
    // The supplier email WAS sent; only the status flip failed. Distinct error so
    // the UI won't re-send — the order is placed, it just needs recording manually.
    await logPlaceMishap(admin, orderId, callerId, { route, subject, supplier_name: chosen.name, supplier_helpscout_conversation_id: newConvId, error: placed.error })
    // The hand-off DID send, so the shadow ledger should still carry it —
    // these odd placements are exactly the ones the parity check must see.
    await recordShadowHandoff(admin, pub, handoffMode, orderId, handoffPayload)
    return json({ ok: false, code: 'sent_not_recorded', error: `The order was emailed to ${chosen.name}, but the order status couldn’t be updated (${placed.error}). Do NOT send it again — mark this order placed manually.` }, 500)
  }
  await recordShadowHandoff(admin, pub, handoffMode, orderId, handoffPayload)
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
  snapshot: OrderSpecSnapshot,
  detail: { route: string; subject: string; supplier_id?: string; supplier_name?: string; supplier_helpscout_conversation_id?: string | null; supplier_overs?: number; old_job_cancelled?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const nowIso = new Date().toISOString()
  // Conditional on status in (paid, revision) so a stale/concurrent re-entry
  // can't re-flip; .select() so we can confirm exactly one row actually moved to
  // fulfilled (paid→fulfilled, or revision→fulfilled on a re-place).
  const { data, error } = await admin
    .from('orders')
    .update({
      status: 'fulfilled',
      fulfilled_at: nowIso,
      fulfilled_by: callerId,
      // Overwrite the spec snapshot with what was actually handed off (Phase 2).
      order_spec_snapshot: snapshot,
      ...(detail.supplier_id ? { supplier_id: detail.supplier_id } : {}),
      ...(detail.supplier_name ? { supplier_name: detail.supplier_name } : {}),
      ...(detail.supplier_helpscout_conversation_id ? { supplier_helpscout_conversation_id: detail.supplier_helpscout_conversation_id } : {}),
      ...(detail.supplier_overs != null ? { supplier_overs: detail.supplier_overs } : {}),
      updated_at: nowIso,
    })
    .eq('id', orderId)
    .in('status', ['paid', 'revision'])
    .select('id')
  if (error) return { ok: false, error: error.message }
  if (!data || data.length === 0) return { ok: false, error: 'order was no longer placeable (not paid/revision)' }
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

// ── Direct hand-off ─────────────────────────────────────────────────────────
// docs/order-handoff-spec.md §3.4 / §3.6 / §6.
//   'off'    → this function behaves exactly as it did pre-Phase-1.
//   'shadow' → the Help Scout note/email is still THE hand-off; the contract
//              payload is validated + stored alongside for the parity check.
//              Everything shadow does is best-effort and can never fail a
//              placement.
//   'live'   → Phase 2: the direct write into Stock Control IS the hand-off and
//              runs FIRST (atomically with marking the order placed); the
//              note/email follow as human messages. The parser stays deployed
//              as a backstop, so the strict wording rules remain in force.
type HandoffMode = 'off' | 'shadow' | 'live'

// Read settings.direct_handoff_mode. Any error (including the column not
// existing yet — this function is deployable before migration 000332) = 'off'.
async function loadHandoffMode(admin: SupabaseClient): Promise<HandoffMode> {
  try {
    const { data } = await admin.from('settings').select('direct_handoff_mode').limit(1).maybeSingle()
    const m = (data as { direct_handoff_mode?: string | null } | null)?.direct_handoff_mode
    return m === 'live' ? 'live' : m === 'shadow' ? 'shadow' : 'off'
  } catch {
    return 'off'
  }
}

// Execute the direct hand-off: create_order_handoff with p_validate_only=false.
// ONE transaction on the database side — it inserts the Stock Control job AND
// flips proofs.orders to fulfilled with the handoff stamps, or does neither. A
// failure here therefore means nothing changed anywhere and the caller can
// retry freely, which is why this runs BEFORE anything is sent.
// `already_imported` is success: the job exists (this is the message-retry path).
async function executeHandoff(
  pub: SupabaseClient,
  payload: Record<string, unknown>,
  snapshot: OrderSpecSnapshot,
): Promise<{ ok: boolean; error?: string; alreadyImported?: boolean; wroteNothing?: boolean; scOrderId?: string | null }> {
  try {
    const { data, error } = await pub.rpc('create_order_handoff', {
      p_payload: payload,
      p_spec_snapshot: snapshot,
      p_validate_only: false,
    })
    if (error) return { ok: false, error: error.message }
    const d = data as { ok?: boolean; already_imported?: boolean; sc_order_id?: string | null; problems?: { message: string }[] } | null
    if (!d?.ok) {
      const msg = (d?.problems ?? []).map((p) => p.message).join(' | ')
      return { ok: false, error: msg || 'Stock Control did not accept the order.' }
    }
    // Two different "already imported" meanings, and they need different
    // handling, so distinguish them by the one unambiguous signal: the RPC's
    // early return (this order was already handed off) omits sc_order_id, while
    // every path that actually resolved a job includes it.
    //   * wroteNothing  → the early return: nothing happened this call.
    //   * alreadyImported with an sc_order_id → a job was ADOPTED (a hand-keyed
    //     in-house job, or the supplier idempotency guard from 000345). The
    //     order IS placed against that job — but the message must not be re-sent.
    return {
      ok: true,
      alreadyImported: d.already_imported === true,
      wroteNothing: d.sc_order_id == null,
      scOrderId: d.sc_order_id ?? null,
    }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? 'unknown error' }
  }
}

// The RPC does the status flip in live mode, so it never passes through
// markPlaced — which is where the `order.placed` audit row used to be written.
// Write it here instead, or a live placement would leave no trail. Skipped on a
// message retry (already_imported), which isn't a new placement.
async function auditPlaced(
  admin: SupabaseClient,
  orderId: string,
  callerId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await admin.from('audit_log').insert({
    actor_id: callerId,
    action: 'order.placed',
    target_type: 'order',
    target_id: orderId,
    target_label: `Order ${orderId}`,
    after_value: { ...detail, via: 'direct_handoff' },
  }).then(undefined, () => {})
}

// A re-place (revision flow) needs a genuinely NEW Stock Control job — the
// human has already cancelled the old one. But create_order_handoff is
// idempotent on `handoff_at`, so the stamp left by the FIRST placement would
// make it return already_imported and quietly create nothing. Clear the
// placement stamps first so the re-place writes a fresh job, and clear the send
// stamps too since a new message is about to go out.
//
// This only ever runs while the order is still 'revision'. Once the RPC commits
// it flips to 'fulfilled' with a fresh handoff_at, so a retry after a timeout is
// classified as a MESSAGE RETRY instead and never re-enters here — which is what
// stops a second job being created. The previous placement's supplier
// conversation id is deliberately cleared (the retry logic must not mistake the
// old thread for the new send); it remains recoverable from that placement's
// `order.placed` audit row.
async function clearHandoffStampsForReplace(admin: SupabaseClient, orderId: string): Promise<{ ok: boolean; error?: string }> {
  const { error } = await admin
    .from('orders')
    .update({
      handoff_at: null,
      handoff_error: null,
      production_note_posted_at: null,
      supplier_email_sent_at: null,
      supplier_helpscout_conversation_id: null,
    })
    .eq('id', orderId)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

// Record why a hand-off couldn't complete, so the Orders page can show it from
// persisted state rather than a toast the designer may have dismissed. Cleared
// on the next success (the RPC nulls it; the send stamps below null it too).
async function stampHandoffError(admin: SupabaseClient, orderId: string, message: string): Promise<void> {
  await admin
    .from('orders')
    .update({ handoff_error: message.slice(0, 500) })
    .eq('id', orderId)
    .then(({ error }) => {
      if (error) console.error('stampHandoffError failed:', error.message)
    })
}

// Stamp the done-once flag once the human message has actually gone out. These
// are what the Orders page keys its "placed but not sent" retry on, so a miss
// here shows as an actionable row rather than silence.
async function stampMessageSent(admin: SupabaseClient, orderId: string, patch: Record<string, unknown>): Promise<void> {
  await admin
    .from('orders')
    .update({ ...patch, handoff_error: null })
    .eq('id', orderId)
    .then(({ error }) => {
      if (error) console.error('stampMessageSent failed:', error.message)
    })
}

// Read settings.artwork_check_mode + artwork_check_required, tolerant of the
// columns not existing yet (deployable before migration 000336 — the
// loadHandoffMode idiom). True only when the check is LIVE and required: a
// shadow/off check isn't a precondition the reviewer can see or satisfy.
async function loadArtworkCheckGate(admin: SupabaseClient): Promise<boolean> {
  try {
    const { data } = await admin.from('settings').select('artwork_check_mode, artwork_check_required').limit(1).maybeSingle()
    const d = data as { artwork_check_mode?: string | null; artwork_check_required?: boolean | null } | null
    return d?.artwork_check_mode === 'live' && d?.artwork_check_required === true
  } catch {
    return false
  }
}

interface HandoffValidation {
  ok: boolean
  problems: { code: string; message: string }[]
  warnings: { code: string; message: string }[]
  resolution?: Record<string, unknown>
}

// Validate the contract payload against public.create_order_handoff without
// writing anything. Null when the mode is off or the RPC isn't reachable
// (pre-migration deploy) — the review page renders nothing for null.
async function runHandoffValidation(pub: SupabaseClient, mode: HandoffMode, payload: Record<string, unknown>): Promise<HandoffValidation | null> {
  if (mode === 'off') return null
  try {
    const { data, error } = await pub.rpc('create_order_handoff', { p_payload: payload, p_validate_only: true })
    if (error || !data) return null
    const d = data as { ok?: boolean; problems?: { code: string; message: string }[]; warnings?: { code: string; message: string }[]; resolution?: Record<string, unknown> }
    return { ok: d.ok === true, problems: d.problems ?? [], warnings: d.warnings ?? [], resolution: d.resolution }
  } catch {
    return null
  }
}

// Shadow record after a successful (legacy-path) placement: store the payload
// for the Phase 1 parity check, and surface validation problems via
// handoff_error (prefixed "shadow:") so the mapping gaps get fixed during the
// shadow window rather than discovered at cutover.
async function recordShadowHandoff(admin: SupabaseClient, pub: SupabaseClient, mode: HandoffMode, orderId: string, payload: Record<string, unknown>): Promise<void> {
  // Shadow ONLY. In live mode the RPC itself stamps handoff_payload inside the
  // placement transaction, so re-writing it here would be redundant at best and
  // could clobber the authoritative record at worst.
  if (mode !== 'shadow') return
  try {
    const validation = await runHandoffValidation(pub, mode, payload)
    const problems = validation?.problems ?? []
    await admin
      .from('orders')
      .update({
        handoff_payload: payload,
        handoff_error: problems.length ? `shadow: ${problems.map((p) => p.message).join(' | ')}` : null,
      })
      .eq('id', orderId)
      .then(({ error }) => {
        if (error) console.error('shadow handoff record failed:', error.message)
      })
  } catch (e) {
    console.error('shadow handoff record failed:', (e as Error)?.message ?? e)
  }
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
