// Vet a freely-edited order hand-off message before it can be sent to a supplier
// or posted as an in-house production note. The "Place order" review screen lets
// the reviewer edit the whole message; this guards the bit that isn't free text:
// the machine-read spec lines (Qty / Material / … / "name — 50" split lines) that
// Stock Control's ingester parses. That ingester is first-wins per key and
// ignores unknown lines, so two failure modes must be caught —
//   1. a genuine spec line was DROPPED (the order imports wrong or not at all);
//   2. an extra line was ADDED that the parser could mistake for one (a
//      conflicting duplicate key it would read FIRST, or a stray split-shaped
//      line that breaks the per-person sum).
//
// Substring matching is unsound here (deleting "Qty: 50" would pass while
// "Qty: 500" appears anywhere), so the check works on whole, trimmed lines.
//
// This is the client mirror, kept IN LOCKSTEP with the authoritative server copy
// in supabase/functions/place-order/index.ts (checkEditedMessage + the regexes).
// The edge function can't import from src/ (Deno, self-contained deploy), so the
// two are duplicated deliberately — change both together.

export const SPEC_KEY_RE = /^(Qty|Card|Material|Type|Thickness|Finish|Date required|Must ship by|Packaging|Per person|Ink on front|Ink on back|Artwork)\s*:/i
export const SPLIT_SHAPE_RE = /^.+?\s*[—–:-]\s*\d{1,6}$/

// Returns a list of human-readable problems with the edited message (empty = ok
// to send). `criticalLines` are the spec lines the server generated for this
// order (preview.critical_lines).
export function checkEditedMessage(message: string, criticalLines: string[]): string[] {
  const problems: string[] = []
  const msgLines = message.split('\n').map((l) => l.trim())
  const present = new Set(msgLines)
  const critical = new Set(criticalLines.map((l) => l.trim()))
  // 1. Every machine-read spec line must still be present, whole and verbatim.
  for (const l of criticalLines) {
    if (!present.has(l.trim())) problems.push(`Missing required line: “${l.trim()}”`)
  }
  // 2. No ADDED line may look like a spec line the parser would act on.
  for (const l of msgLines) {
    if (!l || critical.has(l)) continue
    if (SPEC_KEY_RE.test(l) || SPLIT_SHAPE_RE.test(l)) problems.push(`Stock Control may misread this line: “${l}”`)
  }
  return problems
}
