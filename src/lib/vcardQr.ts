// Hosted-vCard QR generation.
//
// A Plasma hosted-vCard card lives at https://qcrd.uk/<slug> — that
// short URL is what the printed QR encodes. The vCard app's studio
// generates the same QR with the same options; this file is the
// proof-viewer's local copy so the designer can produce the QR
// without leaving the version form, and so the QR shown to the
// customer for approval is provably the one that will print.
//
// ── On byte identity with the vCard app ──────────────────────────────
//
// What the customer actually scans is a destination, and the
// destination is fully determined by the encoded string. Both the
// proof viewer and the vCard app encode `https://qcrd.uk/<slug>`,
// so the destination matches regardless of QR library version.
// That's the rule that makes the customer's approval honest.
//
// We pin `qrcode` to 1.5.4 and pass the verbatim options from the
// vCard app's `apps/studio/src/components/QrPanel.tsx` so the SVG
// is byte-identical too, not just destination-identical. The
// library is deterministic; identical input + identical options =
// identical SVG bytes. This is asserted in vcardQr.test.ts via a
// committed golden fixture.
//
// ── Cross-reference ──────────────────────────────────────────────────
//
// The canonical options live in the vCard app at
//   apps/studio/src/components/QrPanel.tsx
// If they change there without changing here (or vice versa), the
// proof QR will diverge from the print QR. Keep them in lockstep.

import QRCode from 'qrcode'

/** Base URL of the hosted-vCard app. The vCard app's PUBLIC_BASE_URL. */
export const VCARD_BASE_URL = 'https://qcrd.uk'

/**
 * vCard slug format: 3-32 characters of letters, digits and hyphens,
 * matching the vCard app's own rule (its NewCardPage states "Letters,
 * digits and hyphens. 3-32 characters").
 *
 * Case is significant and must be preserved. vCard slugs are stored
 * case-preserving and the vCard app's lookup RPC matches case-
 * sensitively, so a slug pasted as `PtrsjZk` has to reach the lookup
 * as `PtrsjZk`, not `ptrsjzk`. The character class allows both cases
 * and the parser returns the slug verbatim. Slashes, underscores and
 * URL-encoded junk are still rejected, so a paste of `qcrd.uk/abc/def`
 * or a stray query string never lands as a slug.
 */
const SLUG_RE = /^[a-zA-Z0-9-]{3,32}$/

/**
 * Build the canonical hosted-vCard URL from a slug. Caller is expected
 * to have validated the slug; this is just string concatenation.
 */
export function vcardUrlForSlug(slug: string): string {
  return `${VCARD_BASE_URL}/${slug}`
}

/**
 * Extract a slug from either a raw slug ("7k2nq8x") or a full URL
 * ("https://qcrd.uk/7k2nq8x" / "http://qcrd.uk/7k2nq8x" /
 * "qcrd.uk/7k2nq8x"). Trims whitespace and a single leading/trailing
 * slash. Strips any trailing query string or fragment. Returns null
 * if what's left doesn't look like a valid slug.
 *
 * Pure function — no DOM, no network. Lives in the lib (rather than
 * the form component) so the designer-side input field and any
 * future server-side validator agree on the rules.
 */
export function parseVcardSlugInput(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Strip protocol + host if present. Tolerates http / https / no
  // protocol; everything resolves to the same slug.
  let candidate = trimmed
    .replace(/^https?:\/\//i, '')
    .replace(/^qcrd\.uk\/?/i, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')

  // Strip query string / fragment.
  const queryIdx = candidate.indexOf('?')
  if (queryIdx !== -1) candidate = candidate.slice(0, queryIdx)
  const hashIdx = candidate.indexOf('#')
  if (hashIdx !== -1) candidate = candidate.slice(0, hashIdx)

  // Reject if there's still a path segment beyond the slug.
  if (candidate.includes('/')) return null

  // Return the slug verbatim, case preserved. The vCard app's lookup
  // is case-sensitive (see SLUG_RE), so `PtrsjZk` and `ptrsjzk`
  // resolve to different cards, or to none.
  if (!SLUG_RE.test(candidate)) return null
  return candidate
}

/**
 * Generate the SVG markup for the hosted-vCard QR. Options here are
 * locked in lockstep with the vCard app's studio — see file header.
 * Don't tune one without tuning the other; the golden-fixture test
 * will catch the drift but the proof-vs-print divergence in
 * production would happen at the same moment.
 *
 * Returns the SVG as a string so the caller can stash it as a Blob
 * for upload, render it inline via dangerouslySetInnerHTML for a
 * preview, or offer it as a download.
 */
export async function generateVcardQrSvg(slug: string): Promise<string> {
  const url = vcardUrlForSlug(slug)
  return QRCode.toString(url, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    color: { dark: '#14130f', light: '#ffffff' },
  })
}
