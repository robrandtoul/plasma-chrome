// The Stock Control hand-off checks shown on the place-order review page.
//
// place-order runs public.create_order_handoff in validate-only mode alongside
// every preview and hands back what it found. The two severities stopped being
// the same kind of thing the moment the direct hand-off went live:
//
//   * a PROBLEM is what create_order_handoff refuses to import. On confirm the
//     same RPC runs for real (p_validate_only:false), returns the same
//     messages, and place-order fails the placement with them — so a problem on
//     screen is a Confirm that will fail.
//   * a WARNING is advisory. The job goes in, with the compromise it names.
//
// This exists because the box said otherwise. Order 403976 (Ayla Advisory,
// gilded letterpress) showed "A letterpress order needs its Front, Core and
// Back colours." under a footer reading "These checks don't block placing the
// order", and confirm then failed with exactly that sentence. The designer,
// reasonably, tried to fix it by editing the hand-off message — which the
// hand-off never reads.
//
// While `settings.direct_handoff_mode` is 'shadow' the legacy path still places
// the order and nothing here blocks, which is what the old copy was written
// for. The preview's `blocking` flag says which world the page is in.

export interface HandoffFinding {
  code: string
  message: string
}

// Problems the page should NOT show as hand-off defects.
//
// `supplier_missing` ("Choose a supplier to order from.") is not a defect —
// it's the question this page asks. Before a pick the payload carries a null
// supplier id, so validation reports it on every supplier-route preview, and
// the page already blocks Confirm with that exact sentence via its own
// `mustChoose`. Showing it again as a red "Stock Control can't accept this
// order" would turn an unmade choice into an alarm.
const PAGE_OWNS: ReadonlySet<string> = new Set(['supplier_missing'])

export function visibleHandoffProblems(problems: HandoffFinding[]): HandoffFinding[] {
  return problems.filter((p) => !PAGE_OWNS.has(p.code))
}

// The designer-side fix, for problems whose message names a requirement
// without saying where the value lives. Most don't need one — the material
// mapping problems already end in "set the mapping in Admin → Catalogue data →
// Stock materials", and `number_missing` already says to link the Dropbox
// folder first.
//
// ⚠ The letterpress hint carries its own caveat deliberately. The version form
// only renders the Front/Core/Back pickers for un-gilded letterpress
// (LAYER_COLOUR_MATERIAL_CODES in src/lib/letterpress.ts — gilding hides the
// layered edge, so the pickers were judged pointless), while the hand-off
// requires the three colours for BOTH letterpress codes. A gilded order
// therefore cannot satisfy this from the form, which is exactly what happened
// on 403976. Sending that designer to a section that doesn't render would
// reproduce the confusion this fix exists to end.
const HINTS: Record<string, string> = {
  letterpress_colours_missing:
    'Set them on the proof version (Edit version → Paper layers). Gilded letterpress doesn’t show those pickers, so a gilded order needs them set on the record directly.',
}

export function handoffProblemHint(code: string): string | null {
  return HINTS[code] ?? null
}

// The sentence on the disabled Confirm button's tooltip. Self-contained — it
// quotes the problem rather than pointing at the box, because a tooltip is
// read with the pointer over the button and "see above" is no help there.
export function handoffBlockReason(problems: HandoffFinding[]): string | null {
  const visible = visibleHandoffProblems(problems)
  if (visible.length === 0) return null
  const head = `Stock Control can’t accept this order yet: ${visible[0].message}`
  return visible.length > 1 ? `${head} (+${visible.length - 1} more)` : head
}
