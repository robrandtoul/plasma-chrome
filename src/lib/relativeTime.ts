// Tiny relative-time formatter for the designer dashboard and
// proof detail page. Keeps output terse and consistent with the
// dashboard's existing date chrome:
//
//   under a minute     → "just now"
//   under an hour      → "Nm ago"
//   under 48 hours     → "Nh ago"
//   under a week       → "Nd ago"
//   older              → absolute date ("12 Mar 2025")
//
// No i18n pluralisation — "1m ago" / "2m ago" reads fine in the
// contexts this is used, and British-English summarising ("half
// an hour ago") would add weight without adding clarity.

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const now = Date.now()
  const diffMs = Math.max(0, now - then)

  if (diffMs < 60_000) return 'just now'

  const min = Math.round(diffMs / 60_000)
  if (min < 60) return `${min}m ago`

  const hr = Math.round(diffMs / 3_600_000)
  if (hr < 48) return `${hr}h ago`

  const days = Math.round(diffMs / 86_400_000)
  if (days < 8) return `${days}d ago`

  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

// Sibling of relativeTime() for native title-tooltip usage. Where
// relativeTime() is shown on screen ("2h ago"), this renders the
// precise moment ("21 Apr 2026, 14:32") so the user can hover to
// get exact-time. 24-hour British format, no seconds, the same
// "day month year" order the relative-time fallback uses so the
// two presentations feel consistent.
//
// Returns '' for invalid input so callers can pass a nullable ISO
// string into a title attribute without guarding first (an empty
// title suppresses the browser's native tooltip).
export function formatAbsoluteDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}
