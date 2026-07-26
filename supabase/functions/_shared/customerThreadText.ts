// The text posted onto the customer's Help Scout thread when they approve,
// request changes, or pick a variant.
//
// Extracted from proof-action so it can be unit-tested headlessly (`pnpm
// test:thread-text`) — the same reason orderPricing.ts and nudgeDecision.ts
// live here. The function body is unchanged by the move; the tests pin the
// wording that customers and designers actually read, including the one
// ordering rule that is easy to reverse by accident: a change request lists
// the customer's pins ABOVE their message.

/** A pin as it arrives from the customer page, after validation. */
export interface IncomingPin {
  imageId: string | null
  side: 'front' | 'back' | null
  x: number
  y: number
  body: string
}

export type EventType = 'approve' | 'request_changes'

export const SHARED_APPROVAL_KEY = '__shared__'

// ── Customer thread copy ──────────────────────────────────────────────────────
//
// Phrasing per the Phase 2 prompt. Plain text — Help Scout renders
// linebreaks but no markdown for customer-side threads.

export function buildCustomerThreadText(
  eventType: EventType,
  actorName: string,
  recipientName: string,
  comment: string | null,
  fileNames: string[],
  proofUrl: string | null,
  // material_options dimension surface for the active option, looked
  // up from the DB at the call site. Both null when the version has
  // no option dimension OR the material_options row was not found
  // (defensive — the in-function trigger validates membership before
  // we get here, so this should be unreachable in practice).
  optionDisplayLabel: string | null,
  optionDimensionLabel: string | null,
  // Variant-round display name (migrations 000138 + 000139). Non-null
  // routes the function to the variant-round branch below; null falls
  // through to the standard approve / request_changes branches with
  // byte-identical output to the pre-variant-rounds shape.
  variantDisplayName: string | null,
  // True when the version offers 2+ material options (a real finish /
  // species switcher). On the approve branch this suppresses both the
  // active-tab finish suffix and the all-options file manifest — the
  // toggle position isn't a real finish choice (finish is settled over
  // email for metal), so the confirmation must not assert one.
  hasMultipleOptions: boolean,
  // Pins the customer placed alongside a change request (migration 000347).
  // Only ever non-empty on the request_changes branch — the approve path does
  // not offer pinning, so approvals keep their exact previous wording.
  pins: IncomingPin[] = [],
): string {
  // SHARED_APPROVAL_KEY suppresses the "for {name}" suffix — the
  // shared section IS the whole proof (all-shared / membership /
  // single-design case). Named recipients get the suffix.
  const recipientSuffix =
    recipientName === SHARED_APPROVAL_KEY ? '' : ` for ${recipientName}`
  // Option suffix — consumed by the request_changes branch only; the
  // approve branch intentionally omits it (the active tab isn't a
  // finish choice, so an approval must not claim one). Reads e.g.
  // " for the Brushed finish" / " for the
  // Black Walnut species" / " for the Optional CNC cutting"
  // (dedup case — the display_name already ends with the dimension
  // noun, so we drop the redundant trailing word). Suppressed when
  // either piece is missing so we never emit "for the  finish" /
  // "for the Brushed".
  //
  // Dedup rule: if the display_name's trailing whitespace-delimited
  // word equals the dimension label (case-insensitive, whole-word),
  // drop the suffix and emit display_name only. Otherwise keep both.
  // This handles the carbon-fibre "Optional CNC cutting" / "Cutting"
  // pair without special-casing — same logic would dedup any future
  // material whose option codes carry the dimension noun in their
  // display name.
  const optionSuffix = (() => {
    if (!optionDisplayLabel || !optionDimensionLabel) return ''
    const tail = optionDisplayLabel.trim().split(/\s+/).pop() ?? ''
    const tailMatchesDimension =
      tail.toLowerCase() === optionDimensionLabel.toLowerCase()
    return tailMatchesDimension
      ? ` for the ${optionDisplayLabel}`
      : ` for the ${optionDisplayLabel} ${optionDimensionLabel.toLowerCase()}`
  })()
  const fileLine = fileNames.length > 0 ? fileNames.join(', ') : '(no files)'
  const urlLine = proofUrl ? `View the proof: ${proofUrl}\n` : ''

  // ── Variant-round branch ──────────────────────────────────────────────
  // Routes ahead of the standard approve / request_changes branches so
  // those return byte-identical output to the pre-variant-rounds shape
  // when variantDisplayName is null. Variant rounds always travel as
  // request_changes server-side (the edge function rejects 'approve'),
  // so eventType here is always request_changes for this branch — but
  // we don't read it: the copy template is selection-shaped, not
  // approval-shaped. The recipient suffix is suppressed (variant
  // rounds always use SHARED_APPROVAL_KEY) and the file list block
  // is dropped — the proof URL is the visual reference. Comment is
  // required server-side for variant rounds, so the quoted block is
  // always populated.
  if (variantDisplayName != null) {
    return (
      `${actorName} chose: ${variantDisplayName}.\n\n` +
      `"${comment ?? ''}"\n\n` +
      urlLine +
      `— Posted via the proof viewer`
    )
  }

  if (eventType === 'approve') {
    const commentBlock = comment ? `"${comment}"\n\n` : ''
    // Multi-option versions: drop the finish suffix AND the file
    // manifest. The suffix is just whichever preview tab was open at
    // click time, and the manifest lists every option's files (all of
    // Natural + Brushed + Mirror, front + back) — together they imply
    // a finish was chosen here when it wasn't. Single-/no-option
    // versions keep the manifest, which is unambiguous.
    const fileBlock = hasMultipleOptions ? '' : `Approved version: ${fileLine}\n`
    return (
      `Approved by ${actorName}${recipientSuffix}.\n\n` +
      commentBlock +
      fileBlock +
      urlLine +
      `— Posted via the proof viewer`
    )
  }

  // request_changes — comment is required and always present.
  //
  // Pins list ABOVE the note, because each pin already carries the specific
  // instruction while the note is usually the general framing. Because every
  // pin has text, this degrades to a plain numbered list — which reads better
  // in Help Scout than today's single prose blob, with no attachment needed.
  // Empty when there are no pins, leaving the output byte-identical to the
  // pre-pins shape.
  const pinBlock =
    pins.length > 0
      ? pins
          .map((p, i) => {
            const face = p.side ? ` (${p.side})` : ''
            return `${i + 1}.${face} ${p.body}`
          })
          .join('\n') + '\n\n'
      : ''

  return (
    `Changes requested by ${actorName}${recipientSuffix}${optionSuffix}.\n\n` +
    pinBlock +
    `"${comment ?? ''}"\n\n` +
    `Version: ${fileLine}\n` +
    urlLine +
    `— Posted via the proof viewer`
  )
}
