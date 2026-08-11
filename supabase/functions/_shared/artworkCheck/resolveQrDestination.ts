// Resolving a short-link QR to the address it actually opens.
//
// The check can compare a QR against what the customer asked for only if
// it can read where the QR goes. A payload like `https://qcrd.uk/dgceFH7`
// tells it nothing — so before the model is called, every short link is
// resolved here and the destination handed over as a fact, sitting
// alongside the decoded payloads and the cut-through measurements the
// prompt already tells it to treat as measured and not re-judge.
//
// ⚠ The model must never be asked to guess where a short link leads. It
// would guess plausibly, occasionally wrongly, about the one field on the
// card that nobody downstream can check by eye. Either we resolved it, or
// we say we could not.
//
// ── Two routes, deliberately different ───────────────────────────────
//
// Plasma's own links (qcrd.uk) resolve by reading `qr.cards` directly.
// The QR app lives in the SAME Supabase project as the proof data — the
// service role holds USAGE on the `qr` schema and SELECT on `qr.cards`
// (verified on live) — so this is one indexed query with no credentials,
// no outbound request and no attack surface. It is also authoritative:
// it reports what the redirect is CONFIGURED to do, including for a card
// that is not live yet and would not redirect at all today.
//
// Third-party shorteners (bit.ly and friends) have no such route, so
// they resolve by reading the Location header of a single redirect hop.
// That is a live network call to a URL the studio did not choose, so it
// is bounded hard: known hosts only, http(s) only, no private addresses,
// a few hops, a short timeout, and a small cap on how many run.
//
// A failure on either route is a stated gap, never a flag. A shortener
// being briefly unreachable is not an artwork defect.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

import { parseShortLink, summariseDestination, type ShortLink } from '../qrDestination.ts'
import type { ShortLinkDestination } from './types.ts'

export type { ShortLinkDestination }

/** Bounds on the third-party redirect route. Deliberately small. */
const REDIRECT_TIMEOUT_MS = 6000
const REDIRECT_MAX_HOPS = 3
const REDIRECT_MAX_LOOKUPS = 8

/**
 * Hostnames and literal addresses that must never be fetched. The first
 * hop is always a known public shortener, so this guards the hops AFTER
 * it: a shortener pointed at an internal address is the one way this
 * could be turned into a request we didn't intend to make.
 */
function isForbiddenHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) {
    return true
  }
  // IPv6 loopback / link-local / unique-local.
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true
  // IPv4 literals: loopback, private ranges, link-local, and 0.0.0.0.
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 0 || a === 127 || a === 10) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true // link-local, incl. cloud metadata
  }
  return false
}

/**
 * Read where a shortener says it is sending someone.
 *
 * Stops the moment a hop leaves the shortener's own host: that Location
 * header IS the destination, and it carries the fragment (`#…`) that
 * following further would lose. The consequence worth stating is that
 * this never fetches the destination itself — the only servers contacted
 * are the shorteners on the allow-list, so verifying a customer's link
 * cannot become a request to the customer's own site.
 *
 * Extra hops exist only for shorteners that bounce within themselves
 * (http→https, or a canonical-URL hop) before letting go.
 */
async function followRedirect(startUrl: string): Promise<{ destination: string | null; note: string | null }> {
  const shortenerHost = new URL(startUrl).hostname.toLowerCase().replace(/^www\./, '')
  let current = startUrl

  for (let hop = 0; hop < REDIRECT_MAX_HOPS; hop++) {
    let res: Response
    try {
      res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(REDIRECT_TIMEOUT_MS),
        headers: { 'User-Agent': 'PlasmaProofCheck/1.0 (+artwork verification)' },
      })
    } catch (err) {
      return { destination: null, note: `the link could not be reached (${(err as Error).name})` }
    }
    // The body is never read — only the header matters, and cancelling it
    // means a shortener pointed at a huge file costs us nothing.
    await res.body?.cancel().catch(() => {})

    if (res.status < 300 || res.status >= 400) {
      // We only ever fetch the shortener itself, so this means the short
      // link isn't redirecting at all — a dead or unclaimed link.
      return { destination: null, note: `the link did not redirect (HTTP ${res.status})` }
    }

    const location = res.headers.get('location')
    if (!location) return { destination: null, note: 'the link redirected without saying where' }

    let next: URL
    try {
      next = new URL(location, current)
    } catch {
      return { destination: null, note: 'the link redirected to an address that could not be read' }
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      return { destination: null, note: 'the link redirected to a non-web address' }
    }
    if (isForbiddenHost(next.hostname)) {
      return { destination: null, note: 'the link redirected to a private address' }
    }

    current = next.toString()
    if (next.hostname.toLowerCase().replace(/^www\./, '') !== shortenerHost) {
      return { destination: current, note: null } // left the shortener — this is it
    }
  }
  return { destination: null, note: 'the link redirects more times than we follow' }
}

/**
 * Resolve every short link among the given QR payloads.
 *
 * Payloads that aren't short links are ignored — an ordinary URL already
 * says where it goes. Duplicates collapse, so one shared QR printing on
 * twelve cards costs one lookup.
 */
export async function resolveQrDestinations(
  admin: SupabaseClient,
  payloads: string[],
): Promise<ShortLinkDestination[]> {
  const links = new Map<string, ShortLink>()
  for (const p of payloads) {
    const link = parseShortLink(p ?? '')
    if (link && !links.has(link.url)) links.set(link.url, link)
  }
  if (links.size === 0) return []

  const out: ShortLinkDestination[] = []

  // ── Route A: our own links, straight from the card table ───────────
  const plasma = [...links.values()].filter((l) => l.kind === 'plasma')
  const slugs = plasma.map((l) => l.slug).filter((s): s is string => s != null)
  const cardsBySlug = new Map<string, { status: string | null; target_type: string | null; external_url: string | null }>()
  if (slugs.length > 0) {
    try {
      const { data, error } = await admin
        .schema('qr')
        .from('cards')
        .select('slug, status, target_type, external_url')
        .in('slug', slugs)
      if (error) throw new Error(error.message)
      for (const row of (data ?? []) as { slug: string; status: string | null; target_type: string | null; external_url: string | null }[]) {
        cardsBySlug.set(row.slug, row)
      }
    } catch (err) {
      console.error('[artwork-check] qr.cards lookup failed:', (err as Error).message)
      // Leave the map empty — every card falls through to "couldn't
      // check", which is honest. Never fail the run over this.
    }
  }

  for (const link of plasma) {
    if (!link.slug) {
      out.push({
        shortUrl: link.url,
        destination: null,
        label: null,
        via: 'unresolved',
        note: 'this is a Plasma short link but the address has no card code in it',
      })
      continue
    }
    const card = cardsBySlug.get(link.slug)
    if (!card) {
      out.push({
        shortUrl: link.url,
        destination: null,
        label: null,
        via: 'unresolved',
        note: 'no card exists with this code — scanning it would reach a "not found" page',
      })
      continue
    }
    const notLive = card.status !== 'live' ? ` The card is "${card.status}", not live yet.` : ''
    if (card.target_type === 'external_url') {
      const dest = (card.external_url ?? '').trim()
      if (!dest) {
        out.push({
          shortUrl: link.url,
          destination: null,
          label: null,
          via: 'unresolved',
          note: `the card is set to redirect but has no address saved.${notLive}`.trim(),
        })
        continue
      }
      const summary = summariseDestination(dest)
      out.push({
        shortUrl: link.url,
        destination: summary.full,
        label: summary.label,
        via: 'plasma_card',
        note: notLive.trim() || null,
      })
      continue
    }
    // A hosted vCard on the same slug space. There is no external
    // destination to compare — the contact fields are the content, and
    // they arrive separately as the approval snapshot (000194).
    out.push({
      shortUrl: link.url,
      destination: null,
      label: null,
      via: 'plasma_card',
      note: `this is a hosted Plasma vCard, not a redirect — its contact details are the content.${notLive}`.trim(),
    })
  }

  // ── Route B: third-party shorteners, over the wire ─────────────────
  const thirdParty = [...links.values()].filter((l) => l.kind === 'third_party')
  for (const link of thirdParty.slice(0, REDIRECT_MAX_LOOKUPS)) {
    const { destination, note } = await followRedirect(link.url)
    const summary = destination ? summariseDestination(destination) : null
    out.push({
      shortUrl: link.url,
      destination: summary?.full ?? null,
      label: summary?.label ?? null,
      via: destination ? 'redirect' : 'unresolved',
      note,
    })
  }
  // Say what was skipped rather than letting a cap look like a clean pass.
  for (const link of thirdParty.slice(REDIRECT_MAX_LOOKUPS)) {
    out.push({
      shortUrl: link.url,
      destination: null,
      label: null,
      via: 'unresolved',
      note: 'too many shortened links on this job to check them all',
    })
  }

  return out
}
