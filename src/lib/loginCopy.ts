// Shared defaults + types for the admin-editable login-page copy
// (migration 000206). These defaults are the seed the migration writes
// AND the runtime fallback used by publicSettings.ts when a column is
// null / the RPC is unreachable, so the login page always renders
// readable copy. Keep in lockstep with the migration seed.

export interface LoginStat {
  /** Big mono value, e.g. "142" or "24 h". */
  value: string
  /** Caption beneath it, e.g. "proofs sent this year". */
  label: string
}

// login_headline is stored with newlines; the page renders it with
// white-space: pre-line (replacing the old hard-coded <br> tags).
export const LOGIN_HEADLINE_DEFAULT = 'Every revision,\nevery recipient,\none private link.'

export const LOGIN_DESCRIPTION_DEFAULT =
  'The signed-in side of the proof viewer. Drop in a JPEG, set the spec, snapshot the price. The customer reads, replies, signs off. No JPEGs in inboxes, no spreadsheet trail.'

export const LOGIN_STATS_DEFAULT: LoginStat[] = [
  { value: '142', label: 'proofs sent this year' },
  { value: '03', label: 'designers on the team' },
  { value: '24 h', label: 'typical turnaround' },
]

export const LOGIN_FORM_HEADING_DEFAULT = 'Welcome back'

export const LOGIN_FORM_SUBCOPY_DEFAULT =
  'Accounts are issued by an admin. New here? Ask Rob for a temporary password and change it from the header on first sign-in.'

// Defensive normaliser for whatever the RPC returns for login_stats.
// Falls back to the defaults when the value is missing/malformed, and
// drops any malformed entries. Keeps at most 3 (the page renders three).
export function normaliseLoginStats(raw: unknown): LoginStat[] {
  if (!Array.isArray(raw)) return LOGIN_STATS_DEFAULT
  const rows = raw
    .map((r) => {
      if (!r || typeof r !== 'object') return null
      const o = r as Record<string, unknown>
      if (typeof o.value !== 'string' || typeof o.label !== 'string') return null
      return { value: o.value, label: o.label }
    })
    .filter((r): r is LoginStat => r !== null)
    .slice(0, 3)
  return rows.length > 0 ? rows : LOGIN_STATS_DEFAULT
}
