// "Same as last time" guidance for returning customers (migration 000364).
//
// A returning customer usually wants exactly what they had before, but locking
// the pay link to the old spec would stop them choosing differently, and a
// fully open chooser risks an accidental switch. The answer is guided-open:
// the choosers stay forced-choice (nothing pre-selected), the option they had
// last time carries a "Your last order · March 2022" badge, and picking a
// different option shows a calm note — change stays allowed, it just becomes
// conscious. When the old option is no longer in the range, the page says so
// plainly instead of badging nothing silently.
//
// This module is the single source of truth for the matching rules and the
// customer-facing copy, consumed by BOTH pay pages (OrderPayPage and
// OrderGroupPayPage) so a member of a combined payment reads identically to a
// single-order link. Pure functions only — tested by previousSpec.test.ts
// (pnpm test:previous-spec), which also cross-checks the parser against the
// server-side sanitiser in supabase/functions/_shared/previousSpec.ts.

/** The stored orders.previous_spec shape. Mirrors the server sanitiser's output. */
export interface PreviousSpec {
  variant_id: string | null
  variant_label: string | null
  option_id: string | null
  option_label: string | null
  quantity: number | null
  label: string | null
  source: 'auto' | 'manual'
}

export type ChooserKind = 'thickness' | 'finish'

/** What one chooser (thickness or finish) should render for a previous spec. */
export interface ChooserGuidance {
  /** Offered option (variant/finish id) to badge "Your last order", or null. */
  badgeId: string | null
  /** Badge text — "Your last order" or "Your last order · March 2022". */
  badgeText: string | null
  /**
   * True while a last-order badge is showing, so catalogue recommendation
   * badges ("Most popular") stand down — the page must never nudge a
   * returning customer towards a different option than their own history.
   */
  suppressCatalogueBadges: boolean
  /**
   * Under-chooser note: either the picked-something-different nudge, or the
   * previous-option-no-longer-offered explainer. Null = nothing to say.
   */
  note: string | null
}

const NO_GUIDANCE: ChooserGuidance = {
  badgeId: null,
  badgeText: null,
  suppressCatalogueBadges: false,
  note: null,
}

// Same caps + surrogate handling as the server sanitiser
// (supabase/functions/_shared/previousSpec.ts) — the create-order path always
// stores capped values, but orders are also writable by any authenticated
// session under RLS, so the anon-facing parse must enforce the bounds itself
// rather than trust the column. Parity-tested against the server copy.
const str = (value: unknown, cap: number): string | null => {
  if (typeof value !== 'string') return null
  let s = value.trim().slice(0, cap)
  const last = s.charCodeAt(s.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1)
  return s || null
}

/**
 * Tolerant read of the previous_spec jsonb off an order payload. The server
 * sanitised it at write time, but the pay page is anon-facing and the payload
 * crosses an RPC boundary, so parse defensively — garbage in, null out (or
 * capped), page renders exactly as it did before this feature existed.
 */
export function parsePreviousSpec(raw: unknown): PreviousSpec | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const variant_id = str(r.variant_id, 64)
  const variant_label = str(r.variant_label, 120)
  const option_id = str(r.option_id, 64)
  const option_label = str(r.option_label, 120)
  let quantity: number | null = null
  if (r.quantity != null) {
    const q = Number(r.quantity)
    if (Number.isInteger(q) && q > 0 && q <= 1_000_000) quantity = q
  }
  const label = str(r.label, 60)
  if (!variant_id && !variant_label && !option_id && !option_label && quantity == null) return null
  return {
    variant_id,
    variant_label,
    option_id,
    option_label,
    quantity,
    label,
    source: r.source === 'auto' ? 'auto' : 'manual',
  }
}

/** "Your last order" / "Your last order · March 2022". */
export function previousBadgeText(spec: PreviousSpec): string {
  return spec.label ? `Your last order · ${spec.label}` : 'Your last order'
}

/**
 * Guidance for one chooser. `offeredIds` are the ids the chooser is actually
 * rendering (SpecVariantChoice[].id / SpecFinishChoice[].id); `chosenId` is
 * the customer's current selection (null until they tap).
 */
export function chooserGuidance(
  kind: ChooserKind,
  spec: PreviousSpec | null,
  offeredIds: string[],
  chosenId: string | null,
): ChooserGuidance {
  if (!spec) return NO_GUIDANCE
  const prevId = kind === 'thickness' ? spec.variant_id : spec.option_id
  const prevLabel = kind === 'thickness' ? spec.variant_label : spec.option_label
  if (!prevId && !prevLabel) return NO_GUIDANCE

  if (prevId && offeredIds.includes(prevId)) {
    const differs = chosenId != null && chosenId !== prevId
    return {
      badgeId: prevId,
      badgeText: previousBadgeText(spec),
      suppressCatalogueBadges: true,
      note: differs
        ? `Just so you know — this is a different ${kind} from your last order${prevLabel ? ` (you had ${prevLabel})` : ''}.`
        : null,
    }
  }

  // The previous option isn't among this order's choices. That can mean
  // retired from the catalogue OR simply not offered on this order (the
  // finish chooser is scoped to the proof's artwork tabs; a thickness can
  // lack price tiers in this currency) — the page can't tell which, so the
  // copy must be true either way: "isn't available on this order", never
  // "we no longer offer". Say it plainly when we can name the old option
  // (the frozen label survives a retired variant); stay silent when we
  // can't — a vague "something changed" note is noise, not guidance.
  if (prevLabel) {
    return {
      ...NO_GUIDANCE,
      note: `Your last order was ${prevLabel}, which isn’t available on this order — the ${
        kind === 'thickness' ? 'thicknesses' : 'finishes'
      } above are the current options.`,
    }
  }
  return NO_GUIDANCE
}

/**
 * Hint under the open-quantity input. Deliberately a static line rather than a
 * changed-your-mind nudge: quantity is typed, not tapped, so a difference note
 * would nag on every keystroke.
 */
export function quantityHint(spec: PreviousSpec | null, opts?: { split?: boolean }): string | null {
  if (!spec || spec.quantity == null) return null
  const total = opts?.split ? ' in total' : ''
  const when = spec.label ? ` — ${spec.label}` : ''
  return `Last time you ordered ${spec.quantity.toLocaleString()}${total}${when}.`
}
