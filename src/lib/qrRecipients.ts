// Who is each QR code for?
//
// A QR row with associated_name = null means "shared": the same code
// prints on every card, and the customer page shows it under every
// recipient (QrCodePanel groups by name, then appends the shared
// ones to each group). That is the right answer for a company
// website and the wrong answer for a personal LinkedIn link — and
// nothing in the form told the two apart, because a hand-dropped QR
// simply defaulted to shared.
//
// It reached a customer. TKO Marketing's v2 (7 Aug 2026) carried
// three QR codes, one per director, every one left at the default.
// The proof page duly showed all three codes under all three names,
// and each director approved with a note saying which of them was
// actually theirs. The artwork itself was correct throughout — this
// is a proofing-page error, not a production one, which is exactly
// why it survived to the customer.
//
// Notably the artwork grid has demanded this decision for images all
// along ("Assign every image to a recipient (none left as 'shared')"
// in missingFieldItems). QRs are being brought into line with it.
//
// Two rules, both pure so the new-version and edit-version forms can
// share them without either page owning the logic:
//
//   needsRecipientChoice — a blocker. On a version with 2+
//   recipients a newly-added QR must be assigned deliberately.
//   "All recipients (shared)" remains a perfectly good answer; the
//   rule only insists it is chosen rather than inherited.
//
//   allSharedQrWarning — a nudge, never a blocker. Catches the shape
//   the blocker cannot see, because the blocker only ever fires on
//   entries added in this session: codes carried forward from an
//   earlier version, or genuinely-picked shared ones that add up to
//   the TKO pattern anyway.
//
// Tests live in qrRecipients.test.ts.

/**
 * The subset of a QrEntry these rules read. Declared locally rather
 * than imported from the component so this stays a pure lib with no
 * React dependency (and no import cycle back through the form).
 */
export interface QrRecipientEntry {
  /** Recipient assignment. Null = shared across every printed copy. */
  associatedName: string | null
  /**
   * Has a human actually made the call? Undefined means "not asked"
   * — carried-forward entries, and everything added before this rule
   * existed — and is deliberately treated as chosen, so the blocker
   * only ever fires on a decision the designer is present to make.
   * Only ever set false by the form, and only on versions where the
   * picker is on screen to answer it.
   */
  recipientChosen?: boolean
  /** Decoded payload, used to tell "one code per person" from a triple-upload. */
  decodedData?: string
  /**
   * New-version carry state. False means the entry is being dropped
   * from this version, so it should not colour the warning.
   */
  keep?: boolean
}

/** Recipients with a real name on them, whitespace ignored. */
function roster(names: string[]): string[] {
  return names.map((n) => n.trim()).filter((n) => n.length > 0)
}

/**
 * Is "who is this for?" a real question on this version?
 *
 * Only with 2+ recipients. On a single-recipient version, shared and
 * that one person resolve to the same customer-page placement and the
 * same approval-slot QR coordinates, so the form doesn't render the
 * picker at all — and a rule that demanded an answer there would
 * block Save with no control on screen to satisfy it.
 *
 * That is also why every rule below re-checks the roster rather than
 * trusting the flag alone: a designer can add QRs to a three-name
 * version and then delete two names, at which point the picker
 * disappears and any outstanding choice must evaporate with it.
 */
export function recipientChoiceApplies(names: string[]): boolean {
  return roster(names).length > 1
}

/** Entries still waiting for the designer to say who they're for. */
export function unchosenQrEntries<T extends QrRecipientEntry>(
  entries: T[],
  names: string[],
): T[] {
  if (!recipientChoiceApplies(names)) return []
  return entries.filter((e) => e.recipientChosen === false && e.keep !== false)
}

/** True while any QR on the version still needs an owner. Blocks Save. */
export function needsRecipientChoice(
  entries: QrRecipientEntry[],
  names: string[],
): boolean {
  return unchosenQrEntries(entries, names).length > 0
}

/**
 * The TKO shape: as many shared codes as there are recipients, all
 * different from one another, none assigned to anybody.
 *
 * All three conditions earn their place. Fewer shared codes than
 * recipients is the ordinary "one company website on every card"
 * case and must stay silent. A code that IS assigned means the
 * designer is using the picker, so the rest are their business. And
 * identical payloads mean the same code was uploaded N times — a
 * different mistake, with a different fix, which this copy would
 * misdescribe.
 *
 * Returns the message to show, or null to stay quiet.
 */
export function allSharedQrWarning(
  entries: QrRecipientEntry[],
  names: string[],
): string | null {
  const people = roster(names)
  if (people.length < 2) return null

  const kept = entries.filter((e) => e.keep !== false)
  if (kept.length !== people.length) return null
  if (kept.some((e) => e.associatedName != null)) return null

  const payloads = new Set(
    kept.map((e) => (e.decodedData ?? '').trim()).filter((d) => d.length > 0),
  )
  if (payloads.size !== kept.length) return null

  return (
    `All ${kept.length} QR codes are set to print on every card. ` +
    `With ${people.length} recipients and ${kept.length} different codes, ` +
    `each one usually belongs to a specific person — check the “Applies to” ` +
    `picker on each code before saving.`
  )
}
