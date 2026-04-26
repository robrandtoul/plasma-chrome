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
//
// If a customer's first name comes through wrong (e.g. a recipient
// list passed in via a single field), the designer can edit the
// rendered draft before sending; the helper does not have to be
// perfect, just sensible by default.

export function firstName(fullName: string | null | undefined): string {
  if (!fullName) return ''
  const trimmed = fullName.trim()
  if (trimmed === '') return ''
  return trimmed.split(/\s+/)[0]
}
