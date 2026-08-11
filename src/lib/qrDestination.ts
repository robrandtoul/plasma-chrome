// Where a QR code actually sends someone.
//
// ── The problem this exists for ──────────────────────────────────────
//
// A QR that encodes a full URL is self-describing: decode it and you
// can read where it goes, which is what lets the artwork check compare
// it against what the customer asked for. A QR that encodes a SHORT
// link is not. `https://qcrd.uk/dgceFH7` is an opaque token — a slug
// typo, a stale slug, or the wrong customer's slug all produce a code
// that decodes perfectly, looks immaculate on the card, and points
// somewhere entirely wrong. Nobody downstream can catch it: the
// designer can't see it, the check can't read it, and the customer
// scanning their proof has no idea what they're approving.
//
// So the destination has to be RESOLVED before anything can be said
// about it. This module is the pure half of that job — recognising a
// short link and describing a destination. The resolving itself is
// environment-specific and lives with each caller:
//
//   * Edge (the artwork check) reads `qr.cards` directly with the
//     service-role client — same Supabase project, no credentials, no
//     outbound request. Third-party shorteners fall back to a single-
//     hop redirect read.
//   * Browser (the customer proof page, the designer's version form)
//     goes through the vCard app's anon `lookup_card_by_slug` RPC,
//     already wired up in vcardClient.ts. It cannot do the redirect
//     read — CORS hides the Location header of an opaque redirect —
//     which is exactly why the two halves resolve differently.
//
// ── Twin ─────────────────────────────────────────────────────────────
//
// Byte-identical copy at supabase/functions/_shared/qrDestination.ts.
// Deno edge functions can't import from src/, so the file is
// duplicated and qrDestination.test.ts imports BOTH and fails on any
// drift. Change one, change the other.

// ── Short-link hosts ─────────────────────────────────────────────────

/**
 * Plasma's own QR app. One slug space serves both hosted vCards
 * (target_type='vcard') and plain redirects (target_type='external_url'),
 * so recognising the host tells you it's ours — not which kind it is.
 * Only the resolver, reading the card row, can tell you that.
 */
export const PLASMA_SHORT_HOSTS: readonly string[] = ['qcrd.uk']

/**
 * Third-party shorteners. Kept in step with SHORTENER_HOSTS in
 * qrCodes.ts, which drives the customer page's "shortened link" badge.
 * That list deliberately does NOT expand the link; this one exists so
 * the check can try to. Add hosts to both.
 */
export const THIRD_PARTY_SHORT_HOSTS: readonly string[] = [
  'bit.ly',
  't.co',
  'tinyurl.com',
  'lnkd.in',
  'goo.gl',
  'ow.ly',
  'is.gd',
  'buff.ly',
  'rebrand.ly',
  'cutt.ly',
  'shorturl.at',
  't.ly',
  'rb.gy',
  'qr.ae',
]

export type ShortLinkKind = 'plasma' | 'third_party'

export interface ShortLink {
  kind: ShortLinkKind
  /** Hostname, lowercased, `www.` stripped. */
  host: string
  /**
   * The path segment identifying the link. Null when the path isn't a
   * plausible slug (a bare host, a nested path, a `.vcf` suffix), which
   * is the signal to leave it alone rather than guess.
   */
  slug: string | null
  /** The URL as given, untouched. */
  url: string
}

/**
 * Slug shape, matching the vCard app's own rule ("Letters, digits and
 * hyphens. 3-32 characters"). Case is significant and preserved — the
 * lookup matches case-sensitively, so `dgceFH7` must not arrive as
 * `dgcefh7`. Deliberately duplicated from vcardQr.ts rather than
 * imported: that module pulls in the `qrcode` package, which doesn't
 * exist in the Deno runtime this file's twin has to load in.
 */
const SLUG_RE = /^[a-zA-Z0-9-]{3,32}$/

function safeUrl(raw: string): URL | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  try {
    const u = new URL(trimmed)
    // http(s) only. A `javascript:` or `data:` payload is not something
    // to resolve, summarise, or hand onward as a destination.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u
  } catch {
    return null
  }
}

function bareHost(u: URL): string {
  return u.hostname.toLowerCase().replace(/^www\./, '')
}

/**
 * Recognise a short link and pull out its slug. Returns null for
 * anything that isn't one — an ordinary URL, a vCard payload, junk.
 *
 * Keyed on the URL, not on the stored `qr_kind`, so it works whichever
 * way the code reached us: pasted into the version form's vCard field
 * (kind `hosted_vcard`, slug column set) or uploaded as an image and
 * decoded (kind `url`, no slug column). Both end up with the same
 * payload string, and that is the thing that actually prints.
 */
export function parseShortLink(raw: string): ShortLink | null {
  const u = safeUrl(raw)
  if (!u) return null

  const host = bareHost(u)
  const kind: ShortLinkKind | null = PLASMA_SHORT_HOSTS.includes(host)
    ? 'plasma'
    : THIRD_PARTY_SHORT_HOSTS.includes(host)
      ? 'third_party'
      : null
  if (!kind) return null

  const segments = u.pathname.split('/').filter(Boolean)
  const slug = segments.length === 1 && SLUG_RE.test(segments[0]) ? segments[0] : null

  return { kind, host, slug, url: raw.trim() }
}

/** True for any URL served by a shortener we know about. */
export function isShortLink(raw: string): boolean {
  return parseShortLink(raw) != null
}

// ── Volatile query parameters ────────────────────────────────────────

/**
 * Query parameters that carry no information about WHERE a link goes —
 * analytics tags, ad click ids, and the session tokens a search engine
 * staples onto its own address bar.
 *
 * This matters because the URLs customers supply are rarely canonical.
 * The live Skywalker Septic destination is 1,009 characters, of which
 * the only part identifying the destination is
 * `q=skywalkersepticllc+com+reviews`. The rest includes `sxsrf` (a
 * timestamp), `ved` and `lei` (click tokens from one search session)
 * and `biw=384&bih=693` — literally the browser window size of the
 * phone somebody copied it on. Comparing two such URLs character by
 * character reports a difference every time and means nothing.
 *
 * ⚠ This list only affects the human-readable LABEL and the noise
 * count. The full URL is always passed through verbatim, so an
 * over-eager entry costs a terser summary, never a missed check. Erring
 * toward leaving a parameter IN is the safe direction — a difference a
 * human sees beats a difference silently hidden — which is why
 * genuinely ambiguous ones (`hl`, `ref`, `source`) are absent.
 */
const VOLATILE_PARAM_PREFIXES: readonly string[] = ['utm_']

const VOLATILE_PARAMS: ReadonlySet<string> = new Set([
  // Ad + campaign click identifiers
  'gclid', 'gbraid', 'wbraid', 'dclid', 'fbclid', 'msclkid',
  'ttclid', 'twclid', 'yclid', 'igshid', 'mc_cid', 'mc_eid', 'li_fat_id',
  '_ga', '_gl',
  // Google search-session tokens
  'sca_esv', 'sxsrf', 'ved', 'ei', 'lei', 'uds', 'si', 'sa',
  'ictx', 'stq', 'cs', 'biw', 'bih', 'iflsig', 'gs_lcp', 'gs_lp',
  'sclient', 'oq', 'bshm', 'usg',
])

/** True if this parameter name is tracking/session noise. */
export function isVolatileParam(name: string): boolean {
  const lower = name.toLowerCase()
  if (VOLATILE_PARAMS.has(lower)) return true
  return VOLATILE_PARAM_PREFIXES.some((p) => lower.startsWith(p))
}

// ── Describing a destination ─────────────────────────────────────────

export interface DestinationSummary {
  /** The destination URL verbatim. Never abridged — this is the fact. */
  full: string
  /**
   * A short, readable form: host, path, and the parameters that carry
   * meaning. What a human should be shown instead of 1,009 characters.
   */
  label: string
  /** Hostname (`www.` stripped), or null if the URL wouldn't parse. */
  host: string | null
  /** How many tracking/session parameters the label leaves out. */
  droppedVolatile: number
}

const LABEL_MAX = 160
const VALUE_MAX = 70
const MAX_PARAMS_IN_LABEL = 3

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/**
 * Turn a destination URL into something worth showing a person, while
 * keeping the verbatim URL alongside it.
 *
 * An unparseable or non-http string is not an error — it comes back as
 * its own label, truncated. The caller's job is to display what we
 * found, not to validate the customer's link.
 */
export function summariseDestination(raw: string): DestinationSummary {
  const full = (raw ?? '').trim()
  const u = safeUrl(full)
  if (!u) {
    return { full, label: truncate(full, LABEL_MAX), host: null, droppedVolatile: 0 }
  }

  const host = bareHost(u)
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')

  const meaningful: string[] = []
  let dropped = 0
  // Note: URLSearchParams decodes `+` to a space, so a search term
  // reads as the customer typed it rather than as URL-encoding.
  for (const [key, value] of u.searchParams) {
    if (isVolatileParam(key)) {
      dropped++
      continue
    }
    if (meaningful.length < MAX_PARAMS_IN_LABEL) {
      meaningful.push(value ? `${key}=${truncate(value, VALUE_MAX)}` : key)
    }
  }

  // Fragment goes with the host/path, not after the parameters, so the
  // URL-shaped part of the label stays in one piece and reads as an
  // address rather than trailing off a search term.
  let label = `${host}${path}`
  if (u.hash && u.hash !== '#') label += u.hash
  if (meaningful.length > 0) label += ` — ${meaningful.join(', ')}`

  return { full, label: truncate(label, LABEL_MAX), host, droppedVolatile: dropped }
}

/**
 * One line describing where a short link leads, for the check context
 * and for anything showing a designer what they just pasted.
 *
 * States the noise count explicitly rather than hiding it: "plus 14
 * tracking parameters" tells the reader the label is a summary of
 * something longer, so a difference between label and full URL never
 * reads as the summary being wrong.
 */
export function describeDestination(summary: DestinationSummary): string {
  if (!summary.full) return 'no destination recorded'
  const noise =
    summary.droppedVolatile > 0
      ? ` (plus ${summary.droppedVolatile} tracking parameter${summary.droppedVolatile === 1 ? '' : 's'})`
      : ''
  return `${summary.label}${noise}`
}
