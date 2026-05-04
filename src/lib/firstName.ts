import { titleCase } from './titleCase'

// First-name extraction from a full name string. Used to seed the
// {first_name} variable in reply templates from the contacts table's
// single full_name column. Naive whitespace split is good enough for
// the typical patterns:
//
//   "Kevin Knowles"     → "Kevin"
//   "Mary Jane"         → "Mary"
//   "Jean-Paul Garnier" → "Jean-Paul"
//   "Madonna"           → "Madonna"
//   ""                  → ""
//   "  Kevin  Knowles"  → "Kevin"
//   "KEVIN KNOWLES"     → "Kevin"        (Help Scout caps lock)
//   "Mr. Kevin Knowles" → "Kevin"        (skip honorifics)
//   "Dr Jane Doe"       → "Jane"
//
// If a customer's first name comes through wrong (e.g. a recipient
// list passed in via a single field), the designer can edit the
// rendered draft before sending; the helper does not have to be
// perfect, just sensible by default.

const HONORIFIC_RE = /^(?:mr|mrs|ms|mx|dr|prof|sir|dame|lord|lady|rev)\.?$/i

export function firstName(fullName: string | null | undefined): string {
  if (!fullName) return ''
  const trimmed = fullName.trim()
  if (trimmed === '') return ''
  const parts = trimmed.split(/\s+/)
  // Skip a single leading honorific so "Mr. Kevin" → "Kevin",
  // not "Mr.". Only the first token is checked — no point
  // over-engineering for "Dr. Mr. Foo".
  const candidate = parts.length > 1 && HONORIFIC_RE.test(parts[0])
    ? parts[1]
    : parts[0]
  return titleCase(candidate)
}
