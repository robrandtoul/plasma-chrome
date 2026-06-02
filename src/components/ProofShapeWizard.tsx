// ProofShapeWizard — the guided proof-type chooser that replaces the
// old "Standard proof vs Variant round" toggle at the top of the
// version form (structure: docs/proof-type-wizard-structure.md, which
// reworks the question script in docs/proof-type-wizard-spec.md §4).
//
// It is a SINGLE-PAGE PROGRESSIVE-DISCLOSURE wizard, not a paged
// Next/Back flow: only the first unanswered question is shown open;
// answered questions collapse to a compact row with a "Change"
// control; reopening a question via "Change" clears that answer and
// every answer after it.
//
// STRUCTURE (see the structure doc for the rationale). The first
// question is a single three-way that maps 1:1 onto the three shapes,
// phrased by the customer's RELATIONSHIP to the artwork rather than by
// counting it:
//   Q1  Which best describes this proof?
//       • A batch of cards for one or more people → Recipients (one question)
//       • Cards with no personal contact details  → Set branch (Q2…)
//       • Alternatives to choose from             → Selection branch (QS)
// Counting only happens on the Set branch (Q2 "how many layouts"), with
// "layout" defined on the spot so a finish variant of one design can't
// be miscounted as several.
//
// The wizard is a CONTROLLED component. It owns no business state —
// the host page passes the current `answers`, gets `onChange` back,
// and reads the resolved shape via the exported pure helpers below
// (resolveShape / deriveFormState). Those helpers are the SINGLE
// source that maps a resolved shape onto the form's existing mode
// state (isVariantRound, isPerDirectionPricing, cardType,
// hasPersonalisation). Keeping the mapping in one place means the
// Phase 2 `shape` column is a clean drop-in, not a refactor.
//
// Reserved vocabulary (used verbatim in the copy, per the spec):
//   layout          = one design
//   set             = the whole proof
//   batch           = a quantity of identical cards
//   allocated       = tied to a named person, proofed individually
//   personalisation = per-card unique data (member name as variable
//                     data, numbering, IDs, QR)

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'

// ── Answer model ────────────────────────────────────────────────────────────
// One field per question in the script. null = not yet answered. The
// two branches (Set vs Selection) share this object; only the fields
// relevant to the chosen branch are ever populated. The host pages
// treat this type as opaque (they never read individual keys), so the
// key names are an internal concern of this module.
export type WizardAnswers = {
  // Q1 (always): the structural family. Merges the old scope (all/one)
  // and allocated (yes/no) questions, since a pick-one job is never
  // per-named-person — the 2×2 has one empty cell, leaving three options.
  family: 'recipients' | 'set' | 'selection' | null
  // Set Q2: how many layouts in this set?
  layouts: 'one' | 'several' | null
  // Set Q3 (only when several layouts): same material guard.
  sameMaterial: 'yes' | 'no' | null
  // Set Q3 follow-up (only when different materials): split into
  // separate projects, or keep together anyway. 'keep' makes the
  // collection span materials, which the single-material grid can't
  // price, so it forces a custom quote (see deriveFormState).
  multiMaterialChoice: 'split' | 'keep' | null
  // Set personalisation: the single material-gated Set question. Shown
  // once a material is chosen iff it supports personalisation; there is
  // no card-style precondition.
  personalised: 'yes' | 'no' | null
  // Selection QS: same material or different.
  selectionMaterial: 'same' | 'different' | null
}

export const EMPTY_ANSWERS: WizardAnswers = {
  family: null,
  layouts: null,
  sameMaterial: null,
  multiMaterialChoice: null,
  personalised: null,
  selectionMaterial: null,
}

// ── Resolved shape ────────────────────────────────────────────────────────────
export type ResolvedShape =
  | { kind: 'recipients' }
  | { kind: 'set-single'; personalised: boolean }
  | { kind: 'set-collection'; personalised: boolean; multiMaterial: boolean }
  | { kind: 'selection'; perDirection: boolean }
  | { kind: 'split-guard' } // Q3 "split" chosen — deliberately not a saveable shape

// Map answers → resolved shape, or null while the path is incomplete.
// `materialChosen` and `materialSupportsPersonalisation` gate the Set
// personalisation question: once a material is chosen, if it supports
// personalisation the answer is required to resolve; otherwise (no
// material yet, or a material that does not support it) personalisation
// is off and the Set resolves without asking.
export function resolveShape(
  a: WizardAnswers,
  opts: { materialChosen: boolean; materialSupportsPersonalisation: boolean },
): ResolvedShape | null {
  if (a.family === 'recipients') return { kind: 'recipients' }

  if (a.family === 'selection') {
    if (a.selectionMaterial === 'same') return { kind: 'selection', perDirection: false }
    if (a.selectionMaterial === 'different') return { kind: 'selection', perDirection: true }
    return null
  }

  if (a.family !== 'set') return null

  // Set branch. Determine single vs collection, and whether it is a
  // kept-together multi-material collection (which forces a custom quote).
  let collection: boolean
  let multiMaterial = false
  if (a.layouts === 'one') {
    collection = false
  } else if (a.layouts === 'several') {
    if (a.sameMaterial === 'no') {
      if (a.multiMaterialChoice === 'split') return { kind: 'split-guard' }
      if (a.multiMaterialChoice === 'keep') multiMaterial = true
      else return null
    } else if (a.sameMaterial !== 'yes') {
      return null
    }
    collection = true
  } else {
    return null
  }

  // Personalisation — the single material-gated Set question.
  let personalised = false
  if (opts.materialChosen && opts.materialSupportsPersonalisation) {
    // The answer is required to resolve.
    if (a.personalised === 'yes') personalised = true
    else if (a.personalised === 'no') personalised = false
    else return null
  }
  // else: no material yet, or it doesn't support personalisation — the
  // question is never shown and personalisation stays off.

  return collection
    ? { kind: 'set-collection', personalised, multiMaterial }
    : { kind: 'set-single', personalised }
}

// The single mapping from a resolved shape onto the form's existing
// mode state. Returns null for shapes that should not drive the form
// (incomplete, or the split guard). Phase 2 adds the `shape` column;
// it slots in here without touching any call site.
export type FormModeState = {
  isVariantRound: boolean
  isPerDirectionPricing: boolean
  cardType: 'business' | 'membership'
  hasPersonalisation: boolean
  // True only for a kept-together multi-material Set (collection): the
  // single-material price grid can't price it, so the host page must
  // put the version on a custom quote and keep it there.
  forceCustomQuote: boolean
}

export function deriveFormState(shape: ResolvedShape | null): FormModeState | null {
  if (!shape) return null
  switch (shape.kind) {
    case 'recipients':
      return { isVariantRound: false, isPerDirectionPricing: false, cardType: 'business', hasPersonalisation: false, forceCustomQuote: false }
    case 'set-single':
      // The no-name shared-design shape is membership-with-empty-names in
      // the current schema (cardType='membership' for every Set); only
      // personalisation distinguishes proofs. The Phase 2 shape column
      // will carry the structure explicitly.
      return { isVariantRound: false, isPerDirectionPricing: false, cardType: 'membership', hasPersonalisation: shape.personalised, forceCustomQuote: false }
    case 'set-collection':
      // A kept-together multi-material collection forces a custom quote
      // (multiMaterial); a same-material collection prices as normal.
      return { isVariantRound: false, isPerDirectionPricing: false, cardType: 'membership', hasPersonalisation: shape.personalised, forceCustomQuote: shape.multiMaterial }
    case 'selection':
      return { isVariantRound: true, isPerDirectionPricing: shape.perDirection, cardType: 'business', hasPersonalisation: false, forceCustomQuote: false }
    case 'split-guard':
      return null
  }
}

// The DB value for proof_versions.shape (000210). The wizard's resolved
// shape is the single source; this is the one place the kind maps to the
// stored string, so the save paths never re-derive it. Returns null for
// the split guard and incomplete paths (which never save).
export function dbShape(
  shape: ResolvedShape | null,
): 'recipients' | 'set_single' | 'set_collection' | 'selection' | null {
  if (!shape) return null
  switch (shape.kind) {
    case 'recipients':
      return 'recipients'
    case 'set-single':
      return 'set_single'
    case 'set-collection':
      return 'set_collection'
    case 'selection':
      return 'selection'
    case 'split-guard':
      return null
  }
}

// Plain-English resolution for the running-resolution banner. Base
// phrase per shape, with ", personalised per card" appended only on the
// membership variants when personalisation is on. Display only — no
// commitment language ("produced" / "goes ahead") per the tone rules.
export function resolvedShapeLabel(shape: ResolvedShape | null): string | null {
  if (!shape) return null
  switch (shape.kind) {
    case 'recipients':
      return 'A separate card for each named person'
    case 'set-single':
      return shape.personalised
        ? 'One shared design, personalised per card'
        : 'One shared design, no individual names'
    case 'set-collection':
      return shape.personalised
        ? 'Several shared designs, all kept together, personalised per card'
        : 'Several shared designs, all kept together'
    case 'selection':
      return shape.perDirection
        ? 'Alternative designs on different materials, customer chooses one'
        : 'Alternative designs for the customer to choose from'
    case 'split-guard':
      return null
  }
}

// True once the wizard resolves to a concrete, saveable shape. The
// split guard and incomplete paths are not saveable.
export function isWizardResolved(shape: ResolvedShape | null): boolean {
  return shape != null && shape.kind !== 'split-guard'
}

// Best-effort reverse mapping for v2+ creation and edit, where the
// shape isn't stored yet (Phase 1) and must be inferred from existing
// fields. Pre-Phase-2 every existing proof is genuinely one of these:
// variant round → Selection, membership → Set (single, personalisation
// from the flag), business → Recipients.
export function deriveAnswersFromShape(input: {
  isVariantRound: boolean
  isPerDirectionPricing: boolean
  cardType: 'business' | 'membership'
  hasPersonalisation: boolean
}): WizardAnswers {
  const base = { ...EMPTY_ANSWERS }
  if (input.isVariantRound) {
    return { ...base, family: 'selection', selectionMaterial: input.isPerDirectionPricing ? 'different' : 'same' }
  }
  if (input.cardType === 'membership') {
    return {
      ...base,
      family: 'set',
      layouts: 'one',
      personalised: input.hasPersonalisation ? 'yes' : 'no',
    }
  }
  // business + standard proof → Recipients.
  return { ...base, family: 'recipients' }
}

// Seed the wizard from a loaded version, preferring the persisted shape
// column (000210) over the flags. shape is authoritative for the
// STRUCTURE (it's the only thing that tells set_single and set_collection
// apart — flags can't), while has_personalisation / is_per_direction_pricing
// fill in the sub-details. Falls back to the flags-only mapping when
// shape is null (legacy rows the 000211 backfill didn't cover, e.g.
// membership-with-tier-names). Used by both pages when loading an
// existing version, fixing the bug where a collection mis-seeded as
// set_single because the flags are identical.
export function deriveAnswersFromVersion(input: {
  shape: string | null
  isVariantRound: boolean
  isPerDirectionPricing: boolean
  cardType: 'business' | 'membership'
  hasPersonalisation: boolean
}): WizardAnswers {
  const base = { ...EMPTY_ANSWERS }
  const personalised = input.hasPersonalisation ? ('yes' as const) : ('no' as const)
  switch (input.shape) {
    case 'recipients':
      return { ...base, family: 'recipients' }
    case 'set_single':
      return { ...base, family: 'set', layouts: 'one', personalised }
    case 'set_collection':
      // Seeds as a single-material collection. The keep-together
      // multi-material override is UI-only (not persisted), so a
      // continued or edited collection reconstructs as same-material.
      return { ...base, family: 'set', layouts: 'several', sameMaterial: 'yes', personalised }
    case 'selection':
      return { ...base, family: 'selection', selectionMaterial: input.isPerDirectionPricing ? 'different' : 'same' }
    default:
      // Null / unknown shape — fall back to the flags-only mapping.
      return deriveAnswersFromShape({
        isVariantRound: input.isVariantRound,
        isPerDirectionPricing: input.isPerDirectionPricing,
        cardType: input.cardType,
        hasPersonalisation: input.hasPersonalisation,
      })
  }
}

// ── Worked-example scenarios ──────────────────────────────────────────────────
// One concrete, Plasma-specific situation per selectable option, revealed
// behind the info affordance next to each option. These ADD to the option's
// helper text, they do not restate it: the helper says what the option MEANS
// (at a glance), the scenario shows a real job where you would pick it. Keyed
// by question + option value so editing the copy is a one-line change here, in
// one place. Every scenario has been walked through the decision tree in
// docs/proof-type-wizard-structure.md and genuinely resolves to its own option.
const SCENARIOS = {
  // Q1 — the structural family.
  q1Recipients:
    "A law firm wants a batch of cards for each partner, each showing that partner's own name, title, and direct line.",
  q1Set:
    "A clinic's set of reference cards, ECG, blood pressure, dosage. A gym's identical membership cards. Neither is tied to a named person and the customer intends to order every card shown, so both belong here.",
  q1Selection:
    'A startup wants to see three different design directions for their card, then pick the one they like best and set the rest aside.',
  // Q2 — how many layouts (Set branch).
  q2One:
    'A coffee shop wants a single loyalty card design, the same card for every customer. One design, so one layout.',
  q2Several:
    'A clinic wants four different information cards, for booking, aftercare, opening hours, and contact, all kept together as one set.',
  // Q3 — same-material guard (Set, several layouts).
  q3Same:
    "The clinic's four reference cards, booking, aftercare, hours, and contact, all on the same brushed steel. Different designs, one material, so they stay together and are priced the same.",
  q3Different:
    'A restaurant group wants a walnut menu card, an acrylic table card, and a copper loyalty card, each on its own material.',
  // Q3 follow-up — the different-materials guard.
  guardSplit:
    'Those walnut, acrylic, and copper cards each price differently, so you split them into three projects, one per material, each priced correctly.',
  guardKeep:
    "The customer wants to see the walnut and acrylic cards together as one set, so you keep them in one proof. The page won't show pricing, so you'll quote it manually.",
  // Personalisation (Set, material-gated).
  q5Unique:
    "A members club wants each card to carry the member's name, a sequential number, and a unique QR code, so no two cards are the same.",
  q5Identical:
    'A festival wants 2,000 identical passes, all the same design, with no member names or numbers.',
  // Selection QS — same or different material.
  qsSame:
    'A bar wants to see two different designs for their loyalty card, both on the same matte black metal, then pick the one they prefer.',
  qsDifferent:
    "A client wants to see their card on walnut next to the same design on brushed steel, then pick one and set the other aside. The page won't show pricing, so you'll quote each option manually.",
} as const

// ── Presentational pieces ────────────────────────────────────────────────────

// A small, accessible worked-example affordance: an info icon beside an option
// that reveals its scenario on hover, keyboard focus, AND tap, and dismisses on
// mouse-out, blur, Escape, outside click, and scroll. The popover is portaled
// to <body> so the option card can never clip it, and it is clamped to the
// viewport so it stays readable on a narrow screen.
//
// The trigger is rendered as an absolutely-positioned SIBLING of the option's
// <label>, never a child, so activating it can never select the option. It
// stays interactive even when the radios are disabled (the read-only edit
// view), which is why selection-disabling lives on the <input>, not the
// <fieldset>.
const TIP_WIDTH = 264

function InfoTooltip({
  scenario,
  optionLabel,
  onDark = false,
  className = '',
}: {
  scenario: string
  optionLabel: string
  // Trigger sits on a dark (selected) card — lighten the icon to suit.
  onDark?: boolean
  className?: string
}) {
  const tipId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [pinned, setPinned] = useState(false) // tap / click keeps it open
  const open = hovered || focused || pinned

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setPinned(false)
        setHovered(false)
        setFocused(false)
        triggerRef.current?.blur()
      }
    }
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || cardRef.current?.contains(t)) return
      setPinned(false)
      setHovered(false)
    }
    function onScroll() {
      setPinned(false)
      setHovered(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Example: ${optionLabel}`}
        aria-describedby={open ? tipId : undefined}
        aria-expanded={open}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onClick={(e) => {
          // Never let the click reach (or select) the option card.
          e.stopPropagation()
          setPinned((v) => !v)
        }}
        className={[
          'inline-flex h-5 w-5 items-center justify-center rounded-full transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1',
          onDark ? 'text-on-ink/70 hover:text-on-ink' : 'text-ink-mute hover:text-ink',
          className,
        ].join(' ')}
      >
        <Info size={14} aria-hidden="true" />
      </button>
      {open && triggerRef.current && (
        <TooltipCard id={tipId} anchor={triggerRef.current} cardRef={cardRef}>
          {scenario}
        </TooltipCard>
      )}
    </>
  )
}

// Portaled popover card, positioned from the trigger's bounding rect and
// clamped to the viewport. Prefers below the trigger, flips above when there
// isn't room beneath. Same portal approach as ResolvePopover's PopoverCard.
function TooltipCard({
  id,
  anchor,
  cardRef,
  children,
}: {
  id: string
  anchor: HTMLElement
  cardRef: React.RefObject<HTMLDivElement | null>
  children: ReactNode
}) {
  const rect = anchor.getBoundingClientRect()
  const left = Math.max(
    12,
    Math.min(rect.left + rect.width / 2 - TIP_WIDTH / 2, window.innerWidth - TIP_WIDTH - 12),
  )
  const spaceBelow = window.innerHeight - rect.bottom
  const style: CSSProperties =
    spaceBelow > 180
      ? { left, top: rect.bottom + 8, width: TIP_WIDTH }
      : { left, bottom: window.innerHeight - rect.top + 8, width: TIP_WIDTH }
  return createPortal(
    <div
      ref={cardRef}
      id={id}
      role="tooltip"
      className="fixed z-50 rounded-[10px] border border-line bg-surface p-3 text-xs leading-snug text-ink-soft shadow-md"
      style={style}
    >
      {children}
    </div>,
    document.body,
  )
}

type Option<V extends string> = { value: V; label: string; sub?: string; scenario: string }

function QuestionBlock<V extends string>({
  legend,
  name,
  options,
  selected,
  onSelect,
  disabled,
  note,
  footnote,
  cols = 2,
}: {
  legend: string
  name: string
  options: ReadonlyArray<Option<V>>
  selected: V | null
  onSelect: (v: V) => void
  disabled?: boolean
  note?: ReactNode
  footnote?: ReactNode
  // 2 = side-by-side binary choices (default); 1 = full-width stacked
  // cards, used for the three-way Q1 where the descriptions are longer.
  cols?: 1 | 2
}) {
  return (
    <div>
      <p className="text-sm font-semibold text-ink">{legend}</p>
      {note && <div className="mt-1 text-xs text-ink-mute">{note}</div>}
      {/* Selection-disabling lives on each <input>, NOT on the <fieldset>, so
          the per-option info trigger stays interactive in the read-only edit
          view (a fieldset[disabled] would disable the info buttons too). */}
      <fieldset className={['mt-3 grid gap-3', cols === 2 ? 'sm:grid-cols-2' : ''].join(' ')}>
        <legend className="sr-only">{legend}</legend>
        {options.map((opt) => {
          const isSelected = selected === opt.value
          return (
            <div key={opt.value} className="relative h-full">
              <label
                className={[
                  'block h-full rounded border px-4 py-3 pr-10 transition-colors',
                  'focus-within:ring-2 focus-within:ring-brand focus-within:ring-offset-1',
                  disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                  isSelected
                    ? 'border-ink bg-ink text-on-ink'
                    : 'border-line bg-surface text-ink-soft hover:border-ink/40',
                ].join(' ')}
              >
                <input
                  type="radio"
                  name={name}
                  value={opt.value}
                  checked={isSelected}
                  disabled={disabled}
                  onChange={() => onSelect(opt.value)}
                  className="sr-only"
                />
                <div className="text-sm font-semibold">{opt.label}</div>
                {opt.sub && (
                  <div className={['mt-1 text-xs', isSelected ? 'text-on-ink/80' : 'text-ink-mute'].join(' ')}>
                    {opt.sub}
                  </div>
                )}
              </label>
              {/* Sibling of the label, so a click here never selects the option. */}
              <InfoTooltip
                scenario={opt.scenario}
                optionLabel={opt.label}
                onDark={isSelected}
                className="absolute right-2.5 top-2.5"
              />
            </div>
          )
        })}
      </fieldset>
      {footnote && <div className="mt-2 text-xs text-ink-mute">{footnote}</div>}
    </div>
  )
}

function AnsweredRow({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string
  value: string
  onChange: () => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded border border-line bg-canvas px-4 py-2.5">
      <div className="min-w-0">
        <span className="text-xs text-ink-mute">{label}</span>
        <span className="ml-2 text-sm font-medium text-ink">{value}</span>
      </div>
      {!disabled && (
        <button
          type="button"
          onClick={onChange}
          className="shrink-0 text-xs font-medium text-ink-soft underline underline-offset-4 hover:text-ink"
        >
          Change
        </button>
      )}
    </div>
  )
}

// ── The wizard ────────────────────────────────────────────────────────────────

export function ProofShapeWizard({
  answers,
  onChange,
  materialChosen,
  materialSupportsPersonalisation,
  disabled = false,
}: {
  answers: WizardAnswers
  onChange: (next: WizardAnswers) => void
  // Whether a material has been chosen in the Specification section
  // below. The personalisation question reveals once it is set.
  materialChosen: boolean
  // The chosen material's supports_personalisation capability. When
  // false, the personalisation question is never shown.
  materialSupportsPersonalisation: boolean
  // Live per-card rate / minimum-charge helper. Kept in the prop type so
  // callers (NewVersionPage) can still pass it, but no longer rendered.
  personalisationHelper?: string
  // On the edit page the shape is locked at creation, so the wizard
  // renders read-only (collapsed rows, no Change controls).
  disabled?: boolean
}) {
  const summaryId = useId()
  const shape = resolveShape(answers, { materialChosen, materialSupportsPersonalisation })
  const label = resolvedShapeLabel(shape)

  // Patch helper. Each setter pairs its patch with a "clear everything
  // downstream" object so a revisit never leaves stale state below it.
  function set(patch: Partial<WizardAnswers>) {
    onChange({ ...answers, ...patch })
  }

  // Clearing helpers, ordered by the question pipeline.
  const clearAfterFamily = { layouts: null, sameMaterial: null, multiMaterialChoice: null, personalised: null, selectionMaterial: null } as const
  const clearAfterLayouts = { sameMaterial: null, multiMaterialChoice: null, personalised: null } as const
  const clearAfterSameMaterial = { multiMaterialChoice: null, personalised: null } as const

  const isSet = answers.family === 'set'
  const isSelection = answers.family === 'selection'

  const isSeveral = answers.layouts === 'several'
  const splitChosen = isSeveral && answers.sameMaterial === 'no' && answers.multiMaterialChoice === 'split'
  const keptTogether = isSeveral && answers.sameMaterial === 'no' && answers.multiMaterialChoice === 'keep'
  // Does the Set branch reach the personalisation question (i.e. the
  // single/collection structure is settled)?
  const reachesPersonalisation =
    isSet &&
    (answers.layouts === 'one' || (isSeveral && (answers.sameMaterial === 'yes' || keptTogether)))

  // Human-readable value for the collapsed Q1 row.
  const familyValue =
    answers.family === 'recipients'
      ? 'A batch of cards for one or more people'
      : answers.family === 'set'
        ? 'Cards with no personal contact details'
        : 'Alternatives to choose from'

  return (
    <section className="rounded-2xl bg-surface p-8 shadow-sm ring-1 ring-line">
      <div className="mb-5">
        <h3 className="text-base font-semibold text-ink">Proof type</h3>
        <p className="mt-0.5 text-xs text-ink-mute">
          A question or two sets up the right shape for this proof.
        </p>
      </div>

      {/* Screen-reader running summary of the current resolution. */}
      <p id={summaryId} className="sr-only" aria-live="polite">
        {label ? `Resolved proof type: ${label}.` : 'Proof type not yet resolved.'}
      </p>

      <div className="space-y-3">
        {/* ── Q1 — always asked. Three-way: the structural family. ───── */}
        {answers.family == null ? (
          <QuestionBlock
            legend="Which best describes this proof?"
            name="wizard-family"
            cols={1}
            selected={answers.family}
            disabled={disabled}
            onSelect={(v: 'recipients' | 'set' | 'selection') => set({ family: v, ...clearAfterFamily })}
            options={[
              {
                value: 'recipients',
                label: 'A batch of cards for one or more people',
                sub: 'Each named person has their own cards showing their own contact details. The customer wants them all.',
                scenario: SCENARIOS.q1Recipients,
              },
              {
                value: 'set',
                label: 'Cards with no personal contact details',
                sub: "No card shows an individual's contact details. The customer wants every design you show, whether one design or several.",
                scenario: SCENARIOS.q1Set,
              },
              {
                value: 'selection',
                label: 'Alternatives to choose from',
                sub: 'You show alternative designs and the customer picks the one they want. The rest are set aside.',
                scenario: SCENARIOS.q1Selection,
              },
            ]}
          />
        ) : (
          <AnsweredRow
            label="This proof is"
            value={familyValue}
            disabled={disabled}
            onChange={() => set({ family: null, ...clearAfterFamily })}
          />
        )}

        {/* ── Set branch ────────────────────────────────────────────── */}
        {isSet && (
          <>
            {/* Q2 — how many layouts? */}
            {answers.layouts == null ? (
              <QuestionBlock
                legend="How many layouts are in this set?"
                name="wizard-layouts"
                selected={answers.layouts}
                disabled={disabled}
                onSelect={(v: 'one' | 'several') => set({ layouts: v, ...clearAfterLayouts })}
                note="A layout is one design. The same design shown in different finishes is still one layout."
                options={[
                  { value: 'one', label: 'One layout', sub: 'A single design.', scenario: SCENARIOS.q2One },
                  {
                    value: 'several',
                    label: 'Several layouts',
                    sub: 'Two or more different designs, all kept together. Each layout after the first adds a tooling charge.',
                    scenario: SCENARIOS.q2Several,
                  },
                ]}
              />
            ) : (
              <AnsweredRow
                label="Layouts"
                value={answers.layouts === 'one' ? 'One layout' : 'Several layouts'}
                disabled={disabled}
                onChange={() => set({ layouts: null, ...clearAfterLayouts })}
              />
            )}

            {/* Q3 — same material? (only when several layouts) */}
            {isSeveral && (
              answers.sameMaterial == null ? (
                <QuestionBlock
                  legend="Are all the layouts on the same material?"
                  name="wizard-same-material"
                  selected={answers.sameMaterial}
                  disabled={disabled}
                  onSelect={(v: 'yes' | 'no') => set({ sameMaterial: v, ...clearAfterSameMaterial })}
                  options={[
                    { value: 'yes', label: 'Yes, one material', scenario: SCENARIOS.q3Same },
                    {
                      value: 'no',
                      label: 'No, different materials',
                      sub: 'Each material is normally quoted and proofed as its own project, so it prices correctly.',
                      scenario: SCENARIOS.q3Different,
                    },
                  ]}
                />
              ) : (
                <AnsweredRow
                  label="Material"
                  value={answers.sameMaterial === 'yes' ? 'Yes, one material' : 'No, different materials'}
                  disabled={disabled}
                  onChange={() => set({ sameMaterial: null, ...clearAfterSameMaterial })}
                />
              )
            )}

            {/* Q3 follow-up — split vs keep together */}
            {isSeveral && answers.sameMaterial === 'no' && (
              answers.multiMaterialChoice == null ? (
                <div className="rounded border border-line bg-canvas px-4 py-3">
                  <p className="text-sm text-ink-soft">
                    A set uses one material. Different materials are normally split into separate
                    projects so each one prices correctly.
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <span className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => set({ multiMaterialChoice: 'split', personalised: null })}
                        className="rounded border border-ink bg-ink px-4 py-2 text-sm font-semibold text-on-ink hover:opacity-90 disabled:opacity-60"
                      >
                        Split into separate projects
                      </button>
                      <InfoTooltip scenario={SCENARIOS.guardSplit} optionLabel="Split into separate projects" />
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => set({ multiMaterialChoice: 'keep', personalised: null })}
                        className="rounded border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink-soft hover:border-ink/40 disabled:opacity-60"
                      >
                        Keep together anyway
                      </button>
                      <InfoTooltip scenario={SCENARIOS.guardKeep} optionLabel="Keep together anyway" />
                    </span>
                  </div>
                </div>
              ) : (
                <AnsweredRow
                  label="Different materials"
                  value={answers.multiMaterialChoice === 'split' ? 'Split into separate projects' : 'Keep together anyway'}
                  disabled={disabled}
                  onChange={() => set({ multiMaterialChoice: null, personalised: null })}
                />
              )
            )}

            {/* Split guard — terminal guidance, no saveable shape */}
            {splitChosen && (
              <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                Create each material as its own project from the new-project screen, so each one
                prices and proofs correctly. This proof can't continue as a single set.
              </div>
            )}

            {/* Personalisation — the single material-gated Set question.
                It reveals once a material is chosen, only if that material
                supports personalisation; otherwise it never appears and
                personalisation stays off. */}
            {reachesPersonalisation && (
              !materialChosen ? (
                <div className="rounded border border-line bg-canvas px-4 py-3 text-xs text-ink-mute">
                  Choose a material in Specification below to set personalisation.
                </div>
              ) : materialSupportsPersonalisation ? (
                answers.personalised == null ? (
                  <QuestionBlock
                    legend="Does every card carry its own unique details, such as a member name, sequential number, or unique QR code?"
                    name="wizard-personalised"
                    selected={answers.personalised}
                    disabled={disabled}
                    onSelect={(v: 'yes' | 'no') => set({ personalised: v })}
                    options={[
                      { value: 'yes', label: 'Yes, every card is unique', sub: 'Priced per card, with a minimum charge, on top of the base price.', scenario: SCENARIOS.q5Unique },
                      { value: 'no', label: 'No, every card is identical', scenario: SCENARIOS.q5Identical },
                    ]}
                  />
                ) : (
                  <AnsweredRow
                    label="Personalisation"
                    value={answers.personalised === 'yes' ? 'Yes, every card is unique' : 'No, every card is identical'}
                    disabled={disabled}
                    onChange={() => set({ personalised: null })}
                  />
                )
              ) : null
            )}

            {/* The per-layout title + image editor for a Set
                (collection) lives in the version form below (it owns
                the image uploads), not in the wizard — the wizard
                only resolves the shape. */}
          </>
        )}

        {/* ── Selection branch ──────────────────────────────────────── */}
        {isSelection && (
          answers.selectionMaterial == null ? (
            <QuestionBlock
              legend="Are the alternatives all on the same material?"
              name="wizard-selection-material"
              selected={answers.selectionMaterial}
              disabled={disabled}
              onSelect={(v: 'same' | 'different') => set({ selectionMaterial: v })}
              options={[
                { value: 'same', label: 'Same material', sub: 'Every alternative is the same material. Only the design differs.', scenario: SCENARIOS.qsSame },
                { value: 'different', label: 'Different materials', sub: 'Each alternative is on a different material, so each is priced on its own.', scenario: SCENARIOS.qsDifferent },
              ]}
            />
          ) : (
            <AnsweredRow
              label="Alternatives"
              value={answers.selectionMaterial === 'same' ? 'Same material' : 'Different materials'}
              disabled={disabled}
              onChange={() => set({ selectionMaterial: null })}
            />
          )
        )}
      </div>

      {/* Running resolution banner */}
      {label && (
        <div className="mt-5 flex items-center gap-2 rounded border border-line bg-canvas px-4 py-3">
          <span className="text-xs font-medium text-ink-mute">Resolved as</span>
          <span className="text-sm font-semibold text-ink">{label}</span>
        </div>
      )}
    </section>
  )
}
