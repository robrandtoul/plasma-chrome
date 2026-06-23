// place-inhouse-order — designer-only. Hands a paid IN-HOUSE order off to the
// Stock Control app by (1) setting the Help Scout conversation subject to the
// Dropbox order-folder name ("Order <number> - <project>") and (2) posting the
// production-order NOTE onto that thread. Stock Control's helpscout-inhouse-order
// webhook then ingests it: it keys the order number off the SUBJECT and reads
// Qty: / Card: / spec lines from the NOTE body.
//
// Contract reverse-engineered from the deployed helpscout-inhouse-order parser:
//   * Subject must read "Order <number> - <customer>" (Re:/Fw: stripped).
//   * Note must carry a `Qty:` line and a `Card:` line (both required to be
//     recognised as an order); plus optional `Date required:`, `Ink on front:`,
//     `Ink on back:`, `Packaging:`, `10% extra:` spec lines and a per-person
//     split (one "<name> — <qty>" line each, summing to Qty).
//   * The note must NOT start with "PlasmaDesign stock-control:" (that prefix
//     marks Stock Control's own notes and is ignored to break the webhook loop).
//   * `Card:` resolves against Stock Control's own public.materials catalogue,
//     NOT the proof-viewer material name. A letterpress card carries its three
//     paper colours: "Letterpress (front, core, back)".
//
// Best-effort sourcing: proof-viewer records the exact colour only for some
// in-house materials. Wood (species from material_options), Translucent Plastic
// and Letterpress (its three colours) resolve cleanly; Acrylic, Satin and Tinted
// don't carry the specific shade, so the Card line is the base material and Stock
// Control's self-correcting note asks a human to specify. Subject is set BEFORE
// the note so the webhook reads the new subject.
//
// Reads only (order + proof + current version); the orders status flip + audit
// stay on the caller. verify_jwt = true; designer/admin gate.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

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

// OAuth client-credentials flow against the Help Scout Mailbox API.
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
  const data = await resp.json().catch(() => null)
  const tok = (data as { access_token?: string } | null)?.access_token
  if (!tok) throw new HsError(500, 'Help Scout token response missing access_token')
  return tok
}

// Set the conversation subject (PATCH op replace /subject). 204 on success.
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

// Post a private staff note. `user` is the authoring HS staff id.
async function createNote(token: string, conversationId: string | number, userId: number, text: string): Promise<void> {
  const resp = await fetch(`https://api.helpscout.net/v2/conversations/${conversationId}/notes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: userId, text }),
  })
  if (!resp.ok && resp.status !== 201) {
    const b = await resp.text().catch(() => '')
    throw new HsError(resp.status, `note create (${resp.status}): ${b.slice(0, 200)}`)
  }
}

// "finnish_birch" -> "Finnish Birch" (wood species option code -> Card words).
function titleCaseCode(code: string): string {
  return String(code)
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

// Build the Card line for Stock Control's forgiving material match.
function buildCardLine(
  code: string,
  materialDisplay: string | null,
  options: unknown,
  front: string | null,
  core: string | null,
  back: string | null,
): string {
  if (code === 'paper_letterpress' || code === 'paper_letterpress_gilded') {
    if (front && core && back) return `Letterpress (${front}, ${core}, ${back})`
    return 'Letterpress'
  }
  if (code === 'wood') {
    const species = Array.isArray(options) && options.length ? String(options[0]) : ''
    return species ? titleCaseCode(species) : (materialDisplay || 'Wood')
  }
  if (code === 'plastic_translucent') return 'Translucent Plastic'
  // acrylic / satin / tinted: the exact shade isn't recorded — base material,
  // Stock Control's correction note asks a human to specify the colour.
  return materialDisplay || code
}

// Split the freeform ink_names into front / back. There's no structured side,
// so inks whose label mentions back/reverse/rear go to the back line, the rest
// to front (e.g. ["Metallic Silver", "Metallic Silver on Back"]).
function buildInks(inkNames: unknown): { front: string | null; back: string | null } {
  const inks = (Array.isArray(inkNames) ? inkNames : []).map((s) => String(s).trim()).filter(Boolean)
  if (!inks.length) return { front: null, back: null }
  const backRe = /\b(back|reverse|rear)\b/i
  const backInks = inks.filter((i) => backRe.test(i))
  const frontInks = inks.filter((i) => !backRe.test(i))
  return {
    front: frontInks.length ? frontInks.join(', ') : null,
    back: backInks.length ? backInks.join(', ') : null,
  }
}

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

// Designer/admin gate. Returns the service-role (proofs-schema) client + caller
// id, or a Response to return immediately.
async function requireDesigner(req: Request): Promise<{ admin: SupabaseClient; callerId: string } | Response> {
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.toLowerCase().startsWith('bearer ')) return json({ ok: false, error: 'Unauthorized' }, 401)
  const jwt = authHeader.replace(/^[Bb]earer\s+/, '').trim()
  const anon = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '')
  const { data: userData, error: userErr } = await anon.auth.getUser(jwt)
  if (userErr || !userData?.user) return json({ ok: false, error: 'Unauthorized' }, 401)
  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { db: { schema: 'proofs' }, auth: { persistSession: false, autoRefreshToken: false } },
  )
  const { data: profile } = await admin
    .from('profiles')
    .select('role, deactivated_at')
    .eq('id', userData.user.id)
    .single()
  if (!profile || profile.deactivated_at) return json({ ok: false, error: 'Forbidden' }, 403)
  if (profile.role !== 'admin' && profile.role !== 'designer') return json({ ok: false, error: 'Forbidden' }, 403)
  return { admin, callerId: userData.user.id }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)

  const check = await requireDesigner(req)
  if (check instanceof Response) return check
  const { admin, callerId } = check

  let orderId: string
  try {
    const b = await req.json()
    orderId = String((b as { order_id?: unknown })?.order_id ?? '').trim()
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400)
  }
  if (!orderId) return json({ ok: false, error: 'order_id is required' }, 400)

  // 1) Order.
  const { data: order, error: orderErr } = await admin
    .from('orders')
    .select('id, status, quantity, person_quantities, date_required, stock_order_number, project_name, proof_id, ship_dest_country, ship_to_address')
    .eq('id', orderId)
    .maybeSingle()
  if (orderErr) return json({ ok: false, error: `Order lookup failed: ${orderErr.message}` }, 500)
  if (!order) return json({ ok: false, error: 'Order not found.' }, 404)
  if (order.status !== 'paid') return json({ ok: false, error: `Order is ${order.status}, not paid — can't place it.` }, 409)
  if (!order.stock_order_number) {
    return json({ ok: false, error: 'Link and check the Dropbox order folder first (no order number).' }, 400)
  }

  // 2) Proof's Help Scout conversation.
  const { data: proof } = await admin
    .from('proofs')
    .select('id, helpscout_conversation_id')
    .eq('id', order.proof_id)
    .maybeSingle()
  const conversationId = (proof as { helpscout_conversation_id: string | null } | null)?.helpscout_conversation_id ?? null
  if (!conversationId) {
    return json({ ok: false, error: 'This proof has no linked Help Scout conversation, so the order note cannot be posted.' }, 400)
  }

  // 3) Current proof version + material.
  const { data: pv } = await admin
    .from('proof_versions')
    .select('material_display, ink_names, material_options, front_colour_id, core_colour_id, back_colour_id, materials(code, display_name, production_route)')
    .eq('proof_id', order.proof_id)
    .eq('is_current', true)
    .maybeSingle()
  if (!pv) return json({ ok: false, error: 'No current proof version found.' }, 404)
  const mat = (pv as { materials: { code: string; display_name: string | null; production_route: string | null } | null }).materials
  if (!mat) return json({ ok: false, error: 'This version has no single material (mixed / variant round) — place it manually.' }, 400)
  if (mat.production_route !== 'in_house') {
    return json({ ok: false, error: `${mat.display_name ?? 'This material'} is a supplier material, not in-house.` }, 400)
  }

  // Letterpress colours (front / core / back) by id.
  let front: string | null = null
  let core: string | null = null
  let back: string | null = null
  const colourIds = [pv.front_colour_id, pv.core_colour_id, pv.back_colour_id].filter(Boolean)
  if (colourIds.length) {
    const { data: cols } = await admin.from('letterpress_core_colours').select('id, name').in('id', colourIds)
    const byId = new Map((cols ?? []).map((c: { id: string; name: string }) => [c.id, c.name]))
    front = (pv.front_colour_id && byId.get(pv.front_colour_id)) || null
    core = (pv.core_colour_id && byId.get(pv.core_colour_id)) || null
    back = (pv.back_colour_id && byId.get(pv.back_colour_id)) || null
  }

  // Quantity + optional per-person split (must sum to the qty we post).
  const rawSplit = Array.isArray(order.person_quantities) ? order.person_quantities : []
  const split = rawSplit.filter(
    (p: { name?: unknown; quantity?: unknown }) =>
      p && typeof p.name === 'string' && p.name.trim() && Number.isFinite(Number(p.quantity)) && Number(p.quantity) > 0,
  )
  let qty: number
  const splitLines: string[] = []
  if (split.length >= 2) {
    qty = split.reduce((s: number, p: { quantity: unknown }) => s + Number(p.quantity), 0)
    for (const p of split) splitLines.push(`${(p.name as string).trim()} — ${Number(p.quantity)}`)
  } else {
    qty = Number(order.quantity ?? 0)
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    return json({ ok: false, error: 'This order has no fixed quantity to place. Set the quantity first.' }, 400)
  }

  const card = buildCardLine(mat.code, pv.material_display, pv.material_options, front, core, back)
  const inks = buildInks(pv.ink_names)

  const lines: string[] = [`Qty: ${qty}`, `Card: ${card}`]
  const dateStr = fmtDate(order.date_required)
  if (dateStr) lines.push(`Date required: ${dateStr}`)
  if (inks.front) lines.push(`Ink on front: ${inks.front}`)
  if (inks.back) lines.push(`Ink on back: ${inks.back}`)
  // Packaging is which box production uses: UK destinations ship in the domestic
  // box, everywhere else the international box. Keyed off the rated destination.
  const destCountry = String(
    order.ship_dest_country ?? (order.ship_to_address as { country?: string | null } | null)?.country ?? '',
  ).trim().toUpperCase()
  if (destCountry) lines.push(`Packaging: ${destCountry === 'GB' ? 'Domestic' : 'International'}`)
  lines.push('10% extra: No')
  for (const sl of splitLines) lines.push(sl)
  const noteText = lines.join('<br>')

  const subject = `Order ${String(order.stock_order_number).trim()} - ${String(order.project_name ?? '').trim()}`
    .replace(/\s-\s*$/, '')
    .trim()

  // Help Scout credentials + authoring staff id (caller's mapping, else default).
  const appId = Deno.env.get('HELPSCOUT_APP_ID')?.trim()
  const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')?.trim()
  const defaultUserId = Deno.env.get('HELPSCOUT_DEFAULT_USER_ID')?.trim()
  if (!appId || !appSecret) return json({ ok: false, error: 'Help Scout credentials not configured.' }, 500)

  let userId: number | null = null
  {
    const { data: pr } = await admin.from('profiles').select('helpscout_user_id').eq('id', callerId).single()
    const v = (pr as { helpscout_user_id: number | null } | null)?.helpscout_user_id ?? null
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) userId = v
  }
  if (userId == null) {
    const parsed = Number(defaultUserId)
    if (!defaultUserId || !Number.isInteger(parsed) || parsed <= 0) {
      return json({ ok: false, error: 'No Help Scout author id available (set HELPSCOUT_DEFAULT_USER_ID).' }, 500)
    }
    userId = parsed
  }

  try {
    const token = await getAccessToken(appId, appSecret)
    // Subject BEFORE the note so the webhook reads the new subject.
    await setConversationSubject(token, conversationId, subject)
    await createNote(token, conversationId, userId, noteText)
  } catch (e) {
    if (e instanceof HsError) return json({ ok: false, error: `Help Scout: ${e.message}` }, 502)
    return json({ ok: false, error: `Hand-off failed: ${(e as Error)?.message ?? 'unknown'}` }, 502)
  }

  return json({ ok: true, subject, card, qty, note: lines.join('\n') })
})
