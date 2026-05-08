// Tiny relative-time formatter for the designer dashboard and
// proof detail page. Keeps output terse and consistent with the
// dashboard's existing date chrome:
//
//   under a minute     → "just now"
//   under an hour      → "Nm ago"
//   under 24 hours     → "Nh ago"
//   under 7 days       → "Nd ago"
//   under 4 weeks      → "Nw ago"
//   older              → short absolute date ("8 May" / "8 May 2025")
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

  // Floor (not round) to avoid rollover jitter at the unit
  // boundaries: a value of 59m30s rounded would jump straight
  // from "59m ago" to "1h ago" and back as the clock ticked.
  // Floor lets the next branch pick up exactly when the unit
  // truly changes.
  const min = Math.floor(diffMs / 60_000)
  if (min < 60) return `${min}m ago`

  const hr = Math.floor(diffMs / 3_600_000)
  if (hr < 24) return `${hr}h ago`

  const days = Math.floor(diffMs / 86_400_000)
  if (days < 7) return `${days}d ago`

  const weeks = Math.floor(days / 7)
  if (weeks < 4) return `${weeks}w ago`

  // Short absolute date matches the dashboard's existing chrome:
  // current-year values drop the year ("8 May"), older values
  // include it ("8 May 2025") so the reader can disambiguate.
  const then_d = new Date(iso)
  const includeYear = then_d.getFullYear() !== new Date().getFullYear()
  return then_d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(includeYear ? { year: 'numeric' } : {}),
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
