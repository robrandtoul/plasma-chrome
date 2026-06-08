// Thin client for the vCard app's anon-callable RPCs.
//
// The proof viewer reads contact data straight from the vCard app's
// public API — three SECURITY DEFINER RPCs with EXECUTE granted to
// anon. There is no shared database, no server-side proxy, no new
// vCard-app code; this file is the entire integration surface.
//
// Designer side calls lookupCardBySlug() to validate a pasted
// qcrd.uk URL ("Found: Jane Smith, Acme Ltd"). Customer side calls
// all three to render the contact-fields panel for the QR
// verification step.
//
// Plain `fetch` against `${VCARD_SUPABASE_URL}/rest/v1/rpc/<fn>`
// rather than spinning up a second @supabase/supabase-js client.
// Two reasons:
//   * The vCard RPCs are anon-callable; nothing here needs auth
//     handling, retries, realtime subscriptions or any other
//     supabase-js feature.
//   * Keeps the proof-viewer bundle from carrying a second copy of
//     the supabase-js client.
//
// CORS: Supabase's REST API permits cross-origin calls; a browser
// fetch from proofs.plasmadesign.co.uk to the vCard project is
// expected to work. If a future Supabase policy change breaks
// that, the fallback is a proof-viewer edge function proxying
// these three RPCs. Not built pre-emptively.
//
// ── Reference ────────────────────────────────────────────────────────
//
// RPC definitions live in the vCard app at
//   supabase/migrations/20260516180000_m3a_vcard_restructure.sql
// Read that file before changing return-shape assumptions here.

// Read env lazily inside callRpc() rather than at module load. Vite
// inlines `import.meta.env` at build time so the cost is the same in
// production, and the lazy read lets unit tests shim env after
// importing the module (Vitest-free workflow — see vcardClient.test.ts).
//
// process.env is a fallback used by the unit tests; in the browser
// it's undefined and the import.meta.env path wins. In production
// Vite-built code only the import.meta.env branch is reachable.
function readVcardEnv(): { url: string; anonKey: string } {
  const metaEnv = (import.meta as unknown as { env?: Record<string, string> }).env
  const procEnv = (globalThis as unknown as { process?: { env?: Record<string, string> } })
    .process?.env
  const url =
    metaEnv?.VITE_VCARD_SUPABASE_URL ?? procEnv?.VITE_VCARD_SUPABASE_URL ?? ''
  const anonKey =
    metaEnv?.VITE_VCARD_SUPABASE_ANON_KEY ??
    procEnv?.VITE_VCARD_SUPABASE_ANON_KEY ??
    ''
  return { url: url.replace(/\/+$/, ''), anonKey }
}

// Surface the env at the top of any vCard fetch rather than crashing
// every call site individually. Caller decides whether to render the
// "contact details temporarily unavailable" fallback or surface a
// hard error (designer-side validation has lower tolerance for
// silent failure than the customer page).
export class VcardConfigError extends Error {
  constructor() {
    super(
      'vCard app env vars not configured (VITE_VCARD_SUPABASE_URL / VITE_VCARD_SUPABASE_ANON_KEY).',
    )
    this.name = 'VcardConfigError'
  }
}

// Returned by every helper when the RPC succeeds but the row is
// absent (e.g. a slug that doesn't exist). Distinct from a thrown
// VcardConfigError or a network error so callers can branch on
// "card not found" vs "we couldn't talk to the vCard app at all".
export type VcardResult<T> = { ok: true; data: T } | { ok: false; reason: 'not_found' | 'error'; message?: string }

// ── Public types — mirror the vCard RPC return shapes ────────────────
//
// Field names are the RPC's, verbatim. Camel-casing would force
// every caller to translate twice; PostgREST returns the snake_case
// column names directly and the customer-page renderer references
// them as-is.

export interface VcardCard {
  id: string
  slug: string
  status: string
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
  // Styling — fetched for completeness but the proof viewer does
  // NOT render these. Picture / cover / accent / font are the
  // customer's job to personalise after the cards arrive.
  profile_image_path: string | null
  logo_image_path: string | null
  cover_image_path: string | null
  theme_mode: string | null
  theme_font: string | null
  theme_accent: string | null
  card_updated_at: string | null
}

export interface VcardLink {
  id: string
  url: string
  label: string | null
  icon_slug: string | null
  sort_order: number
}

export interface VcardContactMethod {
  id: string
  method_type: 'email' | 'phone'
  value: string
  label: string | null
  sort_order: number
}

// Bundle the three lookups so the customer page doesn't have to
// orchestrate three independent fetches itself. Returned by
// fetchVcardForSlug(); the individual lookups stay exported for
// the designer-side validate-on-paste flow which only needs the
// top-level card.
export interface VcardBundle {
  card: VcardCard
  links: VcardLink[]
  contactMethods: VcardContactMethod[]
}

// ── Low-level RPC wrapper ────────────────────────────────────────────

async function callRpc<T>(fnName: string, body: Record<string, unknown>): Promise<T> {
  const { url: baseUrl, anonKey } = readVcardEnv()
  if (!baseUrl || !anonKey) {
    throw new VcardConfigError()
  }

  const url = `${baseUrl}/rest/v1/rpc/${fnName}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      'Content-Type': 'application/json',
      // vCard data now lives in the `qr` schema of the merged stock
      // project; under one PostgREST the table/RPC names would otherwise
      // resolve against the default public schema, so the schema must be
      // selected explicitly. RPC POSTs read via Accept-Profile and route
      // the request body via Content-Profile.
      'Accept-Profile': 'qr',
      'Content-Profile': 'qr',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`vCard RPC ${fnName} failed (${res.status}): ${text}`)
  }
  return (await res.json()) as T
}

// ── Individual lookups ───────────────────────────────────────────────

/**
 * Resolve a slug to a card row. Returns regardless of card status —
 * the vCard app's RPC intentionally ignores status here so the proof
 * viewer can show the fields while the card is still a draft.
 */
export async function lookupCardBySlug(slug: string): Promise<VcardResult<VcardCard>> {
  try {
    const rows = await callRpc<VcardCard[]>('lookup_card_by_slug', { card_slug: slug })
    if (!Array.isArray(rows) || rows.length === 0) {
      return { ok: false, reason: 'not_found' }
    }
    return { ok: true, data: rows[0] }
  } catch (err) {
    if (err instanceof VcardConfigError) throw err
    return { ok: false, reason: 'error', message: (err as Error).message }
  }
}

/** Fetch the card's social / custom links. */
export async function lookupCardLinks(cardId: string): Promise<VcardLink[]> {
  const rows = await callRpc<VcardLink[]>('lookup_card_links_by_card_id', {
    p_card_id: cardId,
  })
  return Array.isArray(rows) ? rows : []
}

/** Fetch the card's secondary email / phone entries. */
export async function lookupCardContactMethods(cardId: string): Promise<VcardContactMethod[]> {
  const rows = await callRpc<VcardContactMethod[]>(
    'lookup_card_contact_methods_by_card_id',
    { p_card_id: cardId },
  )
  return Array.isArray(rows) ? rows : []
}

// ── Bundled fetch for the customer page ──────────────────────────────

/**
 * Single-call helper that resolves the slug and (on success) fetches
 * the links + contact methods in parallel. Used by the customer-side
 * QR panel; designer-side validation just calls lookupCardBySlug
 * directly because it only needs the read-back name.
 *
 * Returns the same VcardResult shape as the individual lookups so
 * the customer page can branch cleanly on not_found / error /
 * VcardConfigError without inspecting each fetch separately.
 */
export async function fetchVcardForSlug(slug: string): Promise<VcardResult<VcardBundle>> {
  const cardResult = await lookupCardBySlug(slug)
  if (!cardResult.ok) return cardResult

  try {
    const [links, contactMethods] = await Promise.all([
      lookupCardLinks(cardResult.data.id),
      lookupCardContactMethods(cardResult.data.id),
    ])
    return { ok: true, data: { card: cardResult.data, links, contactMethods } }
  } catch (err) {
    if (err instanceof VcardConfigError) throw err
    return { ok: false, reason: 'error', message: (err as Error).message }
  }
}
